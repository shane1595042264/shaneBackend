// Item-level edits to a collaborative to-do section (SHAN-557).
import type { SectionItem } from "./notes-sections-repo";

export const MAX_SECTION_ITEMS = 200;

export interface SectionItemDelta {
  addItems?: SectionItem[];
  removeItemIds?: string[];
  setItemsDone?: { id: string; done: boolean }[];
}

export function isItemDelta(d: SectionItemDelta): boolean {
  return d.addItems !== undefined || d.removeItemIds !== undefined || d.setItemsDone !== undefined;
}

/**
 * Apply a delta to the items a section holds right now. Removals win over a
 * done toggle on the same id; a toggle or removal of an id that is already gone
 * (another member removed it) is a no-op; an added id that already exists is
 * skipped, so a retried add does not duplicate the row.
 */
export function applyItemDelta(existing: SectionItem[], delta: SectionItemDelta): SectionItem[] {
  const removed = new Set(delta.removeItemIds ?? []);
  const doneById = new Map((delta.setItemsDone ?? []).map((s) => [s.id, s.done]));
  const kept = existing
    .filter((i) => !removed.has(i.id))
    .map((i) => (doneById.has(i.id) ? { ...i, done: doneById.get(i.id)! } : i));
  const ids = new Set(kept.map((i) => i.id));
  for (const item of delta.addItems ?? []) {
    if (removed.has(item.id) || ids.has(item.id)) continue;
    ids.add(item.id);
    kept.push(item);
  }
  return kept;
}
