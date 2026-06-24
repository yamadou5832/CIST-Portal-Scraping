import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { PushSubscription } from "web-push";

import type { PushSubscriptionUpsertResult, StoredPushSubscription } from "./types.js";

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

export class PushSubscriptionStore {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrateLegacyPushSubscriptions();
    this.migrateLegacyNotifiedOfficeMemos();
    this.migrateLegacyPushMetadata();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, endpoint)
      );

      CREATE TABLE IF NOT EXISTS notified_office_memos (
        user_id TEXT NOT NULL,
        office_memo_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        notified_at TEXT,
        PRIMARY KEY(user_id, office_memo_id)
      );

      CREATE TABLE IF NOT EXISTS push_metadata (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
    `);
  }

  getPublicSubscriptionByEndpoint(userId: string, endpoint: string): StoredPushSubscription | null {
    const row = this.db
      .prepare(
        `
        SELECT id, user_id, endpoint, expiration_time, p256dh, auth, created_at, updated_at
        FROM push_subscriptions
        WHERE user_id = ? AND endpoint = ?
      `,
      )
      .get(userId, endpoint);

    return row ? this.toStoredSubscription(row as unknown as PushSubscriptionRow) : null;
  }

  upsertSubscription(userId: string, subscription: PushSubscription): PushSubscriptionUpsertResult {
    const now = new Date().toISOString();
    const existing = this.getPublicSubscriptionByEndpoint(userId, subscription.endpoint);

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE push_subscriptions
          SET expiration_time = ?, p256dh = ?, auth = ?, updated_at = ?
          WHERE user_id = ? AND endpoint = ?
        `,
        )
        .run(subscription.expirationTime ?? null, subscription.keys.p256dh, subscription.keys.auth, now, userId, subscription.endpoint);

      return {
        subscription: {
          ...existing,
          expirationTime: subscription.expirationTime ?? null,
          keys: subscription.keys,
          updatedAt: now,
        },
        created: false,
      };
    }

    const id = `sub_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO push_subscriptions (id, user_id, endpoint, expiration_time, p256dh, auth, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(id, userId, subscription.endpoint, subscription.expirationTime ?? null, subscription.keys.p256dh, subscription.keys.auth, now, now);

    return {
      subscription: {
        id,
        userId,
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime ?? null,
        keys: subscription.keys,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    };
  }

  deleteSubscriptionByEndpoint(userId: string, endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  }

  deleteSubscriptionByEndpointForAnyUser(endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  listSubscriptions(userId?: string): StoredPushSubscription[] {
    const rows = userId
      ? this.db
          .prepare(
            `
            SELECT id, user_id, endpoint, expiration_time, p256dh, auth, created_at, updated_at
            FROM push_subscriptions
            WHERE user_id = ?
            ORDER BY created_at ASC
          `,
          )
          .all(userId)
      : this.db
          .prepare(
            `
            SELECT id, user_id, endpoint, expiration_time, p256dh, auth, created_at, updated_at
            FROM push_subscriptions
            ORDER BY created_at ASC
          `,
          )
          .all();

    return rows.map((row) => this.toStoredSubscription(row as unknown as PushSubscriptionRow));
  }

  listSubscribedUserIds(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT user_id FROM push_subscriptions ORDER BY user_id ASC").all() as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  hasSeenOfficeMemo(userId: string, officeMemoId: string): boolean {
    const row = this.db
      .prepare("SELECT office_memo_id FROM notified_office_memos WHERE user_id = ? AND office_memo_id = ?")
      .get(userId, officeMemoId);
    return row !== undefined;
  }

  markOfficeMemoSeen(userId: string, officeMemoId: string, notified: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO notified_office_memos (user_id, office_memo_id, first_seen_at, notified_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, office_memo_id) DO UPDATE SET
          notified_at = COALESCE(notified_office_memos.notified_at, excluded.notified_at)
      `,
      )
      .run(userId, officeMemoId, now, notified ? now : null);
  }

  isOfficeMemoBootstrapComplete(userId: string): boolean {
    const row = this.db.prepare("SELECT value FROM push_metadata WHERE user_id = ? AND key = ?").get(userId, "office_memo_bootstrap_complete") as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  markOfficeMemoBootstrapComplete(userId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO push_metadata (user_id, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(userId, "office_memo_bootstrap_complete", "true", now);
  }

  close(): void {
    this.db.close();
  }

  private migrateLegacyPushSubscriptions(): void {
    if (!this.tableExists("push_subscriptions")) {
      return;
    }

    if (this.tableHasColumn("push_subscriptions", "user_id")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE push_subscriptions RENAME TO push_subscriptions_legacy;

      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, endpoint)
      );
    `);
  }

  private migrateLegacyNotifiedOfficeMemos(): void {
    if (!this.tableExists("notified_office_memos") || this.tableHasColumn("notified_office_memos", "user_id")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE notified_office_memos RENAME TO notified_office_memos_legacy;

      CREATE TABLE notified_office_memos (
        user_id TEXT NOT NULL,
        office_memo_id TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        notified_at TEXT,
        PRIMARY KEY(user_id, office_memo_id)
      );
    `);
  }

  private migrateLegacyPushMetadata(): void {
    if (!this.tableExists("push_metadata") || this.tableHasColumn("push_metadata", "user_id")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE push_metadata RENAME TO push_metadata_legacy;

      CREATE TABLE push_metadata (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
    `);
  }

  private tableExists(tableName: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
    return row !== undefined;
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    return columns.some((column) => column.name === columnName);
  }

  private toStoredSubscription(row: PushSubscriptionRow): StoredPushSubscription {
    return {
      id: row.id,
      userId: row.user_id,
      endpoint: row.endpoint,
      expirationTime: row.expiration_time,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
