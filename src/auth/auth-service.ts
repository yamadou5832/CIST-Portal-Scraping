import { SignJWT, jwtVerify } from "jose";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";

import type { AuthConfig } from "../config.js";
import { decryptSecret, encryptSecret, hashPassword, hashToken, randomToken, verifyPassword } from "./crypto.js";
import type { AuthStore } from "./auth-store.js";
import type { PortalUserCredentials, PublicInvite, PublicUser, StoredPasskeyCredential, StoredUser } from "./types.js";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface AuthResponse extends TokenPair {
  user: PublicUser;
}

interface AccessTokenPayload {
  sub: string;
  username: string;
  email: string;
  isAdmin: boolean;
}

export class AuthService {
  private readonly jwtSecret: Uint8Array;

  constructor(
    private readonly config: AuthConfig,
    private readonly store: AuthStore,
  ) {
    this.jwtSecret = new TextEncoder().encode(config.jwtAccessSecret);
  }

  async register(input: {
    inviteCode: string;
    username: string;
    email: string;
    password: string;
    cistAccount: { userId: string; password: string };
  }): Promise<AuthResponse> {
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const password = input.password;
    const cistUserId = input.cistAccount.userId.trim();
    const cistPassword = input.cistAccount.password;
    const inviteCode = input.inviteCode.trim();

    if (!inviteCode || !username || !email || password.length < 8 || !cistUserId || !cistPassword) {
      throw new AuthError("inviteCode, username, email, password, and cistAccount are required");
    }

    const userCount = this.store.countUsers();
    const bootstrap = userCount === 0 && this.store.countUsableInvites() === 0;
    const invite = bootstrap ? null : this.getUsableInvite(inviteCode);

    if (bootstrap && this.config.bootstrapInviteCode && inviteCode !== this.config.bootstrapInviteCode) {
      throw new AuthError("Invalid invite code", 401);
    }
    if (bootstrap && !this.config.bootstrapInviteCode) {
      throw new AuthError("No bootstrap invite code is configured", 403);
    }

    let user: StoredUser;
    try {
      user = this.store.createUser({
        username,
        email,
        passwordHash: await hashPassword(password),
        cistUserId,
        encryptedCistPassword: encryptSecret(cistPassword, this.config.encryptionKey),
        isAdmin: userCount === 0,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new AuthError("Username or email is already registered", 409);
      }
      throw error;
    }

    if (invite) {
      this.store.markInviteUsed(invite.id, user.id);
    }

    return {
      user: this.store.toPublicUser(user),
      ...(await this.issueTokenPair(user)),
    };
  }

  async login(identifier: string, password: string): Promise<AuthResponse> {
    const user = this.store.getUserByIdentifier(normalizeIdentifier(identifier));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new AuthError("Invalid credentials", 401);
    }

    return {
      user: this.store.toPublicUser(user),
      ...(await this.issueTokenPair(user)),
    };
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const tokenHash = hashToken(refreshToken);
    const stored = this.store.getRefreshTokenByHash(tokenHash);
    if (!stored || stored.revokedAt || new Date(stored.expiresAt).getTime() <= Date.now()) {
      throw new AuthError("Invalid refresh token", 401);
    }

    const user = this.store.getUserById(stored.userId);
    if (!user) {
      throw new AuthError("Invalid refresh token", 401);
    }

    const nextRefreshToken = randomToken();
    const nextExpiresAt = this.refreshExpiresAt();
    const nextStored = this.store.createRefreshToken(user.id, hashToken(nextRefreshToken), nextExpiresAt);
    this.store.revokeRefreshToken(stored.id, nextStored.id);

    return {
      user: this.store.toPublicUser(user),
      accessToken: await this.createAccessToken(user),
      refreshToken: nextRefreshToken,
    };
  }

