import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock the repo so we exercise the route logic (auth, validation, membership
// gating, status codes) without touching drizzle. Each route call may invoke
// multiple repo functions in sequence; mocking at the repo layer keeps the
// test surface tight.
const {
  mockCreateTripGroup,
  mockListGroupsForUser,
  mockGetGroupDetail,
  mockGetGroupBySlug,
  mockIsMember,
  mockAddMember,
  mockCreateIdea,
  mockGetIdeaById,
  mockDeleteIdeaById,
  mockSaveItinerary,
  mockConsolidateItinerary,
  mockCreateSuggestion,
  mockListSuggestions,
  mockGetSuggestionById,
  mockResolveSuggestion,
  mockInsertUserPhoto,
  mockInsertUnsplashPhoto,
  mockListPhotos,
  mockGetPhotoMeta,
  mockGetPhotoBytes,
  mockDeletePhotoById,
  mockSearchUnsplashPhoto,
} = vi.hoisted(() => ({
  mockCreateTripGroup: vi.fn(),
  mockListGroupsForUser: vi.fn(),
  mockGetGroupDetail: vi.fn(),
  mockGetGroupBySlug: vi.fn(),
  mockIsMember: vi.fn(),
  mockAddMember: vi.fn(),
  mockCreateIdea: vi.fn(),
  mockGetIdeaById: vi.fn(),
  mockDeleteIdeaById: vi.fn(),
  mockSaveItinerary: vi.fn(),
  mockConsolidateItinerary: vi.fn(),
  mockCreateSuggestion: vi.fn(),
  mockListSuggestions: vi.fn(),
  mockGetSuggestionById: vi.fn(),
  mockResolveSuggestion: vi.fn(),
  mockInsertUserPhoto: vi.fn(),
  mockInsertUnsplashPhoto: vi.fn(),
  mockListPhotos: vi.fn(),
  mockGetPhotoMeta: vi.fn(),
  mockGetPhotoBytes: vi.fn(),
  mockDeletePhotoById: vi.fn(),
  mockSearchUnsplashPhoto: vi.fn(),
}));

vi.mock("@/modules/trip-groups/repo", () => ({
  createTripGroup: mockCreateTripGroup,
  listGroupsForUser: mockListGroupsForUser,
  getGroupDetail: mockGetGroupDetail,
  getGroupBySlug: mockGetGroupBySlug,
  isMember: mockIsMember,
  addMember: mockAddMember,
  createIdea: mockCreateIdea,
  getIdeaById: mockGetIdeaById,
  deleteIdeaById: mockDeleteIdeaById,
  saveItinerary: mockSaveItinerary,
  createSuggestion: mockCreateSuggestion,
  listSuggestions: mockListSuggestions,
  getSuggestionById: mockGetSuggestionById,
  resolveSuggestion: mockResolveSuggestion,
}));

vi.mock("@/modules/trip-groups/photos-repo", () => ({
  insertUserPhoto: mockInsertUserPhoto,
  insertUnsplashPhoto: mockInsertUnsplashPhoto,
  listPhotos: mockListPhotos,
  getPhotoMeta: mockGetPhotoMeta,
  getPhotoBytes: mockGetPhotoBytes,
  deletePhotoById: mockDeletePhotoById,
}));

vi.mock("@/modules/trip-groups/unsplash", () => ({
  searchUnsplashPhoto: mockSearchUnsplashPhoto,
}));

// Mock only the LLM call; keep the real itinerarySchema export so the
// route's re-validation of stored blobs behaves exactly as in prod.
vi.mock("@/modules/trip-groups/consolidator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/trip-groups/consolidator")>();
  return { ...actual, consolidateItinerary: mockConsolidateItinerary };
});

vi.mock("@/modules/auth/middleware", () => ({
  requireAuth: async (c: any, next: any) => {
    const u = c.req.header("X-Test-User");
    if (!u) return c.json({ error: "auth" }, 401);
    c.set("userId", u);
    await next();
  },
}));

