import { describe, it, expect } from "vitest";
import { applyItemDelta, isItemDelta } from "@/modules/trip-groups/section-items";

const item = (id: string, done = false) => ({ id, text: id, done, addedBy: null });

describe("applyItemDelta (SHAN-557)", () => {
  it("keeps a teammate's check when another member adds an item", () => {
    // Stored row already has Ava's check on passport; Shane's add must not undo it.
    const stored = [item("passport", true)];
    expect(applyItemDelta(stored, { addItems: [item("charger")] })).toEqual([
      item("passport", true),
      item("charger"),
    ]);
  });

  it("toggles only the named item", () => {
    const stored = [item("a"), item("b", true)];
    expect(applyItemDelta(stored, { setItemsDone: [{ id: "a", done: true }] })).toEqual([
      item("a", true),
      item("b", true),
    ]);
  });

  it("removes by id and ignores ids that are already gone", () => {
    const stored = [item("a"), item("b")];
    expect(applyItemDelta(stored, { removeItemIds: ["b", "ghost"] })).toEqual([item("a")]);
  });

  it("does not resurrect a removed item when toggling it", () => {
    expect(applyItemDelta([item("a")], { setItemsDone: [{ id: "gone", done: true }] })).toEqual([
      item("a"),
    ]);
  });

  it("skips an added id that already exists, so a retried add does not duplicate", () => {
    const stored = [item("a", true)];
    expect(applyItemDelta(stored, { addItems: [item("a"), item("b"), item("b")] })).toEqual([
      item("a", true),
      item("b"),
    ]);
  });

  it("removal wins over a toggle or add of the same id in one delta", () => {
    const stored = [item("a")];
    expect(
      applyItemDelta(stored, {
        removeItemIds: ["a", "b"],
        setItemsDone: [{ id: "a", done: true }],
        addItems: [item("b")],
      }),
    ).toEqual([]);
  });

  it("does not mutate the stored array", () => {
    const stored = [item("a")];
    applyItemDelta(stored, { setItemsDone: [{ id: "a", done: true }] });
    expect(stored).toEqual([item("a")]);
  });

  it("isItemDelta is true for any delta key, including an empty array", () => {
    expect(isItemDelta({})).toBe(false);
    expect(isItemDelta({ removeItemIds: [] })).toBe(true);
    expect(isItemDelta({ setItemsDone: [{ id: "a", done: true }] })).toBe(true);
  });
});
