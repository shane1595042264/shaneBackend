import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const {
  mockGetAccessFor,
  mockCreateOrRefresh,
  mockListRequests,
  mockApprove,
  mockReject,
  mockListMembers,
  mockGrantByEmail,
  mockRevoke,
} = vi.hoisted(() => ({
  mockGetAccessFor: vi.fn(),
  mockCreateOrRefresh: vi.fn(),
  mockListRequests: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
  mockListMembers: vi.fn(),
  mockGrantByEmail: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock("@/modules/journal/access-repo", () => ({
  getAccessFor: mockGetAccessFor,
  createOrRefreshRequest: mockCreateOrRefresh,
  listRequests: mockListRequests,
  approveRequest: mockApprove,
  rejectRequest: mockReject,
  listMembers: mockListMembers,
  grantAccessByEmail: mockGrantByEmail,
  revokeAccess: mockRevoke,
}));

// X-Test-User sets the caller; X-Test-Pat marks the call as coming from a PAT
// (tokenScopes non-null) so the browser-only guard can be exercised.
vi.mock("@/modules/auth/middleware", () => ({
  optionalAuth: async (c: any, next: any) => {
    c.set("userId", c.req.header("X-Test-User") ?? null);
    c.set("tokenScopes", c.req.header("X-Test-Pat") ? ["entries:write"] : null);
    await next();
  },
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    c.set("tokenScopes", c.req.header("X-Test-Pat") ? ["entries:write"] : null);
    await next();
  },
  requireScope: () => async (_c: any, next: any) => {
    await next();
  },
}));

import { journalAccessRoutes } from "@/modules/journal/access-routes";

const app = new Hono().route("/api/journal/access", journalAccessRoutes);

const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";
const REQ_ID = "33333333-3333-3333-3333-333333333333";

const NONE = { role: null, requestStatus: null, requestMessage: null };
const OWNER_STATE = { role: "owner", requestStatus: null, requestMessage: null };
const MEMBER_STATE = { role: "member", requestStatus: null, requestMessage: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccessFor.mockResolvedValue(NONE);
});

describe("GET /api/journal/access/me", () => {
  it("returns nulls for a signed-out visitor instead of 401", async () => {
    const res = await app.request("/api/journal/access/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NONE);
  });

  it("reports the caller's role and pending request", async () => {
    mockGetAccessFor.mockResolvedValue({
      role: null,
      requestStatus: "pending",
      requestMessage: "let me in",
    });
    const res = await app.request("/api/journal/access/me", {
      headers: { "X-Test-User": STRANGER },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: null, requestStatus: "pending" });
  });
});

describe("POST /api/journal/access/requests", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/journal/access/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects PATs so an agent token cannot request itself in", async () => {
    const res = await app.request("/api/journal/access/requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-User": STRANGER,
        "X-Test-Pat": "1",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
  });

  it("creates a pending request with a message", async () => {
    mockCreateOrRefresh.mockResolvedValue({
      request: { id: REQ_ID, status: "pending" },
      created: true,
    });
    const res = await app.request("/api/journal/access/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": STRANGER },
      body: JSON.stringify({ message: "  hi Shane  " }),
    });
    expect(res.status).toBe(201);
    expect(mockCreateOrRefresh).toHaveBeenCalledWith(STRANGER, "hi Shane");
  });

  it("is idempotent — a repeat request returns 200, not a duplicate 201", async () => {
    mockCreateOrRefresh.mockResolvedValue({
      request: { id: REQ_ID, status: "pending" },
      created: false,
    });
    const res = await app.request("/api/journal/access/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": STRANGER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(mockCreateOrRefresh).toHaveBeenCalledWith(STRANGER, null);
  });

  it("409s when the caller already has access", async () => {
    mockGetAccessFor.mockResolvedValue(MEMBER_STATE);
    const res = await app.request("/api/journal/access/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": STRANGER },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(mockCreateOrRefresh).not.toHaveBeenCalled();
  });
});

describe("owner-only routes", () => {
  it("403s a member on the request queue", async () => {
    mockGetAccessFor.mockResolvedValue(MEMBER_STATE);
    const res = await app.request("/api/journal/access/requests", {
      headers: { "X-Test-User": STRANGER },
    });
    expect(res.status).toBe(403);
    expect(mockListRequests).not.toHaveBeenCalled();
  });

  it("lets the owner filter the queue by status", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockListRequests.mockResolvedValue([{ id: REQ_ID, status: "pending" }]);
    const res = await app.request("/api/journal/access/requests?status=pending", {
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(200);
    expect(mockListRequests).toHaveBeenCalledWith("pending");
    expect((await res.json()).requests).toHaveLength(1);
  });

  it("rejects an unknown status value with 400", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    const res = await app.request("/api/journal/access/requests?status=maybe", {
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(400);
  });

  it("approves a pending request", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockApprove.mockResolvedValue({ id: REQ_ID, status: "approved" });
    const res = await app.request(`/api/journal/access/requests/${REQ_ID}/approve`, {
      method: "POST",
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith(REQ_ID, OWNER);
  });

  it("404s approving an already-decided request", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockApprove.mockResolvedValue(null);
    const res = await app.request(`/api/journal/access/requests/${REQ_ID}/approve`, {
      method: "POST",
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(404);
  });

  it("400s a malformed request id instead of reaching Postgres", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    const res = await app.request("/api/journal/access/requests/not-a-uuid/reject", {
      method: "POST",
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(400);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("invites by email", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockGrantByEmail.mockResolvedValue({ id: STRANGER, email: "friend@example.com" });
    const res = await app.request("/api/journal/access/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": OWNER },
      body: JSON.stringify({ email: "friend@example.com" }),
    });
    expect(res.status).toBe(201);
    expect(mockGrantByEmail).toHaveBeenCalledWith("friend@example.com", OWNER);
  });

  it("404s inviting an email that has never signed in", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockGrantByEmail.mockResolvedValue(null);
    const res = await app.request("/api/journal/access/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": OWNER },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a malformed invite email", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    const res = await app.request("/api/journal/access/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": OWNER },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(mockGrantByEmail).not.toHaveBeenCalled();
  });

  it("revokes a member", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockRevoke.mockResolvedValue(true);
    const res = await app.request(`/api/journal/access/members/${STRANGER}`, {
      method: "DELETE",
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(204);
    expect(mockRevoke).toHaveBeenCalledWith(STRANGER);
  });

  it("404s revoking someone who is not a member (including the owner row)", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockRevoke.mockResolvedValue(false);
    const res = await app.request(`/api/journal/access/members/${OWNER}`, {
      method: "DELETE",
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(404);
  });

  it("lists members", async () => {
    mockGetAccessFor.mockResolvedValue(OWNER_STATE);
    mockListMembers.mockResolvedValue([{ userId: OWNER, role: "owner" }]);
    const res = await app.request("/api/journal/access/members", {
      headers: { "X-Test-User": OWNER },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).members[0].role).toBe("owner");
  });
});