import { tripGroupsRoutes } from "@/modules/trip-groups/routes";

beforeEach(() => {
  vi.clearAllMocks();
});

const app = new Hono().route("/api/trip-groups", tripGroupsRoutes);

// itinerarySchema normalizes days by defaulting date/country to null
// (SHAN-277) — equality assertions against parsed output use this.
function enriched(itin: any) {
  return { ...itin, days: itin.days.map((d: any) => ({ date: null, country: null, ...d })) };
}


const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const IDEA_ID = "22222222-2222-2222-2222-222222222222";
const SLUG = "tokyo-2026";

const groupRow = {
  id: GROUP_ID,
  slug: SLUG,
  title: "Tokyo 2026",
  ownerId: USER_A,
  createdAt: new Date("2026-06-01T00:00:00Z"),
  updatedAt: new Date("2026-06-01T00:00:00Z"),
};

describe("POST /api/trip-groups", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Tokyo" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects empty title", async () => {
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ title: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a group and returns 201", async () => {
    mockCreateTripGroup.mockResolvedValue(groupRow);
    const res = await app.request("/api/trip-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ title: "Tokyo 2026" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.group.slug).toBe(SLUG);
    expect(body.group.title).toBe("Tokyo 2026");
    expect(mockCreateTripGroup).toHaveBeenCalledWith({ ownerId: USER_A, title: "Tokyo 2026" });
  });
});

describe("GET /api/trip-groups", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/api/trip-groups");
    expect(res.status).toBe(401);
  });

  it("flags isOwner per group", async () => {
    mockListGroupsForUser.mockResolvedValue([
      { ...groupRow, memberCount: 2, ideaCount: 5 },
      { ...groupRow, id: "33333333-3333-3333-3333-333333333333", slug: "kyoto", ownerId: USER_B, memberCount: 1, ideaCount: 0 },
    ]);
    const res = await app.request("/api/trip-groups", {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0].isOwner).toBe(true);
    expect(body.groups[1].isOwner).toBe(false);
    expect(body.groups[0].memberCount).toBe(2);
    expect(body.groups[0].ideaCount).toBe(5);
  });
});

describe("GET /api/trip-groups/:slug", () => {
  it("returns 404 when group missing", async () => {
    mockGetGroupDetail.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not a member", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...groupRow,
      members: [{ userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date() }],
      ideas: [],
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("returns detail for a member", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...groupRow,
      members: [
        { userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date("2026-06-01T00:00:00Z") },
        { userId: USER_B, name: "Friend", role: "member", joinedAt: new Date("2026-06-02T00:00:00Z") },
      ],
      ideas: [
        { id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A, authorName: "Shane", body: "Visit Shibuya", createdAt: new Date("2026-06-03T00:00:00Z") },
      ],
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.members).toHaveLength(2);
    expect(body.group.ideas).toHaveLength(1);
    expect(body.group.ideas[0].body).toBe("Visit Shibuya");
    expect(body.group.isOwner).toBe(false);
  });
});

