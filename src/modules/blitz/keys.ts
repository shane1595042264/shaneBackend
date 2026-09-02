import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// 32-byte master key, hex-encoded, from the environment. Wraps every user's
// SuperSync encryption key at rest. Rotating it means re-wrapping all rows.
function masterKey(): Buffer {
  const hex = process.env.BLITZ_KEY_MASTER;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("BLITZ_KEY_MASTER must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

/** A fresh high-entropy SuperSync encryption password (43 chars, base64url). */
export function generateEncryptKey(): string {
  return randomBytes(32).toString("base64url");
}

/** AES-256-GCM: base64(iv[12] || tag[16] || ciphertext). */
export function wrapKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function unwrapKey(wrapped: string): string {
  const buf = Buffer.from(wrapped, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("wrapped key too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
