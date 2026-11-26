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
 * SHAN-743: the server, not the client, says who added an item. An id the
 * section already holds keeps the addedBy it was stored with; any other id is
 * signed with the caller's name. Whatever addedBy the body carried is dropped,
 * so a member cannot add an item under someone else's name or re-sign theirs.
 */
export function attributeItems(
  incoming: SectionItem[],
  existing: SectionItem[],
  callerName: string | null,
): SectionItem[] {
  const storedBy = new Map(existing.map((i) => [i.id, i.addedBy]));
  return incoming.map((i) => ({
    ...i,
    addedBy: storedBy.has(i.id) ? storedBy.get(i.id)! : callerName,
  }));
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