describe("POST /api/trip-groups/:slug/join", () => {
  it("reports joined=true on first join", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockAddMember.mockResolvedValue(true);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.joined).toBe(true);
    expect(body.alreadyMember).toBe(false);
  });

  it("reports alreadyMember=true on duplicate join", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockAddMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.joined).toBe(false);
    expect(body.alreadyMember).toBe(true);
  });

  it("returns 404 for missing slug", async () => {
    mockGetGroupBySlug.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}/join`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/trip-groups/:slug/ideas", () => {
  it("rejects non-members with 403", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_B },
      body: JSON.stringify({ body: "Visit Shibuya" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects empty body", async () => {
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an idea and returns 201", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    mockCreateIdea.mockResolvedValue({
      id: IDEA_ID,
      groupId: GROUP_ID,
      authorId: USER_A,
      authorName: "Shane",
      body: "Visit Shibuya",
      createdAt: new Date("2026-06-03T00:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ body: "  Visit Shibuya  " }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.idea.body).toBe("Visit Shibuya");
    expect(mockCreateIdea).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      authorId: USER_A,
      body: "Visit Shibuya",
    });
  });
});

describe("DELETE /api/trip-groups/:slug/ideas/:ideaId", () => {
  it("returns 403 when caller is not the idea author", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({ id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when idea belongs to a different group", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({
      id: IDEA_ID,
      groupId: "99999999-9999-9999-9999-999999999999",
      authorId: USER_A,
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  it("deletes when caller is the author", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetIdeaById.mockResolvedValue({ id: IDEA_ID, groupId: GROUP_ID, authorId: USER_A });
    mockDeleteIdeaById.mockResolvedValue(true);
    const res = await app.request(`/api/trip-groups/${SLUG}/ideas/${IDEA_ID}`, {
      method: "DELETE",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/trip-groups/:slug/itinerary/consolidate", () => {
  const ITINERARY = {
    summary: "Three days across central Tokyo.",
    days: [
      {
        day: 1,
        title: "Shibuya + Shinjuku",
        location: "Tokyo",
        activities: [{ time: "09:00", title: "Meiji Shrine", notes: null }],
      },
    ],
  };

  const detailWithIdeas = {
    ...groupRow,
    itinerary: null,
    itineraryGeneratedAt: null,
    members: [
      { userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date("2026-06-01T00:00:00Z") },
      { userId: USER_B, name: "Ben", role: "member", joinedAt: new Date("2026-06-02T00:00:00Z") },
    ],
    ideas: [
      {
        id: IDEA_ID,
        groupId: GROUP_ID,
        authorId: USER_B,
        authorName: "Ben",
        body: "Meiji Shrine early morning",
        createdAt: new Date("2026-06-03T00:00:00Z"),
      },
    ],
  };

  it("returns 401 without auth", async () => {
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when group missing", async () => {
    mockGetGroupDetail.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(404);
  });

  // SHAN-273: non-owner members no longer get 403 — their consolidation
  // lands as a pending suggestion. See "itinerary suggestions (SHAN-273)".

  it("returns 400 when the idea inbox is empty", async () => {
    mockGetGroupDetail.mockResolvedValue({ ...detailWithIdeas, ideas: [] });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(400);
    expect(mockConsolidateItinerary).not.toHaveBeenCalled();
  });

  it("consolidates, persists, and returns the itinerary for the owner", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockResolvedValue({
      itinerary: ITINERARY,
      modelUsed: "claude-sonnet-4-20250514",
    });
    mockSaveItinerary.mockResolvedValue({
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itinerary.summary).toBe(ITINERARY.summary);
    expect(body.itineraryGeneratedAt).toBe("2026-06-10T12:00:00.000Z");
    expect(mockSaveItinerary).toHaveBeenCalledWith(GROUP_ID, ITINERARY);
    // No stored itinerary → LLM gets no base to refine.
    expect(mockConsolidateItinerary).toHaveBeenCalledWith(
      expect.objectContaining({ existingItinerary: null }),
    );
  });

  it("passes a previously stored itinerary to the LLM as the base", async () => {
    mockGetGroupDetail.mockResolvedValue({ ...detailWithIdeas, itinerary: ITINERARY });
    mockConsolidateItinerary.mockResolvedValue({
      itinerary: ITINERARY,
      modelUsed: "claude-sonnet-4-20250514",
    });
    mockSaveItinerary.mockResolvedValue({
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    expect(mockConsolidateItinerary).toHaveBeenCalledWith(
      expect.objectContaining({ existingItinerary: enriched(ITINERARY) }),
    );
  });

  it("maps LLM-chain exhaustion to 502 and does not persist", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockRejectedValue(
      new Error("All LLM providers failed. Anthropic: boom; Groq: bust"),
    );
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(502);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
  });

  it("maps invalid AI output to 502", async () => {
    mockGetGroupDetail.mockResolvedValue(detailWithIdeas);
    mockConsolidateItinerary.mockRejectedValue(
      new Error("AI itinerary failed schema validation (model: x): days: Required"),
    );
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(502);
  });

  it("GET detail carries itinerary + itineraryGeneratedAt", async () => {
    mockGetGroupDetail.mockResolvedValue({
      ...detailWithIdeas,
      itinerary: ITINERARY,
      itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z"),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}`, {
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.itinerary.days).toHaveLength(1);
    expect(body.group.itineraryGeneratedAt).toBe("2026-06-10T12:00:00.000Z");
  });
});

