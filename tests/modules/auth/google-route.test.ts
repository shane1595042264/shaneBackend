// tests/modules/auth/google-route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
// Imported from the `jose/errors` subpath on purpose: it is a different module
// specifier than "jose", so the vi.mock below does not replace it and these are
// the real error classes carrying the real `code` values the route matches on.
import {
  JOSEError,
  JWKSInvalid,
  JWKSNoMatchingKey,
  JWKSTimeout,
  JWSSignatureVerificationFailed,
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
} from "jose/errors";

const { mockJwtVerify } = vi.hoisted(() => ({ mockJwtVerify: vi.fn() }));

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    // The route passes this key set straight to the mocked jwtVerify, which
    // ignores it, so the returned resolver is never invoked.
    createRemoteJWKSet: () => async () => {
      throw new Error("unreachable: jwtVerify is mocked");
    },
    jwtVerify: mockJwtVerify,
  };
});

vi.mock("@/modules/auth/config", () => ({
  JWT_SECRET: new TextEncoder().encode("test-secret-min-32-bytes-long-xxxx"),
}));

import { authRoutes } from "@/modules/auth/routes";

const app = new Hono().route("/api/auth", authRoutes);

function login(credential = "header.payload.signature") {
  return app.request("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
}

describe("POST /api/auth/google credential bound", () => {
  it("rejects an over-long credential with 400 before verifying it", async () => {
    // 9KB string exceeds the 8192-char cap; zod rejects it at validation time,
    // so jwtVerify (and its remote JWKS fetch) is never reached.
    const res = await app.request("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "x".repeat(9000) }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing credential with 400", async () => {
    const res = await app.request("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// SHAN-537: this catch used to answer 401 "Invalid Google token" for every
// cause, including a failure to reach googleapis.com for the key set. These
// cases pin the split so the two classes of failure cannot collapse back into
// one answer.
describe("POST /api/auth/google failure classification", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockJwtVerify.mockReset();
    // Also suppresses the intentional log line from the 503 path.
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  describe("the credential itself is bad — 401, final", () => {
    const badCredentials = [
      ["a forged signature", new JWSSignatureVerificationFailed()],
      ["an expired token", new JWTExpired("exp claim timestamp check failed", {})],
      [
        "the wrong audience",
        new JWTClaimValidationFailed('unexpected "aud" claim value', {}, "aud", "check_failed"),
      ],
      ["a malformed JWT", new JWTInvalid("Invalid Compact JWS")],
      // The token names a key Google's live set does not contain. Still the
      // caller's problem: the fetch succeeded, the key just is not there.
      ["a kid absent from Google's key set", new JWKSNoMatchingKey()],
    ] as const;

    for (const [label, err] of badCredentials) {
      it(`answers 401 for ${label}`, async () => {
        mockJwtVerify.mockRejectedValue(err);
        const res = await login();
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Invalid Google token" });
      });
    }
  });

  describe("Google's key set could not be reached or read — 503, retryable", () => {
    const transportFailures = [
      ["the certs request timed out", new JWKSTimeout()],
      // What jose throws for a non-200 from the certs endpoint and for a body
      // that will not parse as JSON (dist/webapi/jwks/remote.js).
      [
        "a non-200 from the certs endpoint",
        new JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"),
      ],
      ["a key set that is not a valid JWKS", new JWKSInvalid("JSON Web Key Set malformed")],
      // jose re-throws the raw fetch rejection for DNS failure, connection
      // refused and TLS errors, so this one is not a JOSEError at all. It is
      // the regression test: an infrastructure failure must not be a 401.
      ["a DNS or TLS failure reaching googleapis.com", new TypeError("fetch failed")],
    ] as const;

    for (const [label, err] of transportFailures) {
      it(`answers 503 for ${label}, not 401`, async () => {
        mockJwtVerify.mockRejectedValue(err);
        const res = await login();
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "Could not reach Google to verify your sign-in. Please try again.",
          code: "google_keys_unavailable",
        });
      });
    }

    it("logs the real cause, which is the only record a certs outage leaves", async () => {
      mockJwtVerify.mockRejectedValue(new JWKSTimeout());
      await login();
      expect(errSpy).toHaveBeenCalledOnce();
      expect(String(errSpy.mock.calls[0][0])).toContain("ERR_JWKS_TIMEOUT");
    });

    it("does not leak the underlying error message to the client", async () => {
      mockJwtVerify.mockRejectedValue(new TypeError("connect ECONNREFUSED 142.250.1.1:443"));
      const res = await login();
      expect(await res.text()).not.toContain("ECONNREFUSED");
    });

    it("treats an unrecognized error as infrastructure rather than a bad credential", async () => {
      // The allowlist is of credential-side causes, so anything new out of
      // jwtVerify defaults to "retry, and log it" instead of telling a user a
      // freshly minted credential is invalid.
      mockJwtVerify.mockRejectedValue(new JOSEError("some future jose failure"));
      const res = await login();
      expect(res.status).toBe(503);
    });
  });
});
