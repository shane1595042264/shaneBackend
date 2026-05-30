import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Prescription } from "./prescription-repo";

export interface GeneratorInput {
  userId: string;
  categoryFilter: string | null;
  n: number;
  includeSolidified: boolean;
}

export interface GeneratedItem {
  itemId: string;
  word: string;
  category: string;
  source: unknown;
  prescription: Pick<Prescription, "setMode" | "setSize" | "restSeconds">;
  loadedLocations: number;
  lastPracticedAt: Date | null;
}

/**
 * Single raw SQL — drizzle's relational query builder can't express the
 * CTEs cleanly. Returns picked items in least-recently-practiced order
 * with random tiebreak, skipping solidified items by default. Empty
 * array if nothing matches.
 */
export async function generateSessionItems(input: GeneratorInput): Promise<GeneratedItem[]> {
  const n = Math.max(1, Math.min(50, input.n));
  const result = await db.execute(sql`
    WITH thresholds AS (
      SELECT sets_per_strike, strikes_per_loaded_location, locations_to_solidify
      FROM practice_settings WHERE id = 1
    ),
    my_loaded_locations AS (
      SELECT psi.item_id, psi.location_id
      FROM practice_session_items psi
      JOIN practice_sessions ps ON ps.id = psi.session_id
      CROSS JOIN thresholds t
      WHERE ps.user_id = ${input.userId}
        AND psi.sets_completed >= t.sets_per_strike
        AND psi.location_id IS NOT NULL
      GROUP BY psi.item_id, psi.location_id
      HAVING COUNT(*) >= t.strikes_per_loaded_location
    ),
    my_loaded_per_item AS (
      SELECT item_id, COUNT(*)::int AS loaded_locations
      FROM my_loaded_locations
      GROUP BY item_id
    ),
    my_last_practiced AS (
      SELECT psi.item_id, MAX(psi.completed_at) AS last_at
      FROM practice_session_items psi
      JOIN practice_sessions ps ON ps.id = psi.session_id
      WHERE ps.user_id = ${input.userId}
      GROUP BY psi.item_id
    )
    SELECT v.id, v.word, v.category, v.source,
           p.set_mode, p.set_size, p.rest_seconds,
           COALESCE(mlpi.loaded_locations, 0) AS loaded_locations,
           mlp.last_at AS last_practiced_at
    FROM vocab_words v
    INNER JOIN practice_prescriptions p ON p.item_id = v.id
    LEFT JOIN my_loaded_per_item mlpi ON mlpi.item_id = v.id
    LEFT JOIN my_last_practiced mlp ON mlp.item_id = v.id
    CROSS JOIN thresholds t
    WHERE (${input.categoryFilter}::text IS NULL OR v.category = ${input.categoryFilter})
      AND (${input.includeSolidified} = true
           OR COALESCE(mlpi.loaded_locations, 0) < t.locations_to_solidify)
    ORDER BY mlp.last_at NULLS FIRST, random()
    LIMIT ${n}
  `);

  const rows = (result as { rows: any[] }).rows ?? [];
  return rows.map((r) => ({
    itemId: String(r.id),
    word: String(r.word),
    category: String(r.category),
    source: r.source,
    prescription: {
      setMode: r.set_mode as "time" | "reps",
      setSize: Number(r.set_size),
      restSeconds: Number(r.rest_seconds),
    },
    loadedLocations: Number(r.loaded_locations ?? 0),
    lastPracticedAt: r.last_practiced_at ? new Date(r.last_practiced_at) : null,
  }));
}
