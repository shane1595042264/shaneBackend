import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — use vi.hoisted so variables are available when vi.mock factories run
// ---------------------------------------------------------------------------
const { mockSelect, mockInsert, mockUpdate } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
}));

vi.mock("@/db/schema", () => ({
  diaryEntries: {},
  activities: {},
  learnedFacts: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
  desc: vi.fn((col: unknown) => ({ col, direction: "desc" })),
  sql: vi.fn(),
}));

vi.mock("@/modules/journal/correction", () => ({
  generateCorrection: vi.fn(),
  finalizeSuggestion: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { journalRoutes } from "@/modules/journal/routes";
import { generateCorrection, finalizeSuggestion } from "@/modules/journal/correction";

// Build a test app with the routes mounted at /
const app = new Hono();
app.route("/", journalRoutes);

// Helper: build a chainable drizzle-like select mock that returns `rows`
function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const terminal = Promise.resolve(rows);
  for (const m of ["from", "where", "orderBy", "limit", "offset"]) {
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
// GET /entries
// ---------------------------------------------------------------------------
describe("GET /entries", () => {
  it("returns paginated entries with defaults (limit=20, offset=0)", async () => {
    const fakeEntries = [
      {
        date: "2026-03-20",
        content: "Had a good day",
        createdAt: new Date("2026-03-20T10:00:00Z"),
        updatedAt: new Date("2026-03-20T10:00:00Z"),
      },
    ];

    mockSelect
      .mockReturnValueOnce(makeSelectChain(fakeEntries))
      .mockReturnValueOnce(makeSelectChain([{ count: 1 }]));

    const res = await app.request("/entries");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("entries");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].date).toBe("2026-03-20");
    expect(body.total).toBe(1);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it("respects custom limit and offset query params", async () => {
    const fakeEntries = [
      {
        date: "2026-03-18",
        content: "Page 2 entry",
        createdAt: new Date("2026-03-18T10:00:00Z"),
        updatedAt: new Date("2026-03-18T10:00:00Z"),
      },
    ];

    mockSelect
      .mockReturnValueOnce(makeSelectChain(fakeEntries))
      .mockReturnValueOnce(makeSelectChain([{ count: 25 }]));

    const res = await app.request("/entries?limit=5&offset=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(10);
  });

  it("returns empty entries when offset exceeds total", async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ count: 3 }]));

    const res = await app.request("/entries?offset=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(0);
    expect(body.total).toBe(3);
  });

  it("clamps limit to max 100", async () => {
    mockSelect
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ count: 0 }]));

    const res = await app.request("/entries?limit=999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// GET /entries/:date
// ---------------------------------------------------------------------------
describe("GET /entries/:date", () => {
  it("returns entry + activities when entry exists", async () => {
    const fakeEntry = {
      date: "2026-03-20",
      content: "A nice day",
      createdAt: new Date("2026-03-20T10:00:00Z"),
      updatedAt: new Date("2026-03-20T10:00:00Z"),
    };
    const fakeActivities = [
      {
        id: "act-1",
        date: "2026-03-20",
        source: "google_calendar",
        type: "event",
        data: { title: "Standup" },
        createdAt: new Date("2026-03-20T09:00:00Z"),
      },
    ];

    // First call: entry query; second call: activities query
    mockSelect
      .mockReturnValueOnce(makeSelectChain([fakeEntry]))
      .mockReturnValueOnce(makeSelectChain(fakeActivities));

    const res = await app.request("/entries/2026-03-20");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("entry");
    expect(body.entry.date).toBe("2026-03-20");
    expect(body).toHaveProperty("activities");
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0].source).toBe("google_calendar");
  });

  it("returns 404 when entry is not found", async () => {
    mockSelect.mockReturnValue(makeSelectChain([]));

    const res = await app.request("/entries/1999-01-01");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// POST /entries/:date/suggest
// ---------------------------------------------------------------------------
describe("POST /entries/:date/suggest", () => {
  it("calls generateCorrection and returns correctedContent + extractedFacts", async () => {
    vi.mocked(generateCorrection).mockResolvedValue({
      correctedContent: "Corrected entry text",
      entryId: "entry-123",
      originalContent: "Original entry text",
    });
    vi.mocked(finalizeSuggestion).mockResolvedValue(undefined);

    const res = await app.request("/entries/2026-03-20/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestion: "I was with my sister" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.correctedContent).toBe("Corrected entry text");
    expect(body.extractedFacts).toEqual([]);
    expect(generateCorrection).toHaveBeenCalledWith("2026-03-20", "I was with my sister");
  });

  it("returns 400 when suggestion is missing", async () => {
    const res = await app.request("/entries/2026-03-20/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when suggestion is an empty string", async () => {
    const res = await app.request("/entries/2026-03-20/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ suggestion: "" }),
    });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /facts
// ---------------------------------------------------------------------------
describe("GET /facts", () => {
  it("returns { facts: [...] } with 200", async () => {
    const fakeFacts = [
      {
        id: "fact-1",
        factText: "Shane has a sister",
        createdAt: new Date("2026-03-20T10:00:00Z"),
      },
      {
        id: "fact-2",
        factText: "Shane likes coffee",
        createdAt: new Date("2026-03-19T10:00:00Z"),
      },
    ];

    mockSelect.mockReturnValue(makeSelectChain(fakeFacts));

    const res = await app.request("/facts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("facts");
    expect(Array.isArray(body.facts)).toBe(true);
    expect(body.facts).toHaveLength(2);
    expect(body.facts[0].factText).toBe("Shane has a sister");
  });
});
