// tests/modules/auth/tokens.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));
vi.mock("@/db/schema", () => ({
  apiTokens: { id: "api_tokens.id", createdAt: "api_tokens.created_at", revokedAt: "api_tokens.revoked_at" },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  isNull: vi.fn((c: unknown) => ({ c, op: "null" })),
  desc: vi.fn((c: unknown) => ({ c, op: "desc" })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values })),
}));

import { mintToken, hashToken, listTokens, revokeToken, lookupActiveToken } from "@/modules/auth/tokens";

beforeEach(() => vi.clearAllMocks());

describe("mintToken", () => {
  it("returns a raw token with the pat_ prefix and base64url body", async () => {
    const insertChain = { values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "uuid-1" }])) })) };
    mockInsert.mockReturnValue(insertChain);
    const { raw, id } = await mintToken("user-1", "convey-agent", ["entries:write"]);
    expect(raw).toMatch(/^pat_[A-Za-z0-9_-]{32,}$/);
    expect(id).toBe("uuid-1");
  });
});

describe("hashToken", () => {
  it("produces a stable 64-char sha256 hex digest", () => {
    expect(hashToken("pat_test")).toHaveLength(64);
    expect(hashToken("pat_test")).toBe(hashToken("pat_test"));
    expect(hashToken("pat_test")).not.toBe(hashToken("pat_other"));
  });
});

describe("listTokens", () => {
  it("queries by userId and returns expected fields without hash", async () => {
    const rows = [
      { id: "tok-1", name: "agent", scopes: ["read"], lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    ];
    const orderBy = vi.fn(() => Promise.resolve(rows));
    const selectChain = {
      from: vi.fn(() => ({
        where: vi.fn(() => ({ orderBy })),
      })),
    };
    mockSelect.mockReturnValue(selectChain);
    const result = await listTokens("user-1");
    expect(result).toEqual(rows);
    expect(selectChain.from).toHaveBeenCalled();
  });

  it("orders newest first with the id as a tiebreaker (SHAN-746)", async () => {
    const orderBy = vi.fn(() => Promise.resolve([]));
    mockSelect.mockReturnValue({ from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy })) })) });
    await listTokens("user-1");
    expect(orderBy).toHaveBeenCalledWith(
      { c: "api_tokens.created_at", op: "desc" },
      { c: "api_tokens.id", op: "desc" },
    );
  });
});

describe("revokeToken", () => {
  it("returns true when a row is updated", async () => {
    const updateChain = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "tok-1" }])),
        })),
      })),
    };
    mockUpdate.mockReturnValue(updateChain);
    const result = await revokeToken("user-1", "tok-1");
    expect(result).toBe(true);
  });

  it("returns false when no row is updated", async () => {
    const updateChain = {
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([])),
        })),
      })),
    };
    mockUpdate.mockReturnValue(updateChain);
    const result = await revokeToken("user-1", "tok-missing");
    expect(result).toBe(false);
  });

  it("keeps the first revocation time on a repeat revoke (SHAN-746)", async () => {
    const set = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "tok-1" }])),
      })),
    }));
    mockUpdate.mockReturnValue({ set });
    await revokeToken("user-1", "tok-1");
    const { revokedAt } = (set.mock.calls[0] as unknown as [{ revokedAt: { sql: string; values: unknown[] } }])[0];
    expect(revokedAt).not.toBeInstanceOf(Date);
    expect(revokedAt.sql).toBe("coalesce(?, now())");
    expect(revokedAt.values).toEqual(["api_tokens.revoked_at"]);
  });
});

describe("lookupActiveToken", () => {
  it("returns null if the raw token lacks the pat_ prefix", async () => {
    const result = await lookupActiveToken("no_prefix_token");
    expect(result).toBeNull();
  });

  it("returns null if the token is not found in db", async () => {
    const selectChain = {
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    };
    mockSelect.mockReturnValue(selectChain);
    const result = await lookupActiveToken("pat_nonexistent");
    expect(result).toBeNull();
  });

  it("returns tokenId, userId, and scopes and fires an update when token is found", async () => {
    const row = { id: "tok-1", userId: "user-1", scopes: ["entries:write"], revokedAt: null };
    const selectChain = {
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([row])),
      })),
    };
    mockSelect.mockReturnValue(selectChain);
    const updateChain = {
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    };
    mockUpdate.mockReturnValue(updateChain);
    const result = await lookupActiveToken("pat_" + "a".repeat(43));
    expect(result).toEqual({ tokenId: "tok-1", userId: "user-1", scopes: ["entries:write"] });
    expect(mockUpdate).toHaveBeenCalled();
  });
});
