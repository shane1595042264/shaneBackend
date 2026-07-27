import { z } from "zod";

// Format check + calendar-validity check. The regex alone accepts month 13, Feb 30, day 99 —
// those slip through to Postgres and turn into 500s. Round-tripping through Date.UTC rejects
// any string whose components don't survive a calendar round trip. Introduced in SHAN-205 for
// journal routes; hoisted in SHAN-206 so admin/ingest, activities, and journal versionNumParam
// share one source of truth.
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m - 1 &&
      dt.getUTCDate() === d
    );
  }, "YYYY-MM-DD");

// SHAN-287: the markdown editor inserts `![alt](uploading-<rnd>-<ts>)` while an
// image upload is in flight, then swaps it for the real URL when the upload
// resolves. SHAN-264 gates the submit button client-side, but a PAT-using
// agent (or a future editor regression) can still POST content with the
// placeholder intact — the 2026-06-08 entry shipped that way. Reject server-
// side too. Pattern mirrors the token in markdown-editor.tsx (base36 + digits)
// but keeps the inner charset loose so it stays correct if the token shape
// changes.
export const IN_FLIGHT_UPLOAD_REGEX = /!\[[^\]]*\]\(uploading-[\w-]+\)/;
export const IN_FLIGHT_UPLOAD_MESSAGE =
  "Image upload is still in flight — wait for the upload to finish and try again.";

export function containsInFlightUpload(content: string): boolean {
  return IN_FLIGHT_UPLOAD_REGEX.test(content);
}

// SHAN-398 (follow-up to SHAN-396): journal/tea markdown bodies persist to
// unbounded Postgres `text` columns. Without a cap, a PAT agent or a client
// regression can POST a multi-MB blob per row — a storage-abuse / payload-DoS
// vector. 100k chars is generous for a full wiki-blog entry (~20k words) while
// blocking runaway payloads. The bound is additive: no previously-valid body
// (all well under 100k) breaks.
export const MAX_MARKDOWN_BODY = 100_000;
export const MAX_MARKDOWN_BODY_MESSAGE =
  "Content is too long (max 100,000 characters).";

// SHAN-433: a whitespace-only string ("   ") has non-zero length, so a bare
// `.min(1)` lets it through and it persists as blank padding — or, on the
// knowledge/vocabulary ingest paths, gets shipped to the LLM classifier and
// burns tokens on garbage. Trimming BEFORE the min check rejects it with a 400,
// the same posture as journal (SHAN-431), tea (SHAN-432), loans (SHAN-428) and
// trip-groups (SHAN-427). These helpers live here so the knowledge and
// vocabulary write paths — which persist the same vocabWords columns — stay in
// lockstep, extending the length-bound parity SHAN-401 pinned to trimming too.

// Required free-text: strip incidental leading/trailing whitespace, then reject
// an empty / whitespace-only value. `max` is applied to the trimmed length.
export const trimmedRequired = (max: number) => z.string().trim().min(1).max(max);

// Optional free-text: strip padding; a value that is empty after trimming is
// treated as "not provided" (-> undefined) so we never persist blank padding
// and a PATCH of "   " is a no-op for that column rather than clearing it. The
// `max` bound is applied to the raw value first (bounds-first, matching
// SHAN-396) so an oversized blob is still a 400 regardless of surrounding ws.
export const trimmedOptional = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const t = v.trim();
      return t.length ? t : undefined;
    });

// Optional-nullable provenance string: trim, and collapse an empty (or
// whitespace-only) value to null so an all-blank hint isn't persisted. Distinct
// from trimmedOptional in that an explicit null survives as null (the field is
// nullish, e.g. a source object whose caller cleared one attribute).
export const trimmedNullish = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      if (v === undefined || v === null) return v;
      const t = v.trim();
      return t.length ? t : null;
    });

// Optional array of short labels: trim each entry and drop any that are empty
// after trimming, so whitespace-only labels never persist. `maxLen` bounds each
// entry and `maxItems` the array size (SHAN-401 caps preserved).
export const trimmedLabels = (maxLen: number, maxItems: number) =>
  z
    .array(z.string().max(maxLen))
    .max(maxItems)
    .optional()
    .transform((v) => v?.map((s) => s.trim()).filter((s) => s.length > 0));
