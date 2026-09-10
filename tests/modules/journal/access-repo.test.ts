import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate, mockDelete, mockTransaction } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    transaction: mockTransaction,
  },
}));
vi.mock("@/db/schema", () => ({
  journalAccess: { userId: "journal_access.user_id", role: "journal_access.role" },
  journalAccessRequests: {
    id: "jar.id",
    userId: "jar.user_id",
    status: "jar.status",
    message: "jar.message",
    decidedBy: "jar.decided_by",
    decidedAt: "jar.decided_at",
    createdAt: "jar.created_at",
  },
  users: { id: "users.id", email: "users.email", name: "users.name", avatarUrl: "users.avatar_url" },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ eq: [c, v] })),
  and: vi.fn((...a) => ({ and: a })),
  asc: vi.fn((c) => ({ c, dir: "asc" })),
  desc: vi.fn((c) => ({ c, dir: "desc" })),
  sql: vi.fn(() => ({ __sql: true })),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "returning", "set"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

/** db.insert(...).values(...).onConflictDoUpdate/DoNothing(...) */
function insertChain(rows: unknown[] = []) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["values", "onConflictDoUpdate", "onConflictDoNothing", "returning"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import {
  approveRequest,
  createOrRefreshRequest,
  getAccessFor,
  grantAccessByEmail,
  hasJournalAccess,
  isOwner,
  ownerEmail,
  rejectRequest,
  revokeAccess,
} from "@/modules/journal/access-repo";

const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: run the transaction body against the same top-level mocks so a
  // test only has to stub insert/update once.
  mockTransaction.mockImplementation(async (fn: any) =>
    fn({ select: mockSelect, insert: mockInsert, update: mockUpdate, delete: mockDelete }),
  );
});
afterEach(() => {
  delete process.env.JOURNAL_OWNER_EMAIL;
});

describe("ownerEmail", () => {
  it("falls back to Shane's account when the env var is unset, so the journal is never ownerless", () => {
    expect(ownerEmail()).toBe("a1595042264@gmail.com");
  });

  it("normalizes the configured value", () => {
    process.env.JOURNAL_OWNER_EMAIL = "  Someone@Example.COM ";
    expect(ownerEmail()).toBe("someone@example.com");
  });
});

describe("getAccessFor", () => {
  it("returns an empty state for a signed-out caller without touching the db", async () => {
    expect(await getAccessFor(null)).toEqual({
      role: null,
      requestStatus: null,
      requestMessage: null,
    });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("treats the configured owner email as owner and self-heals the access row", async () => {
    mockSelect.mockReturnValueOnce(chain([{ email: "A1595042264@Gmail.com" }]));
    mockInsert.mockReturnValue(insertChain());

    expect(await getAccessFor(USER)).toEqual({
      role: "owner",
      requestStatus: null,
      requestMessage: null,
    });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("returns member for a granted user", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ email: "friend@example.com" }]))
      .mockReturnValueOnce(chain([{ role: "member" }]));

    expect(await getAccessFor(USER)).toMatchObject({ role: "member" });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("surfaces a pending request for a user with no membership", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ email: "friend@example.com" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ status: "pending", message: "please" }]));

    expect(await getAccessFor(USER)).toEqual({
      role: null,
      requestStatus: "pending",
      requestMessage: "please",
    });
  });

  it("returns nulls when the user row is gone", async () => {
    mockSelect.mockReturnValueOnce(chain([]));
    expect(await getAccessFor(USER)).toEqual({
      role: null,
      requestStatus: null,
      requestMessage: null,
    });
  });
});

describe("isOwner / hasJournalAccess", () => {
  it("isOwner is false for a plain member", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ email: "friend@example.com" }]))
      .mockReturnValueOnce(chain([{ role: "member" }]));
    expect(await isOwner(USER)).toBe(false);
  });

  it("hasJournalAccess is true for a plain member", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ email: "friend@example.com" }]))
      .mockReturnValueOnce(chain([{ role: "member" }]));
    expect(await hasJournalAccess(USER)).toBe(true);
  });

  it("hasJournalAccess is false for a stranger with a pending request", async () => {
    mockSelect
      .mockReturnValueOnce(chain([{ email: "friend@example.com" }]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([{ status: "pending", message: null }]));
    expect(await hasJournalAccess(USER)).toBe(false);
  });
});

describe("grantAccessByEmail", () => {
  it("returns null without granting when nobody has signed in with that email", async () => {
    mockSelect.mockReturnValueOnce(chain([]));
    expect(await grantAccessByEmail("ghost@example.com", "owner-1")).toBeNull();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("grants membership and settles any pending request from the invitee", async () => {
    mockSelect.mockReturnValueOnce(chain([{ id: "u2", email: "friend@example.com" }]));
    mockInsert.mockReturnValue(insertChain());
    mockUpdate.mockReturnValue(chain([]));

    const out = await grantAccessByEmail("  Friend@Example.com ", "owner-1");
    expect(out).toMatchObject({ id: "u2" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("revokeAccess", () => {
  it("reports false when no member row was removed", async () => {
    mockDelete.mockReturnValue(chain([]));
    expect(await revokeAccess("u2")).toBe(false);
  });

  it("reports true when a member row was removed", async () => {
    mockDelete.mockReturnValue(chain([{ userId: "u2" }]));
    expect(await revokeAccess("u2")).toBe(true);
  });
});

describe("createOrRefreshRequest", () => {
  it("returns the existing pending request untouched", async () => {
    mockSelect.mockReturnValueOnce(chain([{ id: "r1", status: "pending" }]));
    const out = await createOrRefreshRequest(USER, "again");
    expect(out).toEqual({ request: { id: "r1", status: "pending" }, created: false });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("flips a rejected request back to pending instead of inserting a duplicate", async () => {
    mockSelect.mockReturnValueOnce(chain([{ id: "r1", status: "rejected" }]));
    mockUpdate.mockReturnValue(chain([{ id: "r1", status: "pending" }]));
    const out = await createOrRefreshRequest(USER, "second try");
    expect(out.created).toBe(false);
    expect(out.request).toMatchObject({ status: "pending" });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("inserts a fresh request for a first-time asker", async () => {
    mockSelect.mockReturnValueOnce(chain([]));
    mockInsert.mockReturnValue(insertChain([{ id: "r9", status: "pending" }]));
    const out = await createOrRefreshRequest(USER, null);
    expect(out.created).toBe(true);
    expect(out.request).toMatchObject({ id: "r9" });
  });
});

describe("approveRequest / rejectRequest", () => {
  it("approve returns null and grants nothing when the request was already decided", async () => {
    mockUpdate.mockReturnValue(chain([]));
    expect(await approveRequest("r1", "owner-1")).toBeNull();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("approve writes the membership row for the requester", async () => {
    mockUpdate.mockReturnValue(chain([{ id: "r1", userId: "u2", status: "approved" }]));
    mockInsert.mockReturnValue(insertChain());
    const out = await approveRequest("r1", "owner-1");
    expect(out).toMatchObject({ userId: "u2" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("reject returns null when nothing was pending", async () => {
    mockUpdate.mockReturnValue(chain([]));
    expect(await rejectRequest("r1", "owner-1")).toBeNull();
  });

  it("reject returns the decided row", async () => {
    mockUpdate.mockReturnValue(chain([{ id: "r1", status: "rejected" }]));
    expect(await rejectRequest("r1", "owner-1")).toMatchObject({ status: "rejected" });
  });
});
