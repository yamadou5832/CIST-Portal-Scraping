import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  portalUrl: string;
  storageStatePath: string;
  headless: boolean;
  corsOrigins: string[];
  auth: AuthConfig;
  push: PushConfig;
}

export interface AuthConfig {
  sqlitePath: string;
  jwtAccessSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  encryptionKey: Buffer;
  bootstrapInviteCode?: string;
  webauthn: WebAuthnConfig;
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
}

export interface PushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  sqlitePath: string;
  pollIntervalMs: number;
  notificationUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function parseBoolean(value: string): boolean {
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function parsePositiveIntegerEnv(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const portalUrl = (process.env.CIST_PORTAL_URL ?? "https://portal.mc.chitose.ac.jp").replace(/\/+$/, "");
  const storageStatePath = process.env.CIST_STORAGE_STATE_PATH ?? "./.auth/storage-state.json";
  const pushSqlitePath = process.env.PUSH_SQLITE_PATH ?? "./.data/push.sqlite";
  const authSqlitePath = process.env.AUTH_SQLITE_PATH ?? "./.data/auth.sqlite";
  const webauthnOrigin = requireEnv("WEBAUTHN_ORIGIN");
  const encryptionKey = Buffer.from(requireEnv("AUTH_ENCRYPTION_KEY"), "base64");
  if (encryptionKey.byteLength !== 32) {
    throw new Error("AUTH_ENCRYPTION_KEY must be a base64-encoded 32 byte key");
  }

  return {
    port: parsePort(process.env.PORT ?? "3000"),
    portalUrl,
    storageStatePath: path.resolve(process.cwd(), storageStatePath),
    headless: parseBoolean(process.env.CIST_HEADLESS ?? "true"),
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS ?? webauthnOrigin),
    auth: {
      sqlitePath: path.resolve(process.cwd(), authSqlitePath),
      jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),
      accessTokenTtlSeconds: parsePositiveIntegerEnv(
        "ACCESS_TOKEN_TTL_SECONDS",
        process.env.ACCESS_TOKEN_TTL_SECONDS ?? "900",
      ),
      refreshTokenTtlDays: parsePositiveIntegerEnv("REFRESH_TOKEN_TTL_DAYS", process.env.REFRESH_TOKEN_TTL_DAYS ?? "30"),
      encryptionKey,
      bootstrapInviteCode: process.env.AUTH_BOOTSTRAP_INVITE_CODE,
      webauthn: {
        rpId: requireEnv("WEBAUTHN_RP_ID"),
        rpName: requireEnv("WEBAUTHN_RP_NAME"),
        origin: webauthnOrigin,
      },
    },
    push: {
      vapidPublicKey: requireEnv("PUSH_VAPID_PUBLIC_KEY"),
      vapidPrivateKey: requireEnv("PUSH_VAPID_PRIVATE_KEY"),
      vapidSubject: requireEnv("PUSH_VAPID_SUBJECT"),
      sqlitePath: path.resolve(process.cwd(), pushSqlitePath),
      pollIntervalMs: parsePositiveIntegerEnv("PUSH_POLL_INTERVAL_MS", process.env.PUSH_POLL_INTERVAL_MS ?? "300000"),
      notificationUrl: process.env.PUSH_NOTIFICATION_URL ?? "/#memos",
    },
  };
}
