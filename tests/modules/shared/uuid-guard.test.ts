// tests/modules/shared/uuid-guard.test.ts
//
// SHAN-595: Postgres compares uuids case-insensitively and returns them
// lowercase, so an id that reaches handler code uppercase misses every JS
// comparison against a row id (`foundIds.has(id)`, `a === b`). Prod answered
// an uppercase id for a word that exists with 404 "Word not found". uuidId()
// lowercases at the boundary; this asserts it does, and that no route goes
// back to a raw z.string().uuid().
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { uuidId } from "@/modules/shared/validators";
import { parseKeysetCursor } from "@/modules/shared/keyset";

const ID = "652d5612-277e-47d2-b9ee-8564b5e4602f";

describe("uuidId", () => {
  it("lowercases an uppercase or mixed-case id", () => {
    expect(uuidId().parse(ID.toUpperCase())).toBe(ID);
    expect(uuidId().parse("652D5612-277e-47D2-b9ee-8564B5E4602F")).toBe(ID);
  });

  it("passes a lowercase id through unchanged", () => {
    expect(uuidId().parse(ID)).toBe(ID);
  });

  it("still rejects a non-uuid", () => {
    expect(uuidId().safeParse("not-a-uuid").success).toBe(false);
    expect(uuidId().safeParse("").success).toBe(false);
  });

  it("makes a duplicate that differs only by case visible to a Set", () => {
    // The scoreboard roster check: [id, ID] used to pass `new Set(...).size`.
    const ids = z.array(uuidId()).parse([ID, ID.toUpperCase()]);
    expect(new Set(ids).size).toBe(1);
  });

  it("composes with optional and nullable", () => {
    const schema = z.object({ id: uuidId().nullable().optional() });
    expect(schema.parse({ id: ID.toUpperCase() })).toEqual({ id: ID });
    expect(schema.parse({ id: null })).toEqual({ id: null });
    expect(schema.parse({})).toEqual({});
  });
});

describe("keyset cursor ids", () => {
  it("accepts an uppercase row id", () => {
    const cursor = parseKeysetCursor(`2026-10-18T00:00:00.000Z_${ID.toUpperCase()}`);
    expect(cursor?.id?.toLowerCase()).toBe(ID);
  });
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dirname, "..", "..", "..", "src");

// The helper is built from the raw validator; it is the definition of how.
const ALLOWED = new Set(["modules/shared/validators.ts"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("uuids are validated in one place", () => {
  it("no module uses a raw z.string().uuid()", () => {
    const raw = /z\s*\.\s*string\(\)\s*\.\s*uuid\(/;

    const offenders = tsFilesUnder(SRC_ROOT)
      .filter((f) => raw.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC_ROOT, f).split(sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel));

    // If this fails, swap the named file's z.string().uuid() for uuidId()
    // from "@/modules/shared/validators".
    expect(offenders).toEqual([]);
  });
});
