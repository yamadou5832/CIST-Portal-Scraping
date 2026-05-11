import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  portalUrl: string;
  username: string;
  password: string;
  storageStatePath: string;
  headless: boolean;
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

export function loadConfig(): AppConfig {
  const portalUrl = (process.env.CIST_PORTAL_URL ?? "https://portal.mc.chitose.ac.jp").replace(/\/+$/, "");
  const storageStatePath = process.env.CIST_STORAGE_STATE_PATH ?? "./.auth/storage-state.json";

  return {
    port: parsePort(process.env.PORT ?? "3000"),
    portalUrl,
    username: requireEnv("CIST_USERNAME"),
    password: requireEnv("CIST_PASSWORD"),
    storageStatePath: path.resolve(process.cwd(), storageStatePath),
    headless: parseBoolean(process.env.CIST_HEADLESS ?? "true"),
  };
}
