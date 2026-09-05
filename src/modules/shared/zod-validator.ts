import { zValidator as honoZValidator } from "@hono/zod-validator";
import type { Context } from "hono";

/**
 * `zValidator` that fails with the app's standard `{ error }` JSON envelope.
 *
 * SHAN-451: `@hono/zod-validator`'s default failure response is the raw
 * ZodError dump — `{"success":false,"error":{"issues":[...],"name":"ZodError"}}`
 * — which has no top-level `error` string. Every other error path in the app
 * (including `notFoundHandler` / `errorHandler` in `http-errors.ts`) returns
 * `{"error":"message"}`, so clients had to branch on two incompatible shapes
 * and any that only read `err.error` printed `[object Object]` or fell back to
 * a generic message. Import `zValidator` from here instead of from
 * `@hono/zod-validator` and every validated route returns one shape.
 *
 * The status stays 400 and the per-field zod messages are preserved verbatim,
 * so this is additive for anyone who was already reading them.
 */

/** How many issues get folded into the human-readable `error` summary. */
const SUMMARY_ISSUE_LIMIT = 5;

export interface ValidationIssue {
  /** Dot-joined field path (`"notes.0.text"`); omitted for object-level errors. */
  path?: string;
  message: string;
}

type RawIssue = { path?: PropertyKey[]; message?: string };

export function formatValidationIssues(error: unknown): ValidationIssue[] {
  const issues = (error as { issues?: RawIssue[] } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const path = (issue.path ?? []).map(String).join(".");
    const message = issue.message ?? "Invalid value";
    return path ? { path, message } : { message };
  });
}

function summarize(details: ValidationIssue[]): string {
  if (details.length === 0) return "Validation failed";
  const shown = details
    .slice(0, SUMMARY_ISSUE_LIMIT)
    .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
    .join("; ");
  const rest = details.length - SUMMARY_ISSUE_LIMIT;
  return `Validation failed: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/** Hook passed to `zValidator` whenever a call site doesn't supply its own. */
export function validationHook(
  result: { success: boolean; error?: unknown },
  c: Context
): Response | void {
  if (result.success) return;
  const details = formatValidationIssues(result.error);
  return c.json({ error: summarize(details), details }, 400);
}

// Cast keeps the exported signature identical to the upstream one, so the 2-arg
// call sites type-check exactly as they did before (no extra 400 response type
// leaks into route inference). A call site may still pass its own hook.
export const zValidator = ((target: any, schema: any, hook?: any, options?: any) =>
  (honoZValidator as any)(target, schema, hook ?? validationHook, options)) as typeof honoZValidator;
