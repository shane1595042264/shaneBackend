import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted so variables are available when vi.mock factories run
// ---------------------------------------------------------------------------
const { mockSelect, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));

vi.mock("@/db/schema", () => ({
  elementConfig: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { elementRoutes } from "@/modules/elements/routes";

const app = new Hono();
app.route("/", elementRoutes);

// Helper: chainable drizzle select-like mock
function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const terminal = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  Object.assign(chain, {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      terminal.then(res, rej),
    catch: (rej: (e: unknown) => unknown) => terminal.catch(rej),
    finally: (fn: () => void) => terminal.finally(fn),
  });
  return chain;
}

// Helper: chainable drizzle update-like mock
function makeUpdateChain(rows: unknown[]) {
  const terminal = Promise.resolve(rows);
  const chain: Record<string, unknown> = {};
  for (const m of ["set", "where", "returning"]) {
    chain[m] = vi.fn(() => chain);
  }
  Object.assign(chain, {
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      terminal.then(res, rej),
    catch: (rej: (e: unknown) => unknown) => terminal.catch(rej),
    finally: (fn: () => void) => terminal.finally(fn),
  });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------
describe("GET /elements", () => {
  it("returns { elements: [...] } with 200", async () => {
    const fakeElements = [
      {
        id: 1,
        symbol: "Jo",
        name: "Journal",
        category: "apps",
        type: "internal",
        route: "/journal",
        url: null,
        status: "active",
        description: "Daily journal",
        updatedAt: new Date("2026-03-20T10:00:00Z"),
      },
      {
        id: 2,
        symbol: "Gh",
        name: "GitHub",
        category: "external",
        type: "external",
        route: null,
        url: "https://github.com",
        status: "active",
        description: "Code repositories",
        updatedAt: new Date("2026-03-20T10:00:00Z"),
      },
    ];

    mockSelect.mockReturnValue(makeSelectChain(fakeElements));

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("elements");
    expect(Array.isArray(body.elements)).toBe(true);
    expect(body.elements).toHaveLength(2);
    expect(body.elements[0].symbol).toBe("Jo");
    expect(body.elements[1].symbol).toBe("Gh");
  });

  it("returns empty array when no elements exist", async () => {
    mockSelect.mockReturnValue(makeSelectChain([]));

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.elements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PUT /:symbol
// ---------------------------------------------------------------------------
describe("PUT /elements/:symbol", () => {
  it("updates and returns element when found", async () => {
    const updatedElement = {
      id: 1,
      symbol: "Jo",
      name: "Journal Updated",
      status: "active",
      updatedAt: new Date("2026-03-26T10:00:00Z"),
    };

    mockSelect.mockReturnValue(makeSelectChain([{ id: 1 }]));
    mockUpdate.mockReturnValue(makeUpdateChain([updatedElement]));

    const res = await app.request("/Jo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Journal Updated" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("element");
    expect(body.element.symbol).toBe("Jo");
    expect(body.element.name).toBe("Journal Updated");
  });

  it("returns 404 when element symbol is not found", async () => {
    mockSelect.mockReturnValue(makeSelectChain([]));

    const res = await app.request("/XX", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nonexistent" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
