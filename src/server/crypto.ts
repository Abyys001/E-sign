import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** 256-bit URL-safe random token. Only its keyed hash is ever stored. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string) => hmac(env().SIGNING_TOKEN_SECRET, token);

export function newOtp(): { code: string; hash: (id: string) => string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code, hash: (id) => hashOtp(code, id) };
}
export const hashOtp = (code: string, sessionId: string) => hmac(env().OTP_SECRET, `${sessionId}:${code}`);

/** AES-256-GCM for secrets stored at rest (SMTP/SMS creds, webhook secrets). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(env().SETTINGS_ENCRYPTION_KEY, "hex"), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !enc) throw new Error("malformed ciphertext");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(env().SETTINGS_ENCRYPTION_KEY, "hex"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");

/**
 * Signing links: token = HMAC(SIGNING_TOKEN_SECRET, "sr:<requestId>:<nonce>"). 256-bit, unpredictable without the secret.
 * The DB stores only sha256-keyed hash + nonce, so a database leak alone yields no working links, yet the server can
 * rebuild the URL inside the email job without ever persisting the plaintext token.
 */
export function deriveSigningToken(requestId: string, nonce: string): string {
  return Buffer.from(hmac(env().SIGNING_TOKEN_SECRET, `sr:${requestId}:${nonce}`), "hex").toString("base64url");
}
/** Intake-form links use the same derive-don't-store scheme with a distinct domain prefix so a signing token can never open an intake form. */
export function deriveIntakeToken(invitationId: string, nonce: string): string {
  return Buffer.from(hmac(env().SIGNING_TOKEN_SECRET, `ik:${invitationId}:${nonce}`), "hex").toString("base64url");
}
export function newIntakeSecrets(invitationId: string): { nonce: string; token: string; tokenHash: string } {
  const nonce = randomBytes(16).toString("base64url");
  const token = deriveIntakeToken(invitationId, nonce);
  return { nonce, token, tokenHash: hashToken(token) };
}
export function newSigningRequestSecrets(requestId: string): { nonce: string; token: string; tokenHash: string } {
  const nonce = randomBytes(16).toString("base64url");
  const token = deriveSigningToken(requestId, nonce);
  return { nonce, token, tokenHash: hashToken(token) };
}
