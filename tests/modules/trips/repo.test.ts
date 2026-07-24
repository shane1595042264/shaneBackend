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
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  lt: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "lt" })),
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

import { createTrip, updateTripBySlug } from "@/modules/trips/repo";

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
