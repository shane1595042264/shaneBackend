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
  trips: { id: {}, slug: {}, title: {}, ownerId: {}, html: {}, sourceFilename: {}, createdAt: {}, updatedAt: {} },
  users: { id: {}, name: {} },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  asc: vi.fn((c: unknown) => ({ c, dir: "asc" })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "lt" })),
  sql: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => ({
    fragments: [...strings],
    params,
  })),
}));
// Deterministic slug so createTrip's collision probe doesn't touch the db.
vi.mock("@/modules/trips/slug", () => ({
  generateUniqueSlug: vi.fn(async () => "tokyo-2026"),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const t = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "values", "set", "returning"]) {
    c[m] = vi.fn(() => c);
  }
  Object.assign(c, { then: (r: any, j: any) => t.then(r, j) });
  return c;
}

import { or } from "drizzle-orm";
import {
  createTrip,
  findDuplicateTrip,
  normalizeTitle,
  updateTripBySlug,
} from "@/modules/trips/repo";

beforeEach(() => vi.clearAllMocks());

const baseRow = {
  id: "trip-1",
  slug: "tokyo-2026",
  title: "Tokyo 2026",
  html: "<h1>Tokyo</h1>",
  sourceFilename: null,
  createdAt: new Date("2026-07-23T00:00:00Z"),
  updatedAt: new Date("2026-07-23T00:00:00Z"),
};

describe("createTrip", () => {
  it("populates ownerName from the users table for an owner-attributed trip", async () => {
    mockInsert.mockReturnValue(chain([{ ...baseRow, ownerId: "user-1" }]));
    mockSelect.mockReturnValue(chain([{ name: "Shane" }]));

    const trip = await createTrip({ ownerId: "user-1", title: "Tokyo 2026", html: "<h1>Tokyo</h1>", sourceFilename: null });

    expect(trip.ownerName).toBe("Shane");
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns null ownerName for an anonymous trip without querying users", async () => {
    mockInsert.mockReturnValue(chain([{ ...baseRow, ownerId: null }]));

    const trip = await createTrip({ ownerId: null, title: "Tokyo 2026", html: "<h1>Tokyo</h1>", sourceFilename: null });

    expect(trip.ownerName).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe("updateTripBySlug", () => {
  it("populates ownerName from the users table after an owner-attributed update", async () => {
    mockUpdate.mockReturnValue(chain([{ ...baseRow, ownerId: "user-1" }]));
    mockSelect.mockReturnValue(chain([{ name: "Shane" }]));

    const trip = await updateTripBySlug("tokyo-2026", { title: "Tokyo 2026 v2" });

    expect(trip?.ownerName).toBe("Shane");
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns null ownerName for an anonymous trip update without querying users", async () => {
    mockUpdate.mockReturnValue(chain([{ ...baseRow, ownerId: null }]));

    const trip = await updateTripBySlug("tokyo-2026", { title: "Tokyo 2026 v2" });

    expect(trip?.ownerName).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns null when the slug does not exist", async () => {
    mockUpdate.mockReturnValue(chain([]));

    const trip = await updateTripBySlug("missing", { title: "x" });

    expect(trip).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe("normalizeTitle (SHAN-514)", () => {
  it("trims, collapses internal whitespace and lowercases", () => {
    expect(normalizeTitle("  Europe   Trip\nItinerary ")).toBe("europe trip itinerary");
  });

  it("treats two spellings of the same title as equal", () => {
    expect(normalizeTitle("Tokyo Trip")).toBe(normalizeTitle("tokyo  trip"));
  });

  it("leaves a title that is already normal alone", () => {
    expect(normalizeTitle("tokyo trip")).toBe("tokyo trip");
  });
});

describe("findDuplicateTrip (SHAN-514)", () => {
  const match = {
    slug: "europe-trip",
    title: "Europe Trip",
    createdAt: new Date("2026-05-24T05:15:31.501Z"),
  };

  it("returns the matching trip", async () => {
    mockSelect.mockReturnValue(chain([match]));

    const found = await findDuplicateTrip({ title: "Europe Trip", html: "<h1>Europe</h1>" });

    expect(found).toEqual(match);
  });

  it("returns null when nothing matches", async () => {
    mockSelect.mockReturnValue(chain([]));

    const found = await findDuplicateTrip({ title: "Brand New", html: "<h1>New</h1>" });

    expect(found).toBeNull();
  });

  it("matches on both the title and the html hash when a title is present", async () => {
    mockSelect.mockReturnValue(chain([]));

    await findDuplicateTrip({ title: "Europe Trip", html: "<h1>Europe</h1>" });

    expect((or as any).mock.calls[0]).toHaveLength(2);
  });

  it("matches on the html hash alone when the title is null", async () => {
    mockSelect.mockReturnValue(chain([]));

    await findDuplicateTrip({ title: null, html: "<h1>Europe</h1>" });

    // An untitled upload is not an identity — only identical bytes count.
    expect((or as any).mock.calls[0]).toHaveLength(1);
  });

  it("does not build a title arm for a whitespace-only title", async () => {
    mockSelect.mockReturnValue(chain([]));

    await findDuplicateTrip({ title: "   ", html: "<h1>Europe</h1>" });

    expect((or as any).mock.calls[0]).toHaveLength(1);
  });
});
