import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  PublicInvite,
  PublicUser,
  StoredInvite,
  StoredPasskeyCredential,
  StoredRefreshToken,
  StoredUser,
  StoredWebAuthnChallenge,
} from "./types.js";

interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  cist_user_id: string;
  encrypted_cist_password: string;
  is_admin: number;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  created_at: string;
}

interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface WebAuthnChallengeRow {
  id: string;
  user_id: string | null;
  challenge: string;
  type: "registration" | "authentication";
  expires_at: string;
  created_at: string;
}

interface InviteRow {
  id: string;
  code_hash: string;
  created_by_user_id: string | null;
  expires_at: string | null;
  used_by_user_id: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateUserInput {
  username: string;
  email: string;
  passwordHash: string;
  cistUserId: string;
  encryptedCistPassword: string;
  isAdmin: boolean;
}

export class AuthStore {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        cist_user_id TEXT NOT NULL,
        encrypted_cist_password TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        email_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        replaced_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        challenge TEXT NOT NULL,
        type TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT,
        used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);
      CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_challenge ON webauthn_challenges(challenge);
    `);
    this.migrateCistEmailColumn();
  }

  close(): void {
    this.db.close();
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
    return row.count;
  }

  countUsableInvites(): number {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM invites
        WHERE used_at IS NULL
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `,
      )
      .get(now) as { count: number };
    return row.count;
  }

  createUser(input: CreateUserInput): StoredUser {
    const now = new Date().toISOString();
    const id = `usr_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO users (
          id, username, email, password_hash, cist_user_id, encrypted_cist_password,
          is_admin, email_verified_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `,
      )
      .run(
        id,
        input.username,
        input.email,
        input.passwordHash,
        input.cistUserId,
        input.encryptedCistPassword,
        input.isAdmin ? 1 : 0,
        now,
        now,
      );

    return this.getUserById(id) as StoredUser;
  }

  getUserById(id: string): StoredUser | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? this.toStoredUser(row as unknown as UserRow) : null;
  }

  getUserByIdentifier(identifier: string): StoredUser | null {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? OR email = ?").get(identifier, identifier);
    return row ? this.toStoredUser(row as unknown as UserRow) : null;
  }

  createRefreshToken(userId: string, tokenHash: string, expiresAt: string): StoredRefreshToken {
    const now = new Date().toISOString();
    const id = `rt_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?)
      `,
      )
      .run(id, userId, tokenHash, expiresAt, now);
    return this.getRefreshTokenByHash(tokenHash) as StoredRefreshToken;
  }

  getRefreshTokenByHash(tokenHash: string): StoredRefreshToken | null {
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash);
    return row ? this.toRefreshToken(row as unknown as RefreshTokenRow) : null;
  }

  revokeRefreshToken(id: string, replacedBy?: string): void {
    this.db
      .prepare("UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), replacedBy ?? null, id);
  }

  createInvite(codeHash: string, createdByUserId: string, expiresAt: string | null): PublicInvite {
    const now = new Date().toISOString();
    const id = `inv_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO invites (id, code_hash, created_by_user_id, expires_at, used_by_user_id, used_at, revoked_at, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
      `,
      )
      .run(id, codeHash, createdByUserId, expiresAt, now);
    return this.toPublicInvite(this.getInviteById(id) as StoredInvite);
  }

  getInviteById(id: string): StoredInvite | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id);
    return row ? this.toInvite(row as unknown as InviteRow) : null;
  }

  getInviteByCodeHash(codeHash: string): StoredInvite | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(codeHash);
    return row ? this.toInvite(row as unknown as InviteRow) : null;
  }

  markInviteUsed(id: string, userId: string): void {
    this.db.prepare("UPDATE invites SET used_by_user_id = ?, used_at = ? WHERE id = ?").run(userId, new Date().toISOString(), id);
  }

  revokeInvite(id: string): boolean {
    const result = this.db
      .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  listInvites(): PublicInvite[] {
    const rows = this.db.prepare("SELECT * FROM invites ORDER BY created_at DESC").all();
    return rows.map((row) => this.toPublicInvite(this.toInvite(row as unknown as InviteRow)));
  }

  saveChallenge(userId: string | null, challenge: string, type: StoredWebAuthnChallenge["type"], expiresAt: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(`wch_${randomUUID()}`, userId, challenge, type, expiresAt, now);
  }

  consumeChallenge(challenge: string, type: StoredWebAuthnChallenge["type"], userId?: string): StoredWebAuthnChallenge | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `
        SELECT * FROM webauthn_challenges
        WHERE challenge = ?
          AND type = ?
          AND expires_at > ?
          AND (? IS NULL OR user_id = ?)
        ORDER BY created_at DESC
        LIMIT 1
      `,
      )
      .get(challenge, type, now, userId ?? null, userId ?? null);
    if (!row) {
      return null;
    }

    const challengeRow = this.toChallenge(row as unknown as WebAuthnChallengeRow);
    this.db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").run(challengeRow.id);
    return challengeRow;
  }

  createPasskeyCredential(input: {
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string | null;
  }): StoredPasskeyCredential {
    const id = `pk_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, transports, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      )
      .run(id, input.userId, input.credentialId, input.publicKey, input.counter, input.transports, now);
    return this.getPasskeyByCredentialId(input.credentialId) as StoredPasskeyCredential;
  }

  getPasskeysForUser(userId: string): StoredPasskeyCredential[] {
    const rows = this.db.prepare("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC").all(userId);
    return rows.map((row) => this.toPasskey(row as unknown as PasskeyCredentialRow));
  }

  getPasskeyByCredentialId(credentialId: string): StoredPasskeyCredential | null {
    const row = this.db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ?").get(credentialId);
    return row ? this.toPasskey(row as unknown as PasskeyCredentialRow) : null;
  }

  updatePasskeyCounter(credentialId: string, counter: number): void {
    this.db
      .prepare("UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?")
      .run(counter, new Date().toISOString(), credentialId);
  }

  deletePasskeyForUser(userId: string, credentialId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM passkey_credentials WHERE user_id = ? AND credential_id = ?")
      .run(userId, credentialId);
    return result.changes > 0;
  }

  toPublicUser(user: StoredUser): PublicUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private toStoredUser(row: UserRow): StoredUser {
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      passwordHash: row.password_hash,
      cistUserId: row.cist_user_id,
      encryptedCistPassword: row.encrypted_cist_password,
      isAdmin: row.is_admin === 1,
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private migrateCistEmailColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    const hasOldColumn = columns.some((column) => column.name === "cist_email");
    const hasNewColumn = columns.some((column) => column.name === "cist_user_id");
    if (hasOldColumn && !hasNewColumn) {
      this.db.exec("ALTER TABLE users RENAME COLUMN cist_email TO cist_user_id");
    }
  }

  private toRefreshToken(row: RefreshTokenRow): StoredRefreshToken {
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      replacedBy: row.replaced_by,
      createdAt: row.created_at,
    };
  }

  private toPasskey(row: PasskeyCredentialRow): StoredPasskeyCredential {
    return {
      id: row.id,
      userId: row.user_id,
      credentialId: row.credential_id,
      publicKey: row.public_key,
      counter: row.counter,
      transports: row.transports,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  private toChallenge(row: WebAuthnChallengeRow): StoredWebAuthnChallenge {
    return {
      id: row.id,
      userId: row.user_id,
      challenge: row.challenge,
      type: row.type,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private toInvite(row: InviteRow): StoredInvite {
    return {
      id: row.id,
      codeHash: row.code_hash,
      createdByUserId: row.created_by_user_id,
      expiresAt: row.expires_at,
      usedByUserId: row.used_by_user_id,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    };
  }

  private toPublicInvite(invite: StoredInvite): PublicInvite {
    return {
      id: invite.id,
      createdByUserId: invite.createdByUserId,
      expiresAt: invite.expiresAt,
      usedByUserId: invite.usedByUserId,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      createdAt: invite.createdAt,
    };
  }
}
