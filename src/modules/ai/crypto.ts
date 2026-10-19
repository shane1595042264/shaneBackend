// SHAN-596: readers' AI keys are stored sealed, AES-256-GCM.
//
// The data key is derived from JWT_SECRET with HKDF under its own label, so no
// new secret has to be provisioned on Railway and the two uses can never be
// confused for each other (a sealed AI key is not a JWT signature and vice
// versa). The price of that choice: rotating JWT_SECRET makes every stored AI
// key unreadable. Nothing breaks loudly; openKey() throws, the explain route
// reports the key as needing to be added again, and readers re-paste it.
//
// Layout: base64( iv[12] | tag[16] | ciphertext ).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION_LABEL = "shanejli/user-ai-keys/v1";

function dataKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set; cannot seal AI keys");
  return Buffer.from(hkdfSync("sha256", secret, "shanejli", VERSION_LABEL, 32));
}

export function sealKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function openKey(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", dataKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
