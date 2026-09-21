import { describe, expect, it } from "vitest";
import {
  encodeKeysetCursor,
  keysetBefore,
  keysetCursorParam,
  parseKeysetCursor,
} from "@/modules/shared/keyset";
import { trips } from "@/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();
const compile = (sql: ReturnType<typeof keysetBefore>) => dialect.sqlToQuery(sql);

const ID = "5269f919-dfae-4d7a-9320-0036f2554ab0";
const ISO = "2026-05-24T21:32:37.484Z";

describe("encodeKeysetCursor", () => {
  it("joins the ISO timestamp and the row id with an underscore", () => {
    expect(encodeKeysetCursor(new Date(ISO), ID)).toBe(`${ISO}_${ID}`);
  });

  it("accepts a timestamp that already came back as a string", () => {
    expect(encodeKeysetCursor(ISO, ID)).toBe(`${ISO}_${ID}`);
  });

  it("round-trips through parseKeysetCursor", () => {
    const parsed = parseKeysetCursor(encodeKeysetCursor(new Date(ISO), ID));
    expect(parsed?.id).toBe(ID);
    expect(parsed?.ts.toISOString()).toBe(ISO);
  });
});

describe("parseKeysetCursor", () => {
  it("parses the compound form", () => {
    expect(parseKeysetCursor(`${ISO}_${ID}`)).toEqual({ ts: new Date(ISO), id: ID });
  });

  it("parses a bare ISO cursor minted before SHAN-513", () => {
    expect(parseKeysetCursor(ISO)).toEqual({ ts: new Date(ISO), id: null });
  });

  it.each([
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
    ["not a timestamp", "banana"],
    ["a date without a time", "2026-05-24"],
    ["a timestamp with a non-uuid tail", `${ISO}_not-a-uuid`],
    ["a bare uuid", ID],
    ["an empty id half", `${ISO}_`],
  ])("rejects %s", (_label, raw) => {
    expect(parseKeysetCursor(raw as string | undefined | null)).toBeNull();
  });

  it("rejects a non-string without throwing", () => {
    expect(parseKeysetCursor(new Date(ISO) as unknown as string)).toBeNull();
  });
});

describe("keysetCursorParam", () => {
  it("accepts both cursor forms", () => {
    expect(keysetCursorParam.safeParse(`${ISO}_${ID}`).success).toBe(true);
    expect(keysetCursorParam.safeParse(ISO).success).toBe(true);
  });

  it("rejects a malformed cursor so the route can 400 instead of resurfacing page 1", () => {
    expect(keysetCursorParam.safeParse("banana").success).toBe(false);
    expect(keysetCursorParam.safeParse(`${ISO}_nope`).success).toBe(false);
  });
});

describe("keysetBefore", () => {
  it("falls back to a plain timestamp comparison for a legacy cursor", () => {
    const { sql, params } = compile(
      keysetBefore(trips.createdAt, trips.id, parseKeysetCursor(ISO)!),
    );
    expect(sql).toBe('"trips"."created_at" < $1');
    // drizzle's lt() runs the Date through the column's driver encoder, so the
    // bound value is the ISO string rather than the Date itself.
    expect(params).toEqual([ISO]);
  });

  it("compares the row key against the boundary row's stored key", () => {
    const { sql } = compile(
      keysetBefore(trips.createdAt, trips.id, parseKeysetCursor(`${ISO}_${ID}`)!),
    );
    // The subquery is what reads the boundary timestamp back at full
    // precision, and the alias is what stops it correlating with the outer
    // query. The coalesce is what keeps a deleted boundary row from ending
    // pagination early instead of comparing against NULL.
    expect(sql).toBe(
      '("trips"."created_at", "trips"."id") < ' +
        '(coalesce((select k."created_at" from "trips" k where k."id" = $1::uuid), $2::timestamptz), $3::uuid)',
    );
  });

  it("binds the cursor halves as parameters rather than inlining them", () => {
    const { params } = compile(
      keysetBefore(trips.createdAt, trips.id, parseKeysetCursor(`${ISO}_${ID}`)!),
    );
    expect(params).toEqual([ID, new Date(ISO), ID]);
  });
});
