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
