import {
  pgTable,
  pgEnum,
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
// users
// ------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    googleId: varchar("google_id", { length: 255 }).notNull().unique(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    // IANA TZ identifier the user posts in. Drives "today" calculation and
    // the [tz] tag shown to viewers in a different TZ.
    timezone: varchar("timezone", { length: 64 }).notNull().default("America/Chicago"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("users_google_id_idx").on(t.googleId)]
);

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
// legacy_diary_entries (formerly diary_entries — AI-generated archive, frozen)
// ------------------------------------------------------------------
export const diaryEntries = pgTable(
  "legacy_diary_entries",
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
    index("legacy_diary_entries_embedding_hnsw_idx")
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
// slot_assignments — maps periodic table atomic numbers to app IDs per user
// ------------------------------------------------------------------
export const slotAssignments = pgTable("slot_assignments", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  assignments: jsonb("assignments").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ------------------------------------------------------------------
// rng_plaid_tokens
// ------------------------------------------------------------------
export const rngPlaidTokens = pgTable("rng_plaid_tokens", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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
// vocab_words
// ------------------------------------------------------------------
export const vocabWords = pgTable(
  "vocab_words",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    word: varchar("word", { length: 255 }).notNull(),
    language: varchar("language", { length: 50 }).notNull(),
    category: varchar("category", { length: 100 }).notNull().default("vocabulary"),
    definition: text("definition"),
    pronunciation: varchar("pronunciation", { length: 255 }),
    partOfSpeech: varchar("part_of_speech", { length: 50 }),
    exampleSentence: text("example_sentence"),
    labels: jsonb("labels").default([]),
    aiMetadata: jsonb("ai_metadata"),
    source: jsonb("source"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("vocab_words_language_idx").on(t.language),
    index("vocab_words_created_at_idx").on(t.createdAt),
    index("vocab_words_category_idx").on(t.category),
    index("vocab_words_created_by_idx").on(t.createdBy),
  ]
);

// ------------------------------------------------------------------
// vocab_connections
// ------------------------------------------------------------------
export const vocabConnections = pgTable(
  "vocab_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromWordId: uuid("from_word_id")
      .notNull()
      .references(() => vocabWords.id, { onDelete: "cascade" }),
    toWordId: uuid("to_word_id")
      .notNull()
      .references(() => vocabWords.id, { onDelete: "cascade" }),
    connectionType: varchar("connection_type", { length: 50 }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("vocab_connections_from_idx").on(t.fromWordId),
    index("vocab_connections_to_idx").on(t.toWordId),
    unique("vocab_connections_unique").on(
      t.fromWordId,
      t.toWordId,
      t.connectionType
    ),
  ]
);

// ------------------------------------------------------------------
// knowledge_comments — wiki-style comment thread per vocab_words entry
// ------------------------------------------------------------------
export const knowledgeComments = pgTable(
  "knowledge_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => vocabWords.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    content: text("content").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("knowledge_comments_entry_idx").on(t.entryId)]
);

// ------------------------------------------------------------------
// rng_ban_list
// ------------------------------------------------------------------
export const rngBanList = pgTable(
  "rng_ban_list",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    genericCategory: text("generic_category").notNull(),
    bannedAt: timestamp("banned_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sourceDecisionId: uuid("source_decision_id").references(() => rngDecisions.id),
  },
  (t) => [index("rng_ban_list_expires_at_idx").on(t.expiresAt)]
);

// ───────────────────────────────────────────────────────────────────
// Journal pivot — collaborative blog tables
// ───────────────────────────────────────────────────────────────────

export const journalEntryStatusEnum = pgEnum("journal_entry_status", [
  "published",
  "trashed",
]);

export const versionSourceEnum = pgEnum("journal_version_source", [
  "direct",
  "suggestion",
  "revert",
]);

export const suggestionStatusEnum = pgEnum("journal_suggestion_status", [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

export const reactionEmojiEnum = pgEnum("reaction_emoji", [
  "+1",
  "-1",
  "laugh",
  "heart",
  "hooray",
  "rocket",
  "eyes",
  "confused",
]);

export const journalEntries = pgTable("journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  date: date("date").notNull().unique(),
  authorId: uuid("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  // Snapshot of the author's TZ at create-time. Used by viewers in a
  // different TZ to render a [tz] tag so the date isn't confusing.
  // Nullable: pre-migration rows have no snapshot — render with no tag.
  authorTimezone: varchar("author_timezone", { length: 64 }),
  currentVersionId: uuid("current_version_id"),
  status: journalEntryStatusEnum("status").notNull().default("published"),
  editCount: integer("edit_count").notNull().default(1),
  pendingSuggestionCount: integer("pending_suggestion_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journalVersions = pgTable(
  "journal_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    versionNum: integer("version_num").notNull(),
    content: text("content").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    editorId: uuid("editor_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: versionSourceEnum("source").notNull(),
    suggestionId: uuid("suggestion_id"),
    parentVersionId: uuid("parent_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("journal_versions_entry_id_version_num_unique").on(t.entryId, t.versionNum),
    index("journal_versions_entry_idx").on(t.entryId),
  ]
);

export const journalSuggestions = pgTable(
  "journal_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    proposerId: uuid("proposer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorTimezone: varchar("author_timezone", { length: 64 }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => journalVersions.id),
    proposedContent: text("proposed_content").notNull(),
    status: suggestionStatusEnum("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("journal_suggestions_entry_status_idx").on(t.entryId, t.status),
    index("journal_suggestions_proposer_idx").on(t.proposerId),
  ]
);

export const journalComments = pgTable(
  "journal_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    parentCommentId: uuid("parent_comment_id"),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorTimezone: varchar("author_timezone", { length: 64 }),
    content: text("content").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("journal_comments_entry_idx").on(t.entryId),
  ]
);

export const entryReactions = pgTable(
  "entry_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    emoji: reactionEmojiEnum("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("entry_reactions_user_id_entry_id_emoji_unique").on(t.userId, t.entryId, t.emoji),
  ]
);

export const commentReactions = pgTable(
  "comment_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => journalComments.id, { onDelete: "cascade" }),
    emoji: reactionEmojiEnum("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("comment_reactions_user_id_comment_id_emoji_unique").on(t.userId, t.commentId, t.emoji),
  ]
);

export const journalAppends = pgTable(
  "journal_appends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorTimezone: varchar("author_timezone", { length: 64 }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("journal_appends_entry_created_idx").on(t.entryId, t.createdAt),
  ]
);

// ------------------------------------------------------------------
// trips — single-blob HTML pages for travel itineraries. Dumb on purpose:
// any Claude-generated HTML works unchanged. Only metadata we capture is
// an optional title (extracted from <title> on upload) and the source
// filename for reference. Slug is URL-safe and unique site-wide.
// ------------------------------------------------------------------
export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 80 }).notNull().unique(),
    // Nullable: trips are a free-for-all. Authed uploads (PAT or JWT)
    // attribute to the user; anon uploads have ownerId = null. Anyone
    // can edit/delete any trip via the API; if abuse becomes a problem,
    // re-add the auth gates in routes.ts.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title"),
    html: text("html").notNull(),
    sourceFilename: varchar("source_filename", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trips_owner_created_idx").on(t.ownerId, t.createdAt)],
);

export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  name: varchar("name", { length: 80 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Binary blob column for storing image bytes inline.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Inline image storage for the markdown editor. Bytes live in the row; routes
// stream them out at GET /api/journal/images/:id. Cap on insert (5MB), no
// separate object store — keeps the dep surface small.
export const journalImages = pgTable(
  "journal_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    byteSize: integer("byte_size").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("journal_images_uploaded_by_idx").on(t.uploadedBy)],
);

// ------------------------------------------------------------------
// loan_entries — "Who Owes Me" element
// Per-user ledger of money the signed-in user has lent out. Amount is text
// to preserve decimal precision (same pattern as rngDecisions.price).
// ------------------------------------------------------------------
export const loanEntries = pgTable(
  "loan_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    borrowerName: varchar("borrower_name", { length: 255 }).notNull(),
    amount: text("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    description: text("description"),
    status: varchar("status", { length: 20 }).notNull().default("outstanding"),
    repaidAt: timestamp("repaid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("loan_entries_user_id_idx").on(t.userId),
    index("loan_entries_created_at_idx").on(t.createdAt),
  ],
);

// ------------------------------------------------------------------
// practice — per-item prescription, per-user history, sessions, timer
// state, admin-editable thresholds. See docs/superpowers/specs/
// 2026-05-24-practice-element-design.md.
// ------------------------------------------------------------------
export const practicePrescriptions = pgTable(
  "practice_prescriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .unique()
      .references(() => vocabWords.id, { onDelete: "cascade" }),
    setMode: varchar("set_mode", { length: 10 }).notNull(),
    setSize: integer("set_size").notNull(),
    restSeconds: integer("rest_seconds").notNull().default(30),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const practiceLocations = pgTable(
  "practice_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    normalized: varchar("normalized", { length: 120 }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("practice_locations_user_normalized_unique").on(t.userId, t.normalized),
    index("practice_locations_user_recent_idx").on(t.userId, t.lastUsedAt),
  ],
);

export const practiceSessions = pgTable(
  "practice_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    categoryFilter: varchar("category_filter", { length: 100 }),
    nItemsRequested: integer("n_items_requested").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("practice_sessions_user_started_idx").on(t.userId, t.startedAt)],
);

export const practiceSessionItems = pgTable(
  "practice_session_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => practiceSessions.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => vocabWords.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    locationId: uuid("location_id").references(() => practiceLocations.id, { onDelete: "set null" }),
    locationName: varchar("location_name", { length: 120 }),
    setsCompleted: integer("sets_completed").notNull().default(0),
    timerState: jsonb("timer_state"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("practice_session_items_item_loc_idx").on(t.itemId, t.locationId),
    index("practice_session_items_session_pos_idx").on(t.sessionId, t.position),
  ],
);

export const practiceSettings = pgTable("practice_settings", {
  id: integer("id").primaryKey(),
  setsPerStrike: integer("sets_per_strike").notNull().default(5),
  strikesPerLoadedLocation: integer("strikes_per_loaded_location").notNull().default(5),
  locationsToSolidify: integer("locations_to_solidify").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});
