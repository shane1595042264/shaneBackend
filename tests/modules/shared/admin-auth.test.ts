import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import { isAdminAuthed, isBearerAuthed } from "@/modules/shared/admin-auth";

/** Minimal Context stub exposing only the Authorization header. */
function ctx(authHeader?: string): Context {
  return {
    req: { header: (name: string) => (name === "Authorization" ? authHeader : undefined) },
  } as unknown as Context;
}

describe("isAdminAuthed (fail-closed admin guard)", () => {
  const original = process.env.ADMIN_TOKEN;

  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = original;
  });

  it("denies when ADMIN_TOKEN is unset, even with a Bearer header (the SHAN-345 bug)", () => {
    expect(isAdminAuthed(ctx("Bearer anything"))).toBe(false);
    expect(isAdminAuthed(ctx(undefined))).toBe(false);
  });

  it("denies when ADMIN_TOKEN is set but the header is missing or wrong", () => {
    process.env.ADMIN_TOKEN = "secret123";
    expect(isAdminAuthed(ctx(undefined))).toBe(false);
    expect(isAdminAuthed(ctx("Bearer wrong"))).toBe(false);
    expect(isAdminAuthed(ctx("secret123"))).toBe(false); // missing "Bearer " prefix
  });

  it("allows when ADMIN_TOKEN is set and the Bearer token matches", () => {
    process.env.ADMIN_TOKEN = "secret123";
    expect(isAdminAuthed(ctx("Bearer secret123"))).toBe(true);
  });
});

describe("isBearerAuthed (generic fail-closed guard)", () => {
  const original = process.env.SHAN572_TEST_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.SHAN572_TEST_TOKEN;
    else process.env.SHAN572_TEST_TOKEN = original;
  });

  it("denies when the variable is unset or empty", () => {
    delete process.env.SHAN572_TEST_TOKEN;
    expect(isBearerAuthed(ctx("Bearer "), "SHAN572_TEST_TOKEN")).toBe(false);
    expect(isBearerAuthed(ctx("Bearer undefined"), "SHAN572_TEST_TOKEN")).toBe(false);
    process.env.SHAN572_TEST_TOKEN = "";
    expect(isBearerAuthed(ctx("Bearer "), "SHAN572_TEST_TOKEN")).toBe(false);
  });

  it("denies a wrong token of the same length, and a prefix of the right one", () => {
    process.env.SHAN572_TEST_TOKEN = "abc123";
    expect(isBearerAuthed(ctx("Bearer abc124"), "SHAN572_TEST_TOKEN")).toBe(false);
    expect(isBearerAuthed(ctx("Bearer abc12"), "SHAN572_TEST_TOKEN")).toBe(false);
  });

  it("allows the matching Bearer token", () => {
    process.env.SHAN572_TEST_TOKEN = "abc123";
    expect(isBearerAuthed(ctx("Bearer abc123"), "SHAN572_TEST_TOKEN")).toBe(true);
  });
});