describe("itinerary suggestions (SHAN-273)", () => {
  const SUGG_ID = "44444444-4444-4444-4444-444444444444";
  const ITIN = {
    summary: "Two days in Tokyo.",
    days: [
      { day: 1, title: "Shibuya", location: "Tokyo", activities: [{ time: null, title: "Crossing", notes: null }] },
    ],
  };
  const memberDetail = {
    ...groupRow,
    itinerary: null,
    itineraryGeneratedAt: null,
    members: [
      { userId: USER_A, name: "Shane", role: "owner", joinedAt: new Date("2026-06-01T00:00:00Z") },
      { userId: USER_B, name: "Ben", role: "member", joinedAt: new Date("2026-06-02T00:00:00Z") },
    ],
    ideas: [
      { id: IDEA_ID, groupId: GROUP_ID, authorId: USER_B, authorName: "Ben", body: "Shibuya crossing", createdAt: new Date("2026-06-03T00:00:00Z") },
    ],
  };
  const suggestionRow = {
    id: SUGG_ID,
    groupId: GROUP_ID,
    authorId: USER_B,
    authorName: "Ben",
    itinerary: ITIN,
    changedDays: [1],
    note: null,
    status: "pending",
    createdAt: new Date("2026-06-10T10:00:00Z"),
    resolvedAt: null,
    resolvedBy: null,
  };

  it("non-owner consolidate creates a pending suggestion instead of writing", async () => {
    mockGetGroupDetail.mockResolvedValue(memberDetail);
    mockConsolidateItinerary.mockResolvedValue({ itinerary: ITIN, modelUsed: "m" });
    mockCreateSuggestion.mockResolvedValue(suggestionRow);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.suggestion.id).toBe(SUGG_ID);
    expect(body.suggestion.status).toBe("pending");
    expect(mockSaveItinerary).not.toHaveBeenCalled();
    expect(mockCreateSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP_ID, authorId: USER_B, changedDays: [1] }),
    );
  });

  it("owner consolidate still writes directly", async () => {
    mockGetGroupDetail.mockResolvedValue(memberDetail);
    mockConsolidateItinerary.mockResolvedValue({ itinerary: ITIN, modelUsed: "m" });
    mockSaveItinerary.mockResolvedValue({ itineraryGeneratedAt: new Date("2026-06-10T11:00:00Z") });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_A },
    });
    expect(res.status).toBe(200);
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
  });

  it("non-member consolidate is 403", async () => {
    mockGetGroupDetail.mockResolvedValue({ ...memberDetail, members: [memberDetail.members[0]] });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/consolidate`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("lists suggestions with pairwise conflicts on overlapping changedDays", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    const other = { ...suggestionRow, id: "55555555-5555-5555-5555-555555555555", changedDays: [1, 2] };
    const disjoint = { ...suggestionRow, id: "66666666-6666-6666-6666-666666666666", changedDays: [9] };
    const resolved = { ...suggestionRow, id: "77777777-7777-7777-7777-777777777777", status: "rejected", changedDays: [1] };
    mockListSuggestions.mockResolvedValue([suggestionRow, other, disjoint, resolved]);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/suggestions`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.suggestions.map((s: any) => [s.id, s]));
    expect(byId[SUGG_ID].conflictsWith).toEqual(["55555555-5555-5555-5555-555555555555"]);
    expect(byId["66666666-6666-6666-6666-666666666666"].conflictsWith).toEqual([]);
    // resolved suggestions never conflict
    expect(byId["77777777-7777-7777-7777-777777777777"].conflictsWith).toEqual([]);
  });

  it("approve applies the suggestion itinerary and resolves it", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetSuggestionById.mockResolvedValue(suggestionRow);
    mockResolveSuggestion.mockResolvedValue({ id: SUGG_ID, status: "approved", resolvedAt: new Date() });
    mockSaveItinerary.mockResolvedValue({ itineraryGeneratedAt: new Date("2026-06-10T12:00:00Z") });
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/suggestions/${SUGG_ID}/approve`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(200);
    expect(mockResolveSuggestion).toHaveBeenCalledWith(SUGG_ID, "approved", USER_A);
    expect(mockSaveItinerary).toHaveBeenCalledWith(GROUP_ID, enriched(ITIN));
  });

  it("approve by non-owner is 403", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/suggestions/${SUGG_ID}/approve`,
      { method: "POST", headers: { "X-Test-User": USER_B } },
    );
    expect(res.status).toBe(403);
    expect(mockResolveSuggestion).not.toHaveBeenCalled();
  });

  it("approve of an already-resolved suggestion is 409 and does not write", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetSuggestionById.mockResolvedValue(suggestionRow);
    mockResolveSuggestion.mockResolvedValue(null);
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/suggestions/${SUGG_ID}/approve`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(409);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
  });

  it("reject resolves without applying", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetSuggestionById.mockResolvedValue(suggestionRow);
    mockResolveSuggestion.mockResolvedValue({ id: SUGG_ID, status: "rejected", resolvedAt: new Date() });
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/suggestions/${SUGG_ID}/reject`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(200);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
    expect(mockResolveSuggestion).toHaveBeenCalledWith(SUGG_ID, "rejected", USER_A);
  });

  it("suggestion from another group 404s on approve", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockGetSuggestionById.mockResolvedValue({ ...suggestionRow, groupId: "99999999-9999-9999-9999-999999999999" });
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/suggestions/${SUGG_ID}/approve`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(404);
  });
});

describe("itinerary photos (SHAN-275)", () => {
  const PHOTO_ID = "88888888-8888-8888-8888-888888888888";
  const photoMeta = {
    id: PHOTO_ID,
    groupId: GROUP_ID,
    day: 1,
    uploaderId: USER_B,
    source: "user",
    mimeType: "image/png",
    byteSize: 4,
    externalUrl: null,
    attribution: null,
    createdAt: new Date("2026-06-10T10:00:00Z"),
  };
  const groupWithItin = {
    ...groupRow,
    itinerary: {
      summary: "Trip",
      days: [
        { day: 1, title: "A", location: "Athens", activities: [] },
        { day: 2, title: "B", location: "Rome", activities: [] },
        { day: 3, title: "C", location: null, activities: [] },
      ],
    },
    itineraryGeneratedAt: new Date(),
  };

  it("raw route is public: 404 (not 401) without auth for a missing photo", async () => {
    mockGetPhotoBytes.mockResolvedValue(null);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos/${PHOTO_ID}/raw`);
    expect(res.status).toBe(404);
  });

  it("raw route streams stored bytes with the stored mime", async () => {
    mockGetPhotoBytes.mockResolvedValue({
      mimeType: "image/png",
      byteSize: 4,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos/${PHOTO_ID}/raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("list is member-gated", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos`, {
      headers: { "X-Test-User": USER_B },
    });
    expect(res.status).toBe(403);
  });

  it("list maps user rows to the raw route and unsplash rows to the hotlink", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    mockListPhotos.mockResolvedValue([
      photoMeta,
      { ...photoMeta, id: "99999999-9999-9999-9999-999999999999", source: "unsplash", uploaderId: null, externalUrl: "https://images.unsplash.com/x", attribution: "Photo by Y on Unsplash" },
    ]);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos`, {
      headers: { "X-Test-User": USER_B },
    });
    const body = await res.json();
    expect(body.photos[0].url).toBe(`/api/trip-groups/${SLUG}/itinerary/photos/${PHOTO_ID}/raw`);
    expect(body.photos[1].url).toBe("https://images.unsplash.com/x");
    expect(body.photos[1].attribution).toContain("Unsplash");
  });

  it("upload sniffs magic bytes and stores for a valid day", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    mockInsertUserPhoto.mockResolvedValue(photoMeta);
    // Real PNG magic bytes so sniffImageMime (unmocked, pure) accepts it.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const form = new FormData();
    form.append("file", new File([png], "x.png", { type: "image/png" }));
    form.append("day", "1");
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(mockInsertUserPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: GROUP_ID, day: 1, uploaderId: USER_B, mimeType: "image/png" }),
    );
  });

  it("upload rejects a non-image payload with 415", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3, 4])], "x.txt", { type: "text/plain" }));
    form.append("day", "1");
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
      body: form,
    });
    expect(res.status).toBe(415);
  });

  it("upload rejects a bad day", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockIsMember.mockResolvedValue(true);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append("file", new File([png], "x.png", { type: "image/png" }));
    form.append("day", "0");
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary/photos`, {
      method: "POST",
      headers: { "X-Test-User": USER_B },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("delete allowed for uploader, forbidden for an unrelated member", async () => {
    mockGetGroupBySlug.mockResolvedValue({ ...groupRow, ownerId: USER_A });
    mockGetPhotoMeta.mockResolvedValue(photoMeta); // uploaded by USER_B
    mockDeletePhotoById.mockResolvedValue(true);
    const asUploader = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/${PHOTO_ID}`,
      { method: "DELETE", headers: { "X-Test-User": USER_B } },
    );
    expect(asUploader.status).toBe(204);
    const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const asStranger = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/${PHOTO_ID}`,
      { method: "DELETE", headers: { "X-Test-User": STRANGER } },
    );
    expect(asStranger.status).toBe(403);
  });

  it("unsplash-fill is owner-only and 400 without an itinerary", async () => {
    mockGetGroupBySlug.mockResolvedValue({ ...groupRow, itinerary: null });
    const nonOwner = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/unsplash-fill`,
      { method: "POST", headers: { "X-Test-User": USER_B } },
    );
    expect(nonOwner.status).toBe(403);
    const noItin = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/unsplash-fill`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(noItin.status).toBe(400);
  });

  it("unsplash-fill covers located days without photos and skips failures", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupWithItin);
    // day 1 already covered; day 2 (Rome) needs a photo; day 3 has no location
    mockListPhotos.mockResolvedValue([photoMeta]);
    mockSearchUnsplashPhoto.mockResolvedValue({ url: "https://images.unsplash.com/rome", attribution: "Photo by Z on Unsplash" });
    mockInsertUnsplashPhoto.mockResolvedValue({
      ...photoMeta, id: "99999999-9999-9999-9999-999999999999", day: 2, source: "unsplash", uploaderId: null,
      externalUrl: "https://images.unsplash.com/rome", attribution: "Photo by Z on Unsplash",
    });
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/unsplash-fill`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photos).toHaveLength(1);
    expect(mockSearchUnsplashPhoto).toHaveBeenCalledTimes(1);
    expect(mockSearchUnsplashPhoto).toHaveBeenCalledWith("Rome");
  });

  it("unsplash-fill surfaces total failure as 502", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupWithItin);
    mockListPhotos.mockResolvedValue([]);
    mockSearchUnsplashPhoto.mockRejectedValue(new Error("Unsplash API error 401: bad key"));
    const res = await app.request(
      `/api/trip-groups/${SLUG}/itinerary/photos/unsplash-fill`,
      { method: "POST", headers: { "X-Test-User": USER_A } },
    );
    expect(res.status).toBe(502);
  });
});

