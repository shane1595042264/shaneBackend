import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectFor, mockTransaction, mockSet, mockReturning } = vi.hoisted(() => ({
  mockSelectFor: vi.fn(),
  mockTransaction: vi.fn(),
  mockSet: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock("@/db/client", () => {
  // The delta write reads the row with .for("update") inside a transaction (SHAN-557).
  const select = () => ({ from: () => ({ where: () => ({ for: mockSelectFor }) }) });
  const update = () => ({
    set: (v: unknown) => {
      mockSet(v);
      return { where: () => ({ returning: mockReturning }) };
    },
  });
  return {
    db: {
      transaction: (fn: (tx: unknown) => unknown) => {
        mockTransaction();
        return fn({ select, update });
      },
    },
  };
});

import { applySectionItemDelta } from "@/modules/trip-groups/notes-sections-repo";

const item = (id: string, done = false) => ({ id, text: id, done, addedBy: null });
const row = (items: unknown[]) => ({
  id: "s1", groupId: "g1", createdBy: "u1", title: "Bring", kind: "todo", items,
  createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applySectionItemDelta (SHAN-557)", () => {
  it("merges onto the row read under FOR UPDATE, so a teammate's check survives", async () => {
    mockSelectFor.mockResolvedValue([{ items: [item("passport", true)] }]);
    mockReturning.mockImplementation(async () => [row(mockSet.mock.calls[0][0].items)]);

    const section = await applySectionItemDelta("s1", { addItems: [item("charger")] });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSelectFor).toHaveBeenCalledWith("update");
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ items: [item("passport", true), item("charger")] }),
    );
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty("title");
    expect(section).toMatchObject({ items: [item("passport", true), item("charger")] });
  });

  it("writes a title only when one was sent", async () => {
    mockSelectFor.mockResolvedValue([{ items: [] }]);
    mockReturning.mockResolvedValue([row([])]);
    await applySectionItemDelta("s1", { removeItemIds: ["x"] }, "Packing");
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ title: "Packing", items: [] }));
  });

  it("returns null without writing when the row is gone", async () => {
    mockSelectFor.mockResolvedValue([]);
    expect(await applySectionItemDelta("s1", { removeItemIds: ["x"] })).toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("returns too_many without writing when the merge passes 200 items", async () => {
    mockSelectFor.mockResolvedValue([{ items: Array.from({ length: 200 }, (_, i) => item(`i${i}`)) }]);
    expect(await applySectionItemDelta("s1", { addItems: [item("one-more")] })).toBe("too_many");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("treats a null items column as an empty list", async () => {
    mockSelectFor.mockResolvedValue([{ items: null }]);
    mockReturning.mockResolvedValue([row([item("a")])]);
    await applySectionItemDelta("s1", { addItems: [item("a")] });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ items: [item("a")] }));
  });
});
