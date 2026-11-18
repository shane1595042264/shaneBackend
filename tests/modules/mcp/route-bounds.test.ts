import { describe, it, expect, vi } from "vitest";
import type { ZodTypeAny } from "zod";

// SHAN-708: the typed tools' published bounds must be the routes' bounds. The
// tools replay a route, so a schema that is looser than the route turns a call
// the model was told is fine into an HTTP 400, and one that is stricter refuses
// a call the API would take. Importing the route modules pulls in the db client;
// nothing here queries it.
vi.mock("@/db/client", () => ({ db: {} }));

import { TOOLS_BY_NAME } from "@/modules/mcp/tools";
import { validate, type JsonSchema } from "@/modules/mcp/schema";
import { listQuery as journalListQuery, createBody, appendBody } from "@/modules/journal/routes";
import { listQuery as blogListQuery } from "@/modules/blog/routes";
import { wordsQuerySchema, sourceInputSchema } from "@/modules/knowledge/routes";

type Case = {
  tool: string;
  /** Property path inside the tool's inputSchema. "source|string" picks the anyOf string branch. */
  prop: string;
  route: ZodTypeAny;
  /** What the route receives for a given value of the property. */
  build: (v: string) => unknown;
};

const CASES: Case[] = [
  { tool: "journal_list", prop: "q", route: journalListQuery, build: (q) => ({ q }) },
  { tool: "journal_create", prop: "content", route: createBody, build: (content) => ({ date: "2026-01-01", content }) },
  { tool: "journal_append", prop: "content", route: appendBody, build: (content) => ({ content }) },
  { tool: "blog_list", prop: "q", route: blogListQuery, build: (q) => ({ q }) },
  { tool: "blog_list", prop: "tag", route: blogListQuery, build: (tag) => ({ tag }) },
  ...(["search", "category", "label", "language", "location"] as const).map((prop) => ({
    tool: "knowledge_search",
    prop,
    route: wordsQuerySchema,
    build: (v: string) => ({ [prop]: v }),
  })),
  { tool: "knowledge_add_note", prop: "source|string", route: sourceInputSchema, build: (v) => v },
  ...(["app", "book", "author", "location", "rawContext"] as const).map((field) => ({
    tool: "knowledge_add_note",
    prop: `source|object.${field}`,
    route: sourceInputSchema,
    build: (v: string) => ({ [field]: v }),
  })),
];

function propSchema(tool: string, prop: string): JsonSchema {
  const [head, rest] = prop.split("|");
  let s = TOOLS_BY_NAME.get(tool)!.inputSchema.properties![head];
  if (rest) {
    const [branch, field] = rest.split(".");
    s = (s as { anyOf: readonly JsonSchema[] }).anyOf.find((b) => "type" in b && b.type === branch)!;
    if (field) s = (s as { properties: Record<string, JsonSchema> }).properties[field];
  }
  return s;
}

describe("typed tool bounds match the routes they replay", () => {
  it.each(CASES.map((c) => [`${c.tool} ${c.prop}`, c] as const))("%s", (_label, c) => {
    const schema = propSchema(c.tool, c.prop);
    expect(schema && "type" in schema && schema.type === "string").toBe(true);
    const max = (schema as { maxLength?: number }).maxLength;
    expect(max, "every typed string input should publish a maxLength").toBeTypeOf("number");

    const atMax = "a".repeat(max!);
    const over = "a".repeat(max! + 1);
    expect(validate(schema, atMax)).toEqual([]);
    expect(c.route.safeParse(c.build(atMax)).success, `route rejects ${max} chars the tool allows`).toBe(true);
    expect(c.route.safeParse(c.build(over)).success, `route accepts ${max! + 1} chars the tool refuses`).toBe(false);
  });
});
