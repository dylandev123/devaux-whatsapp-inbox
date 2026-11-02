// Server-only: encryption of the stored Google refresh token. AES-256-GCM with a random 96-bit IV per value; the business
// slug is bound in as additional authenticated data, so a ciphertext copied onto another business's row will not decrypt.
// The key lives only in the GOOGLE_TOKEN_ENCRYPTION_KEY environment variable (32 bytes, base64 or 64 hex characters).

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";

const VERSION = "v1";

export function encryptionKey(raw: string | undefined = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY): Buffer | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

export function encryptSecret(plain: string, aad: string, key: Buffer | null = encryptionKey()): string {
  if (!key) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is missing or not 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, aad: string, key: Buffer | null = encryptionKey()): string {
  if (!key) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is missing or not 32 bytes");
  const [version, iv, tag, body] = stored.split(".");
  if (version !== VERSION || !iv || !tag || !body) throw new Error("Unrecognised stored credential format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

// ── Signed OAuth state ───────────────────────────────────────────────────────
// The state carries who started the flow (admin user + business) and a nonce that must match an httpOnly cookie set by the
// same browser, so a link to the callback cannot be replayed by someone else or against another business.
export interface OAuthState {
  b: string;
  u: string;
  n: string;
  exp: number;
}

const sign = (payload: string, key: Buffer): string => createHmac("sha256", key).update(`oauth-state:${payload}`).digest("base64url");

export function signState(state: OAuthState, key: Buffer | null = encryptionKey()): string {
  if (!key) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is missing or not 32 bytes");
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

export function verifyState(value: string | null | undefined, now: number = Date.now(), key: Buffer | null = encryptionKey()): OAuthState | null {
  if (!value || !key) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.b !== "string" || typeof s.u !== "string" || typeof s.n !== "string" || typeof s.exp !== "number" || s.exp < now) return null;
    return s;
  } catch {
    return null;
  }
}
