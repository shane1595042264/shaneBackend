import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert },
}));
vi.mock("@/db/schema", () => ({
  journalActivity: {
    id: {},
    entryId: {},
    entryDate: {},
    action: {},
    targetType: {},
    targetId: {},
    actorId: {},
    actorTokenId: {},
    detail: {},
    createdAt: {},
  },
  users: { id: {}, name: {}, avatarUrl: {} },
  apiTokens: { id: {}, name: {} },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conds: unknown[]) => ({ and: conds })),
  desc: vi.fn((c: unknown) => ({ c, dir: "desc" })),
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
  lt: vi.fn((c: unknown, v: unknown) => ({ c, v, op: "lt" })),
}));

import {
  recordActivity,
  listActivity,
  listActivityForEntry,
} from "@/modules/journal/activity-repo";

beforeEach(() => vi.clearAllMocks());

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const promise = Promise.resolve(rows);
  for (const m of ["from", "leftJoin", "where", "orderBy", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
  return chain;
}

const baseRow = {
  id: "act1",
  entryId: "e1",
  entryDate: "2026-09-11",
  action: "append.delete",
  targetType: "append",
  targetId: "a1",
  actorId: "u1",
  actorTokenId: null,
  detail: null,
  createdAt: new Date("2026-09-11T10:00:00Z"),
  actorName: "Shane",
  actorAvatarUrl: null,
  agentName: null,
};

describe("recordActivity", () => {
  it("inserts one row with the actor and token", async () => {
    const values = vi.fn(() => Promise.resolve());
    mockInsert.mockReturnValue({ values });

    await recordActivity({
      entryId: "e1",
      entryDate: "2026-09-11",
      action: "append.delete",
      targetType: "append",
      targetId: "a1",
      actorId: "u1",
      actorTokenId: "tok1",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "e1",
        entryDate: "2026-09-11",
        action: "append.delete",
        targetType: "append",
        targetId: "a1",
        actorId: "u1",
        actorTokenId: "tok1",
      })
    );
  });

  it("defaults the optional fields to null rather than undefined", async () => {
    const values = vi.fn(() => Promise.resolve());
    mockInsert.mockReturnValue({ values });

    await recordActivity({
      entryId: null,
      entryDate: "2026-09-11",
      action: "entry.delete",
      targetType: "entry",
      actorId: "u1",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: null, actorTokenId: null, detail: null })
    );
  });

  // The audit trail is observability, not business state. A logging failure
  // must never turn a successful user write into a 500.
  it("swallows a DB failure instead of rejecting", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInsert.mockImplementation(() => {
      throw new Error("db is down");
    });

    await expect(
      recordActivity({
        entryId: "e1",
        entryDate: "2026-09-11",
        action: "append.create",
        targetType: "append",
        actorId: "u1",
      })
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("listActivity", () => {
  it("folds the joined user columns into a nested actor", async () => {
    mockSelect.mockReturnValue(selectChain([baseRow]));

    const rows = await listActivity({ limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toEqual({
      id: "u1",
      name: "Shane",
      avatarUrl: null,
      agent: null,
    });
    // Raw join columns must not leak into the response shape.
    expect((rows[0] as any).actorName).toBeUndefined();
    expect((rows[0] as any).agentName).toBeUndefined();
  });

  // This is the whole point of actor_token_id: a PAT write resolves to its
  // owner's user id, so without the token join an agent looks like the human.
  it("labels a PAT write with the agent token name", async () => {
    mockSelect.mockReturnValue(
      selectChain([{ ...baseRow, actorTokenId: "tok1", agentName: "jira-worker" }])
    );

    const rows = await listActivity({ limit: 50 });
    expect(rows[0].actor.agent).toEqual({ tokenId: "tok1", name: "jira-worker" });
  });

  // ON DELETE SET NULL on the token FK means a deleted token anonymizes the
  // agent label but never erases the fact that an agent did it.
  it("keeps the agent marker when the token name is gone", async () => {
    mockSelect.mockReturnValue(
      selectChain([{ ...baseRow, actorTokenId: "tok1", agentName: null }])
    );

    const rows = await listActivity({ limit: 50 });
    expect(rows[0].actor.agent).toEqual({ tokenId: "tok1", name: null });
  });

  it("never returns content bodies", async () => {
    mockSelect.mockReturnValue(selectChain([baseRow]));
    const rows = await listActivity({ limit: 50 });
    expect(Object.keys(rows[0])).not.toContain("content");
  });

  it("returns an empty list when there is no activity", async () => {
    mockSelect.mockReturnValue(selectChain([]));
    expect(await listActivity({ limit: 50 })).toEqual([]);
  });
});

describe("listActivityForEntry", () => {
  it("filters to the entry and shapes rows the same way", async () => {
    const chain = selectChain([baseRow]);
    mockSelect.mockReturnValue(chain);

    const rows = await listActivityForEntry("e1", { limit: 10 });
    expect(rows[0].entryId).toBe("e1");
    expect(chain.where).toHaveBeenCalled();
  });
});
