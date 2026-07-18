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