describe("PUT /api/trip-groups/:slug/itinerary (SHAN-276)", () => {
  const ITIN = {
    summary: "Edited trip.",
    days: [
      { day: 1, title: "Edited day", location: "Tokyo", activities: [{ time: "10:00", title: "New stop", notes: null }] },
    ],
  };

  it("owner edit writes directly", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockSaveItinerary.mockResolvedValue({ itineraryGeneratedAt: new Date("2026-06-10T13:00:00Z") });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ itinerary: ITIN }),
    });
    expect(res.status).toBe(200);
    expect(mockSaveItinerary).toHaveBeenCalledWith(GROUP_ID, enriched(ITIN));
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
  });

  it("member edit lands as a pending suggestion with computed changedDays", async () => {
    mockGetGroupBySlug.mockResolvedValue({ ...groupRow, itinerary: null });
    mockIsMember.mockResolvedValue(true);
    mockCreateSuggestion.mockResolvedValue({
      id: "44444444-4444-4444-4444-444444444444",
      groupId: GROUP_ID,
      authorId: USER_B,
      authorName: "Ben",
      itinerary: ITIN,
      changedDays: [1],
      note: "Manual edit",
      status: "pending",
      createdAt: new Date("2026-06-10T13:00:00Z"),
      resolvedAt: null,
      resolvedBy: null,
    });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_B },
      body: JSON.stringify({ itinerary: ITIN }),
    });
    expect(res.status).toBe(201);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
    expect(mockCreateSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: USER_B, changedDays: [1], note: "Manual edit" }),
    );
  });

  it("rejects an itinerary that fails the schema", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ itinerary: { summary: "", days: [] } }),
    });
    expect(res.status).toBe(400);
    expect(mockSaveItinerary).not.toHaveBeenCalled();
  });

  it("403 for non-members", async () => {
    mockGetGroupBySlug.mockResolvedValue({ ...groupRow, ownerId: USER_A });
    mockIsMember.mockResolvedValue(false);
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_B },
      body: JSON.stringify({ itinerary: ITIN }),
    });
    expect(res.status).toBe(403);
  });
});

