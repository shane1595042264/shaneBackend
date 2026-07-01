import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const { mockSelect, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", () => ({
  loanEntries: {
    id: "loanEntries.id",
    userId: "loanEntries.userId",
    createdAt: "loanEntries.createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ eq: { c, v } })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ lt: { c, v } })),
}));

vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    await next();
  },
}));

import { loansRoutes } from "@/modules/loans/routes";

beforeEach(() => {
  vi.clearAllMocks();
});

const app = new Hono().route("/api/loans", loansRoutes);

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ENTRY_ID = "11111111-1111-1111-1111-111111111111";

function selectReturning(rows: unknown[]) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      // .where() is awaited directly on the PATCH/DELETE lookup paths, and
      // chained with .orderBy()[.limit()] on the GET list path. Support both:
      // the returned promise resolves to rows, and also carries .orderBy(),
      // whose result resolves to rows AND carries .limit() for opt-in paging.
      where: () => {
        const orderByResult = Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve(rows),
        });
        return Object.assign(Promise.resolve(rows), {
          orderBy: () => orderByResult,
        });
      },
    }),
  }));
}

function insertReturning(rows: unknown[]) {
  mockInsert.mockImplementation(() => ({
    values: () => ({
      returning: () => Promise.resolve(rows),
    }),
  }));
}

function updateReturning(rows: unknown[]) {
  mockUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(rows),
      }),
    }),
  }));
}

function deleteOk() {
  mockDelete.mockImplementation(() => ({
    where: () => Promise.resolve(),
  }));
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    userId: USER_A,
    borrowerName: "Alice",
    amount: "42.50",
    currency: "USD",
    description: null,
    status: "outstanding",
    repaidAt: null,
    createdAt: new Date("2026-05-29T00:00:00Z"),
    updatedAt: new Date("2026-05-29T00:00:00Z"),
    ...overrides,
  };
}

describe("GET /api/loans", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/loans");
    expect(res.status).toBe(401);
  });

  it("returns the user's entries with numeric amount", async () => {
    selectReturning([makeRow({ amount: "100.25" })]);
    const res = await app.request("/api/loans", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].amount).toBe(100.25);
    expect(body.entries[0].borrowerName).toBe("Alice");
  });

  it("bare list has nextCursor null (no pagination requested)", async () => {
    selectReturning([makeRow(), makeRow({ id: "22222222-2222-2222-2222-222222222222" })]);
    const res = await app.request("/api/loans", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("returns nextCursor when a full page (length === limit) comes back", async () => {
    const last = makeRow({
      id: "22222222-2222-2222-2222-222222222222",
      createdAt: new Date("2026-05-28T00:00:00Z"),
    });
    selectReturning([makeRow(), last]);
    const res = await app.request("/api/loans?limit=2", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBe(last.createdAt.toISOString());
  });

  it("returns nextCursor null when the page is not full", async () => {
    selectReturning([makeRow()]);
    const res = await app.request("/api/loans?limit=5", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const res = await app.request("/api/loans?limit=500", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/loans", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ borrowerName: "Bob", amount: "5" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects negative amounts", async () => {
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ borrowerName: "Bob", amount: "-5" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects amounts with too many decimals", async () => {
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ borrowerName: "Bob", amount: "5.999" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty borrowerName", async () => {
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ borrowerName: "", amount: "10" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an entry and returns 201", async () => {
    insertReturning([makeRow({ borrowerName: "Bob", amount: "10.00" })]);
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ borrowerName: "Bob", amount: "10" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.borrowerName).toBe("Bob");
    expect(body.entry.amount).toBe(10);
    expect(body.entry.currency).toBe("USD");
    expect(body.entry.status).toBe("outstanding");
  });

  it("accepts a numeric amount", async () => {
    insertReturning([makeRow({ amount: "7.50" })]);
    const res = await app.request("/api/loans", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ borrowerName: "Alice", amount: 7.5 }),
    });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /api/loans/:id — ownership + status", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "repaid" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not exist", async () => {
    selectReturning([]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ status: "repaid" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller does not own the entry", async () => {
    selectReturning([makeRow({ userId: USER_A })]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_B },
      body: JSON.stringify({ status: "repaid" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an empty patch body", async () => {
    selectReturning([makeRow()]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("marks repaid and stamps repaidAt", async () => {
    selectReturning([makeRow({ status: "outstanding", repaidAt: null })]);
    const repaidDate = new Date("2026-05-29T12:00:00Z");
    updateReturning([makeRow({ status: "repaid", repaidAt: repaidDate })]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ status: "repaid" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.status).toBe("repaid");
    expect(body.entry.repaidAt).not.toBeNull();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("unmarks repaid and clears repaidAt", async () => {
    selectReturning([makeRow({ status: "repaid", repaidAt: new Date() })]);
    updateReturning([makeRow({ status: "outstanding", repaidAt: null })]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ status: "outstanding" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entry.status).toBe("outstanding");
    expect(body.entry.repaidAt).toBeNull();
  });
});

describe("DELETE /api/loans/:id — ownership", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/loans/${ENTRY_ID}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when entry does not exist", async () => {
    selectReturning([]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller does not own the entry", async () => {
    selectReturning([makeRow({ userId: USER_A })]);
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("deletes when caller owns the entry", async () => {
    selectReturning([makeRow({ userId: USER_A })]);
    deleteOk();
    const res = await app.request(`/api/loans/${ENTRY_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
