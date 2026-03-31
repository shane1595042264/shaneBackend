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
  boolean,
} from "drizzle-orm/pg-core";

// Custom pgvector column type
const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dimensions = (config as { dimensions?: number })?.dimensions ?? 384;
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
  (t) => [
    unique("activities_date_source_type_data_unique").on(t.date, t.source, t.type, t.data),
    index("activities_date_idx").on(t.date),
  ]
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
    embedding: vector("embedding", { dimensions: 384 } as never),
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
    embedding: vector("embedding", { dimensions: 384 } as never),
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
export const corrections = pgTable(
  "corrections",
  {
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
  },
  (t) => [index("corrections_entry_id_idx").on(t.entryId)]
);

// ------------------------------------------------------------------
// learned_facts
// ------------------------------------------------------------------
export const learnedFacts = pgTable(
  "learned_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    factText: text("fact_text").notNull(),
    embedding: vector("embedding", { dimensions: 384 } as never),
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

// ------------------------------------------------------------------
// rng_plaid_tokens
// ------------------------------------------------------------------
export const rngPlaidTokens = pgTable("rng_plaid_tokens", {
  id: serial("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  itemId: text("item_id").notNull(),
  institutionName: text("institution_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ------------------------------------------------------------------
// rng_monthly_spend
// ------------------------------------------------------------------
export const rngMonthlySpend = pgTable("rng_monthly_spend", {
  id: serial("id").primaryKey(),
  yearMonth: varchar("year_month", { length: 7 }).notNull().unique(),
  totalSpend: text("total_spend").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
});

// ------------------------------------------------------------------
// rng_decisions
// ------------------------------------------------------------------
export const rngDecisions = pgTable(
  "rng_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url"),
    productName: text("product_name").notNull(),
    price: text("price").notNull(),
    genericCategory: text("generic_category").notNull(),
    isEntertainment: boolean("is_entertainment").notNull(),
    avatarUrl: text("avatar_url"),
    balanceAtTime: text("balance_at_time"),
    remainingBudget: text("remaining_budget"),
    threshold: integer("threshold"),
    roll: integer("roll"),
    result: varchar("result", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("rng_decisions_created_at_idx").on(t.createdAt)]
);

// ------------------------------------------------------------------
// rng_ban_list
// ------------------------------------------------------------------
export const rngBanList = pgTable(
  "rng_ban_list",
  {
    id: serial("id").primaryKey(),
    genericCategory: text("generic_category").notNull(),
    bannedAt: timestamp("banned_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sourceDecisionId: uuid("source_decision_id").references(() => rngDecisions.id),
  },
  (t) => [index("rng_ban_list_expires_at_idx").on(t.expiresAt)]
);