describe("itinerary day date + country (SHAN-277)", () => {
  it("PUT accepts days with date and country and preserves them", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockSaveItinerary.mockResolvedValue({ itineraryGeneratedAt: new Date("2026-06-10T14:00:00Z") });
    const itin = {
      summary: "Dated trip.",
      days: [
        { day: 1, title: "Athens", date: "2026-07-25", location: "Athens", country: "Greece", activities: [] },
      ],
    };
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ itinerary: itin }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itinerary.days[0].date).toBe("2026-07-25");
    expect(body.itinerary.days[0].country).toBe("Greece");
  });

  it("PUT rejects a malformed date", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    const itin = {
      summary: "Bad date.",
      days: [{ day: 1, title: "X", date: "07/25/2026", location: null, country: null, activities: [] }],
    };
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ itinerary: itin }),
    });
    expect(res.status).toBe(400);
  });

  it("legacy itineraries without date/country still validate (defaults null)", async () => {
    mockGetGroupBySlug.mockResolvedValue(groupRow);
    mockSaveItinerary.mockResolvedValue({ itineraryGeneratedAt: new Date() });
    const res = await app.request(`/api/trip-groups/${SLUG}/itinerary`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": USER_A },
      body: JSON.stringify({ itinerary: { summary: "Legacy.", days: [{ day: 1, title: "X", location: null, activities: [] }] } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itinerary.days[0].date).toBeNull();
    expect(body.itinerary.days[0].country).toBeNull();
  });
});
