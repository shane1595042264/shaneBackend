import { describe, it, expect, beforeEach } from "vitest";
import { jwtVerify } from "jose";
import { signSupersyncToken } from "@/modules/blitz/token";

const SECRET = "supersync-test-secret-that-is-long-enough-32";

beforeEach(() => {
  process.env.SUPERSYNC_JWT_SECRET = SECRET;
});

describe("signSupersyncToken", () => {
  it("produces an HS256 JWT the SuperSync server would accept", async () => {
    const { token, expiresAt } = await signSupersyncToken({ userId: 7, email: "a@b.c", tokenVersion: 2 });
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.userId).toBe(7);
    expect(payload.email).toBe("a@b.c");
    expect(payload.tokenVersion).toBe(2);
    expect(typeof payload.iat).toBe("number");
    const days = ((payload.exp as number) - (payload.iat as number)) / 86400;
    expect(Math.round(days)).toBe(365);
    // expiresAt is the exp claim, to the second.
    expect(Math.floor(new Date(expiresAt).getTime() / 1000)).toBe(payload.exp);
  });

  it("refuses a short secret", async () => {
    process.env.SUPERSYNC_JWT_SECRET = "tiny";
    await expect(signSupersyncToken({ userId: 1, email: "x", tokenVersion: 0 })).rejects.toThrow(
      /SUPERSYNC_JWT_SECRET/,
    );
  });
});