  logout(refreshToken: string): void {
    const stored = this.store.getRefreshTokenByHash(hashToken(refreshToken));
    if (stored) {
      this.store.revokeRefreshToken(stored.id);
    }
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await jwtVerify<AccessTokenPayload>(token, this.jwtSecret, { algorithms: ["HS256"] });
      if (!payload.sub || !payload.username || !payload.email || typeof payload.isAdmin !== "boolean") {
        throw new Error("Invalid token payload");
      }
      return payload;
    } catch {
      throw new AuthError("Invalid access token", 401);
    }
  }

  getPublicUser(userId: string): PublicUser {
    const user = this.store.getUserById(userId);
    if (!user) {
      throw new AuthError("User not found", 404);
    }
    return this.store.toPublicUser(user);
  }

  getPortalCredentials(userId: string): PortalUserCredentials {
    const user = this.store.getUserById(userId);
    if (!user) {
      throw new AuthError("User not found", 404);
    }
    return {
      id: user.id,
      cistUserId: user.cistUserId,
      cistPassword: decryptSecret(user.encryptedCistPassword, this.config.encryptionKey),
    };
  }

  createInvite(createdByUserId: string, expiresInDays?: number): { invite: PublicInvite; code: string } {
    const code = randomToken(24);
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null;
    return {
      invite: this.store.createInvite(hashToken(code), createdByUserId, expiresAt),
      code,
    };
  }

  listInvites(): PublicInvite[] {
    return this.store.listInvites();
  }

  revokeInvite(inviteId: string): void {
    if (!this.store.revokeInvite(inviteId)) {
      throw new AuthError("Invite not found or already inactive", 404);
    }
  }

  async generatePasskeyRegistrationOptions(userId: string): Promise<unknown> {
    const user = this.requireUser(userId);
    const existing = this.store.getPasskeysForUser(userId);
    const options = await generateRegistrationOptions({
      rpName: this.config.webauthn.rpName,
      rpID: this.config.webauthn.rpId,
      userID: Buffer.from(user.id),
      userName: user.email,
      userDisplayName: user.username,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: this.parseTransports(credential),
      })),
    });
    this.store.saveChallenge(userId, options.challenge, "registration", challengeExpiresAt());
    return options;
  }

  async verifyPasskeyRegistration(userId: string, response: RegistrationResponseJSON): Promise<{ verified: true }> {
    this.requireUser(userId);
    const challenge = response.response.clientDataJSON ? extractClientChallenge(response.response.clientDataJSON) : null;
    if (!challenge || !this.store.consumeChallenge(challenge, "registration", userId)) {
      throw new AuthError("Invalid passkey challenge", 401);
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webauthn.origin,
      expectedRPID: this.config.webauthn.rpId,
      requireUserVerification: false,
    });

    if (!verification.verified) {
      throw new AuthError("Passkey registration failed", 400);
    }

    const credential = verification.registrationInfo.credential;
    this.store.createPasskeyCredential({
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: JSON.stringify(response.response.transports ?? []),
    });

    return { verified: true };
  }

  async generatePasskeyLoginOptions(identifier?: string): Promise<unknown> {
    const user = identifier ? this.store.getUserByIdentifier(normalizeIdentifier(identifier)) : null;
    if (identifier && !user) {
      throw new AuthError("User not found", 404);
    }
    const credentials = user ? this.store.getPasskeysForUser(user.id) : [];
    const options = await generateAuthenticationOptions({
      rpID: this.config.webauthn.rpId,
      userVerification: "preferred",
      allowCredentials: user
        ? credentials.map((credential) => ({
            id: credential.credentialId,
            transports: this.parseTransports(credential),
          }))
        : undefined,
    });
    this.store.saveChallenge(user?.id ?? null, options.challenge, "authentication", challengeExpiresAt());
    return options;
  }

  async verifyPasskeyLogin(response: AuthenticationResponseJSON): Promise<AuthResponse> {
    const credential = this.store.getPasskeyByCredentialId(response.id);
    if (!credential) {
      throw new AuthError("Unknown passkey", 401);
    }

    const challenge = extractClientChallenge(response.response.clientDataJSON);
    const storedChallenge = this.store.consumeChallenge(challenge, "authentication");
    if (!storedChallenge || (storedChallenge.userId && storedChallenge.userId !== credential.userId)) {
      throw new AuthError("Invalid passkey challenge", 401);
    }

    const user = this.requireUser(credential.userId);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webauthn.origin,
      expectedRPID: this.config.webauthn.rpId,
      credential: this.toWebAuthnCredential(credential),
      requireUserVerification: false,
    });

    if (!verification.verified) {
      throw new AuthError("Passkey login failed", 401);
    }

    this.store.updatePasskeyCounter(credential.credentialId, verification.authenticationInfo.newCounter);
    return {
      user: this.store.toPublicUser(user),
      ...(await this.issueTokenPair(user)),
    };
  }

  deletePasskey(userId: string, credentialId: string): void {
    if (!this.store.deletePasskeyForUser(userId, credentialId)) {
      throw new AuthError("Passkey not found", 404);
    }
  }

  private getUsableInvite(code: string) {
    const invite = this.store.getInviteByCodeHash(hashToken(code));
    const now = Date.now();
    if (
      !invite ||
      invite.usedAt ||
      invite.revokedAt ||
      (invite.expiresAt && new Date(invite.expiresAt).getTime() <= now)
    ) {
      throw new AuthError("Invalid invite code", 401);
    }
    return invite;
  }

  private requireUser(userId: string): StoredUser {
    const user = this.store.getUserById(userId);
    if (!user) {
      throw new AuthError("User not found", 404);
    }
    return user;
  }

  private async issueTokenPair(user: StoredUser): Promise<TokenPair> {
    const refreshToken = randomToken();
    this.store.createRefreshToken(user.id, hashToken(refreshToken), this.refreshExpiresAt());
    return {
      accessToken: await this.createAccessToken(user),
      refreshToken,
    };
  }

  private async createAccessToken(user: StoredUser): Promise<string> {
    return new SignJWT({
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTokenTtlSeconds}s`)
      .sign(this.jwtSecret);
  }

  private refreshExpiresAt(): string {
    return new Date(Date.now() + this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000).toISOString();
  }

  private parseTransports(credential: StoredPasskeyCredential): AuthenticatorTransportFuture[] | undefined {
    if (!credential.transports) {
      return undefined;
    }
    try {
      const transports = JSON.parse(credential.transports) as unknown;
      return Array.isArray(transports) ? (transports.filter((value) => typeof value === "string") as AuthenticatorTransportFuture[]) : undefined;
    } catch {
      return undefined;
    }
  }

  private toWebAuthnCredential(credential: StoredPasskeyCredential): WebAuthnCredential {
    return {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, "base64url"),
      counter: credential.counter,
      transports: this.parseTransports(credential),
    };
  }
}

function normalizeUsername(value: string): string {
  return value.trim();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function challengeExpiresAt(): string {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

function extractClientChallenge(clientDataJSON: string): string {
  const decoded = Buffer.from(clientDataJSON, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded) as { challenge?: unknown };
  if (typeof parsed.challenge !== "string") {
    throw new AuthError("Invalid passkey response", 400);
  }
  return parsed.challenge;
}
