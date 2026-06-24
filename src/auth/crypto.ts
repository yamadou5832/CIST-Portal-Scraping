import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltRaw, keyRaw] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltRaw || !keyRaw) {
    return false;
  }

  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(keyRaw, "base64url");
  const actual = (await scryptAsync(password, salt, expected.byteLength)) as Buffer;
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [version, ivRaw, tagRaw, ciphertextRaw] = encoded.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error("Invalid encrypted secret");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
