import { describe, it, expect, beforeEach } from "vitest";
import { generateEncryptKey, wrapKey, unwrapKey } from "@/modules/blitz/keys";

beforeEach(() => {
  process.env.BLITZ_KEY_MASTER = "a".repeat(64);
});

describe("blitz keys", () => {
  it("generates a 43-char base64url key", () => {
    const k = generateEncryptKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateEncryptKey()).not.toBe(k);
  });

  it("wraps and unwraps round-trip with a fresh IV each time", () => {
    const k = generateEncryptKey();
    const w1 = wrapKey(k);
    const w2 = wrapKey(k);
    expect(w1).not.toBe(w2);
    expect(unwrapKey(w1)).toBe(k);
    expect(unwrapKey(w2)).toBe(k);
  });

  it("rejects tampered ciphertext", () => {
    const w = Buffer.from(wrapKey("secret"), "base64");
    w[w.length - 1] ^= 0xff;
    expect(() => unwrapKey(w.toString("base64"))).toThrow();
  });

  it("refuses a malformed master key", () => {
    process.env.BLITZ_KEY_MASTER = "short";
    expect(() => wrapKey("x")).toThrow(/BLITZ_KEY_MASTER/);
  });
});
