import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  date,
  integer,
  serial,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";

// Custom pgvector column type
const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dimensions = (config as { dimensions?: number })?.dimensions ?? 1536;
    return `vector(${dimensions})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

// ------------------------------------------------------------------
// activities
// ------------------------------------------------------------------
export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    type: varchar("type", { length: 100 }).notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("activities_date_source_type_data_unique").on(t.date, t.source, t.type, t.data)]
);

// ------------------------------------------------------------------
// diary_entries
// ------------------------------------------------------------------
export const diaryEntries = pgTable(
  "diary_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    date: date("date").notNull().unique(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 } as never),
    voiceProfileVersion: integer("voice_profile_version"),
    generationMetadata: jsonb("generation_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("diary_entries_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
  ]
);

// ------------------------------------------------------------------
// summaries
// ------------------------------------------------------------------
export const summaries = pgTable(
  "summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    level: varchar("level", { length: 20 }).notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 } as never),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("summaries_level_start_date_end_date_unique").on(t.level, t.startDate, t.endDate),
    index("summaries_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
  ]
);

// ------------------------------------------------------------------
// voice_profiles
// ------------------------------------------------------------------
export const voiceProfiles = pgTable("voice_profiles", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull().unique(),
  profileText: text("profile_text").notNull(),
  derivedFrom: jsonb("derived_from"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ------------------------------------------------------------------
// corrections
// ------------------------------------------------------------------
export const corrections = pgTable("corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id")
    .notNull()
    .references(() => diaryEntries.id, { onDelete: "cascade" }),
  suggestionText: text("suggestion_text").notNull(),
  originalContent: text("original_content").notNull(),
  correctedContent: text("corrected_content"),
  extractedFacts: jsonb("extracted_facts"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ------------------------------------------------------------------
// learned_facts
// ------------------------------------------------------------------
export const learnedFacts = pgTable(
  "learned_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factText: text("fact_text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 } as never),
    sourceCorrectionId: uuid("source_correction_id").references(
      () => corrections.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("learned_facts_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
  ]
);

// ------------------------------------------------------------------
// element_config
// ------------------------------------------------------------------
export const elementConfig = pgTable("element_config", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 3 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  category: varchar("category", { length: 50 }),
  rowPos: integer("row_pos"),
  colPos: integer("col_pos"),
  type: varchar("type", { length: 20 }).notNull().default("internal"),
  route: varchar("route", { length: 255 }),
  url: varchar("url", { length: 512 }),
  status: varchar("status", { length: 30 }).notNull().default("coming-soon"),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
