import { generateText } from "@/modules/shared/llm";
import { embed } from "@/modules/shared/embeddings";
import { findSimilarEntries, findRelevantFacts } from "@/modules/shared/vector-search";
import { getLatestVoiceProfile } from "@/modules/journal/voice-profile";
import { db } from "@/db/client";
import { activities, diaryEntries, summaries } from "@/db/schema";
import type { NormalizedActivity } from "@/modules/integrations/types";
import { batchReverseGeocode } from "@/modules/integrations/geocode";
import { eq, desc, and, lte, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationContext {
  date: string;
  activitiesText: string;
  yearlySummary: string | null;
  monthlySummary: string | null;
  weeklySummary: string | null;
  yesterdayEntry: string | null;
  similarEntries: Array<{ date: string; content: string }>;
  relevantFacts: string[];
}

// ---------------------------------------------------------------------------
// Location ping clustering
// ---------------------------------------------------------------------------

export interface LocationCluster {
  centroidLat: number;
  centroidLon: number;
  startTime: string;
  endTime: string;
  pingCount: number;
  durationMinutes: number;
}

/**
 * Haversine distance between two lat/lon points in meters.
 */
function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cluster consecutive location pings that are within `radiusMeters` of the
 * running centroid into distinct stops. Returns clusters sorted by start time,
 * filtered to stops where the user spent at least `minMinutes`.
 */
export function clusterLocationPings(
  pings: NormalizedActivity[],
  radiusMeters = 200,
  minMinutes = 5
): LocationCluster[] {
  if (pings.length === 0) return [];

  // Sort by timestamp
  const sorted = [...pings].sort(
    (a, b) =>
      new Date(a.data.timestamp as string).getTime() -
      new Date(b.data.timestamp as string).getTime()
  );

  const clusters: LocationCluster[] = [];
  let clusterLats = [sorted[0].data.latitude as number];
  let clusterLons = [sorted[0].data.longitude as number];
  let clusterStart = sorted[0].data.timestamp as string;
  let clusterEnd = sorted[0].data.timestamp as string;

  for (let i = 1; i < sorted.length; i++) {
    const lat = sorted[i].data.latitude as number;
    const lon = sorted[i].data.longitude as number;
    const centroidLat = clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length;
    const centroidLon = clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length;

    if (haversineMeters(centroidLat, centroidLon, lat, lon) <= radiusMeters) {
      // Same cluster
      clusterLats.push(lat);
      clusterLons.push(lon);
      clusterEnd = sorted[i].data.timestamp as string;
    } else {
      // Finalize previous cluster
      const dur =
        (new Date(clusterEnd).getTime() - new Date(clusterStart).getTime()) /
        60_000;
      clusters.push({
        centroidLat: clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length,
        centroidLon: clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length,
        startTime: clusterStart,
        endTime: clusterEnd,
        pingCount: clusterLats.length,
        durationMinutes: Math.round(dur),
      });
      // Start new cluster
      clusterLats = [lat];
      clusterLons = [lon];
      clusterStart = sorted[i].data.timestamp as string;
      clusterEnd = sorted[i].data.timestamp as string;
    }
  }

  // Finalize last cluster
  const dur =
    (new Date(clusterEnd).getTime() - new Date(clusterStart).getTime()) /
    60_000;
  clusters.push({
    centroidLat: clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length,
    centroidLon: clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length,
    startTime: clusterStart,
    endTime: clusterEnd,
    pingCount: clusterLats.length,
    durationMinutes: Math.round(dur),
  });

  return clusters.filter((c) => c.durationMinutes >= minMinutes);
}

// ---------------------------------------------------------------------------
// Calendar event filtering
// ---------------------------------------------------------------------------

const PLACEHOLDER_TITLES = new Set([
  "untitled",
  "untitled event",
  "placeholder",
  "(no title)",
  "busy",
  "no title",
]);

/**
 * Returns true if a calendar event has no meaningful title (placeholder/empty).
 */
export function isPlaceholderCalendarEvent(act: NormalizedActivity): boolean {
  if (act.source !== "google_calendar") return false;
  const title = ((act.data.title as string) ?? (act.data.summary as string) ?? "").trim();
  return title === "" || PLACEHOLDER_TITLES.has(title.toLowerCase());
}

/**
 * Detect data quality issues in activities for debug notes.
 * Returns an array of human-readable issue descriptions.
 */
export function detectActivityDataIssues(acts: NormalizedActivity[]): string[] {
  const issues: string[] = [];

  const calendarEvents = acts.filter((a) => a.source === "google_calendar");
  const placeholders = calendarEvents.filter(isPlaceholderCalendarEvent);

  if (placeholders.length > 0) {
    issues.push(
      `${placeholders.length} calendar event(s) had no meaningful title and were excluded from journal generation. ` +
      `This may indicate a non-public calendar or events from a different account.`
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// formatActivitiesForPrompt
// ---------------------------------------------------------------------------

/**
 * Formats a list of NormalizedActivity records grouped by source into a
 * human-readable text block suitable for inclusion in a generation prompt.
 * Async because location pings may need reverse geocoding.
 */
export async function formatActivitiesForPrompt(
  acts: NormalizedActivity[],
  date: string
): Promise<string> {
  if (acts.length === 0) {
    return `No activities recorded for ${date}.`;
  }

  const bySource: Record<string, NormalizedActivity[]> = {
    google_maps: [],
    strava: [],
    github: [],
    google_calendar: [],
    twitch: [],
    wechat: [],
  };

  for (const act of acts) {
    if (bySource[act.source]) {
      bySource[act.source].push(act);
    }
  }

  const sections: string[] = [];

  // --- Locations (Google Maps / OwnTracks) ---
  if (bySource.google_maps.length > 0) {
    const placeVisits = bySource.google_maps.filter((a) => a.type === "place_visit" || a.type === "visit");
    const placeEvents = bySource.google_maps.filter((a) => a.type === "place_enter" || a.type === "place_leave");
    const locationPings = bySource.google_maps.filter((a) => a.type === "location_ping");

    const lines: string[] = [];

    // Named place visits (from Google Takeout)
    for (const a of placeVisits) {
      const name = (a.data.name as string) ?? "Unknown place";
      const address = a.data.address ? ` (${a.data.address as string})` : "";
      lines.push(`  - ${name}${address}`);
    }

    // Waypoint transitions from OwnTracks (entered/left named places)
    for (const a of placeEvents) {
      const name = (a.data.name as string) ?? "Unknown place";
      const event = a.type === "place_enter" ? "Arrived at" : "Left";
      const time = new Date(a.data.timestamp as string).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`  - ${event} ${name} at ${time}`);
    }

    // Raw location pings — cluster into stops and reverse geocode
    if (locationPings.length > 0 && placeVisits.length === 0 && placeEvents.length === 0) {
      const clusters = clusterLocationPings(locationPings);

      if (clusters.length > 0) {
        // Reverse geocode each cluster centroid (max 10 to respect rate limits)
        const toGeocode = clusters.slice(0, 10);
        const placeNames = await batchReverseGeocode(
          toGeocode.map((c) => ({ latitude: c.centroidLat, longitude: c.centroidLon }))
        );

        for (let i = 0; i < toGeocode.length; i++) {
          const c = toGeocode[i];
          const startFmt = new Date(c.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const endFmt = new Date(c.endTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const durLabel =
            c.durationMinutes >= 60
              ? `${Math.floor(c.durationMinutes / 60)}h ${c.durationMinutes % 60}m`
              : `${c.durationMinutes}m`;
          lines.push(`  - ${placeNames[i]} (${startFmt}–${endFmt}, ${durLabel})`);
        }
      } else {
        // All pings were transient (no stops >= 5 min) — brief summary
        lines.push(`  - Moved through the area without extended stops`);
      }
    }

    if (lines.length > 0) {
      sections.push(`Locations:\n${lines.join("\n")}`);
    }
  }

  // --- Workouts (Strava) ---
  if (bySource.strava.length > 0) {
    const lines = bySource.strava.map((a) => {
      const name = (a.data.name as string) ?? a.type;
      const km =
        a.data.distance_km !== undefined
          ? ` — ${(a.data.distance_km as number).toFixed(1)} km`
          : "";
      const secs = a.data.duration_seconds as number | undefined;
      const time =
        secs !== undefined
          ? ` in ${Math.floor(secs / 60)}m ${secs % 60}s`
          : "";
      return `  - ${name}${km}${time}`;
    });
    sections.push(`Workouts / exercise (Strava):\n${lines.join("\n")}`);
  }

  // --- Commits (GitHub) ---
  if (bySource.github.length > 0) {
    const lines = bySource.github.map((a) => {
      const repo = (a.data.repo as string) ?? "unknown repo";
      const message = (a.data.message as string) ?? "(no message)";
      return `  - [${repo}] ${message}`;
    });
    sections.push(`Code commits (GitHub):\n${lines.join("\n")}`);
  }

  // --- Calendar events (Google Calendar) ---
  if (bySource.google_calendar.length > 0) {
    const meaningful = bySource.google_calendar.filter(
      (a) => !isPlaceholderCalendarEvent(a)
    );
    if (meaningful.length > 0) {
      const lines = meaningful.map((a) => {
        const title = (a.data.title as string) ?? (a.data.summary as string) ?? "Untitled event";
        const start = (a.data.startTime ?? a.data.start) as string | undefined;
        const end = (a.data.endTime ?? a.data.end) as string | undefined;
        const startStr = start ? ` at ${start}` : "";
        const endStr = end ? `–${end}` : "";
        return `  - ${title}${startStr}${endStr}`;
      });
      sections.push(`Calendar events (Google Calendar):\n${lines.join("\n")}`);
    }
  }

  // --- Streams (Twitch) ---
  if (bySource.twitch.length > 0) {
    const lines = bySource.twitch.map((a) => {
      const title = (a.data.title as string) ?? "Untitled stream";
      const secs = a.data.durationSeconds as number | undefined;
      const duration =
        secs !== undefined
          ? ` — ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
          : "";
      const views =
        a.data.viewCount !== undefined
          ? ` (${a.data.viewCount} views)`
          : "";
      return `  - ${title}${duration}${views}`;
    });
    sections.push(`Streams (Twitch):\n${lines.join("\n")}`);
  }

  // --- Messages (WeChat) ---
  if (bySource.wechat.length > 0) {
    // Group by chat, summarize message counts and key content
    const byChat: Record<string, NormalizedActivity[]> = {};
    for (const a of bySource.wechat) {
      const chat = (a.data.chat as string) ?? "Unknown";
      if (!byChat[chat]) byChat[chat] = [];
      byChat[chat].push(a);
    }

    const lines: string[] = [];
    for (const [chat, msgs] of Object.entries(byChat)) {
      const selfMsgs = msgs.filter((m) => m.data.sender === "self");
      const otherMsgs = msgs.filter((m) => m.data.sender !== "self");

      // Show a summary line per chat
      const parts: string[] = [`${msgs.length} messages in "${chat}"`];
      if (selfMsgs.length > 0) parts.push(`sent ${selfMsgs.length}`);
      if (otherMsgs.length > 0) parts.push(`received ${otherMsgs.length}`);
      lines.push(`  - ${parts.join(", ")}`);

      // Include up to 5 of Shane's own messages as content highlights
      const highlights = selfMsgs.slice(0, 5);
      for (const h of highlights) {
        const content = (h.data.content as string) ?? "";
        const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
        lines.push(`    > "${preview}"`);
      }
    }
    sections.push(`Messages (WeChat):\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// buildGenerationPrompt
// ---------------------------------------------------------------------------

/**
 * Assembles all context layers into a single generation prompt for Claude.
 */
export function buildGenerationPrompt(ctx: GenerationContext): string {
  const parts: string[] = [];

  parts.push(`You are writing a personal journal entry for ${ctx.date}.`);

  // Activities
  parts.push(`## Today's Activities\n${ctx.activitiesText}`);

  // Summaries
  if (ctx.yearlySummary) {
    parts.push(`## Yearly Context\n${ctx.yearlySummary}`);
  }
  if (ctx.monthlySummary) {
    parts.push(`## Monthly Context\n${ctx.monthlySummary}`);
  }
  if (ctx.weeklySummary) {
    parts.push(`## Weekly Context\n${ctx.weeklySummary}`);
  }

  // Yesterday's entry
  if (ctx.yesterdayEntry) {
    parts.push(`## Yesterday's Entry\n${ctx.yesterdayEntry}`);
  }

  // Similar past entries
  if (ctx.similarEntries.length > 0) {
    const entriesBlock = ctx.similarEntries
      .map((e) => `### ${e.date}\n${e.content}`)
      .join("\n\n");
    parts.push(`## Similar Past Entries\n${entriesBlock}`);
  }

  // Relevant facts
  if (ctx.relevantFacts.length > 0) {
    const factsBlock = ctx.relevantFacts.map((f) => `- ${f}`).join("\n");
    parts.push(`## Relevant Facts About Me\n${factsBlock}`);
  }

  // Final instruction
  parts.push(
    `## Instruction
Write a SHORT journal entry for ${ctx.date}. Rules:
1. ONE sentence per data category (workout, commits, locations, calendar, streams, messages). Connect them naturally into one paragraph.
2. Keep it under 100 words total. The DATA is the point, not the story.
3. When referencing specific data, wrap it in [[data:TYPE|DISPLAY|RAW]] markers so the frontend can make it interactive. Examples:
   - [[data:strava|ran 5.2km in 24:32|{"distance_km":5.2,"duration":"24:32","type":"run"}]]
   - [[data:github|pushed 3 commits to PersonalWebsite|{"count":3,"repo":"PersonalWebsite"}]]
   - [[data:location|spent the afternoon in Midtown|{"name":"Midtown","duration_min":180}]]
   - [[data:calendar|had a team standup at 10am|{"title":"Team standup","time":"10:00"}]]
   - [[data:twitch|streamed for 3 hours playing Valorant|{"title":"Ranked grind","duration_h":3,"views":42}]]
   - [[data:wechat|chatted with friends about weekend plans|{"chats":2,"messages_sent":8}]]
4. NEVER use em dashes (—). Use commas, periods, or "and" instead.
5. Write in first person, casual, human. Short sentences. No flowery metaphors.
6. Think of this as a data log with personality, not a literary essay.
7. If any data category has no meaningful content (e.g., no titled events), SKIP it entirely. Never mention "untitled" or "placeholder" events.`
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// generateDailyEntry
// ---------------------------------------------------------------------------

/**
 * Full pipeline: fetch context from DB, call Claude, embed result, store entry.
 */
export async function generateDailyEntry(
  date: string
): Promise<{ content: string; voiceProfileVersion: number }> {
  // 1. Get today's activities from DB
  const rawActivities = await db
    .select()
    .from(activities)
    .where(eq(activities.date, date));

  const todayActivities: NormalizedActivity[] = rawActivities.map((row) => ({
    date: row.date,
    source: row.source as NormalizedActivity["source"],
    type: row.type,
    data: row.data as Record<string, unknown>,
  }));

  // 2. Get latest voice profile
  const voiceProfile = await getLatestVoiceProfile();
  const voiceProfileVersion = voiceProfile?.version ?? 0;
  const systemPrompt =
    voiceProfile?.profileText ??
    "You are a thoughtful diarist writing personal journal entries in first person.";

  // 3. Get summaries (yearly, monthly, weekly)
  const [yearStart, yearEnd] = getYearRange(date);
  const [monthStart, monthEnd] = getMonthRange(date);
  const [weekStart, weekEnd] = getWeekRange(date);

  const [yearlyRows, monthlyRows, weeklyRows] = await Promise.all([
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "yearly"),
          eq(summaries.startDate, yearStart),
          eq(summaries.endDate, yearEnd)
        )
      )
      .limit(1),
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "monthly"),
          eq(summaries.startDate, monthStart),
          eq(summaries.endDate, monthEnd)
        )
      )
      .limit(1),
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "weekly"),
          eq(summaries.startDate, weekStart),
          eq(summaries.endDate, weekEnd)
        )
      )
      .limit(1),
  ]);

  const yearlySummary = yearlyRows[0]?.content ?? null;
  const monthlySummary = monthlyRows[0]?.content ?? null;
  const weeklySummary = weeklyRows[0]?.content ?? null;

  // 4. Get yesterday's entry
  const yesterday = getYesterday(date);
  const yesterdayRows = await db
    .select({ content: diaryEntries.content })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, yesterday))
    .limit(1);
  const yesterdayEntry = yesterdayRows[0]?.content ?? null;

  // 5. Vector search for 5 similar entries (excluding today)
  const activitiesText = await formatActivitiesForPrompt(todayActivities, date);
  const queryEmbedding = await embed(activitiesText);

  const similarRows = await findSimilarEntries(queryEmbedding, 5, date);
  const similarEntries = (
    similarRows as Array<{ date: string; content: string }>
  ).map((row) => ({ date: row.date, content: row.content }));

  // 6. Vector search for relevant facts
  const factRows = await findRelevantFacts(queryEmbedding, 5);
  const relevantFacts = (
    factRows as Array<{ fact_text: string }>
  ).map((row) => row.fact_text);

  // 7. Detect data quality issues for debug notes
  const debugNotes = detectActivityDataIssues(todayActivities);

  // 8. Build prompt
  const ctx: GenerationContext = {
    date,
    activitiesText,
    yearlySummary,
    monthlySummary,
    weeklySummary,
    yesterdayEntry,
    similarEntries,
    relevantFacts,
  };
  const prompt = buildGenerationPrompt(ctx);

  // 9. Call Claude Sonnet with voice profile as system prompt
  const { text: content } = await generateText({
    system: systemPrompt,
    prompt,
    model: "claude-sonnet-4-20250514",
    maxTokens: 2048,
  });

  // 10. Embed the result, store in diary_entries
  const contentEmbedding = await embed(content);

  const metadata: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    generatedAt: new Date().toISOString(),
    activitiesCount: todayActivities.length,
  };
  if (debugNotes.length > 0) {
    metadata.debugNotes = debugNotes;
  }

  await db
    .insert(diaryEntries)
    .values({
      date,
      content,
      embedding: contentEmbedding,
      voiceProfileVersion,
      generationMetadata: metadata,
    })
    .onConflictDoUpdate({
      target: diaryEntries.date,
      set: {
        content,
        embedding: contentEmbedding,
        voiceProfileVersion,
        updatedAt: new Date(),
      },
    });

  return { content, voiceProfileVersion };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getYesterday(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getYearRange(date: string): [string, string] {
  const year = date.slice(0, 4);
  return [`${year}-01-01`, `${year}-12-31`];
}

function getMonthRange(date: string): [string, string] {
  const [year, month] = date.split("-");
  const start = `${year}-${month}-01`;
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  return [start, end];
}

function getWeekRange(date: string): [string, string] {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [
    monday.toISOString().slice(0, 10),
    sunday.toISOString().slice(0, 10),
  ];
}
