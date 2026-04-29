DO $$ BEGIN
  CREATE TYPE "public"."journal_entry_status" AS ENUM('published', 'trashed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."reaction_emoji" AS ENUM('+1', '-1', 'laugh', 'heart', 'hooray', 'rocket', 'eyes', 'confused');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."journal_suggestion_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."journal_version_source" AS ENUM('direct', 'suggestion', 'revert');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comment_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"emoji" "reaction_emoji" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_reactions_user_id_comment_id_emoji_unique" UNIQUE("user_id","comment_id","emoji")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entry_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"emoji" "reaction_emoji" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_reactions_user_id_entry_id_emoji_unique" UNIQUE("user_id","entry_id","emoji")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"author_id" uuid NOT NULL,
	"content" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"author_id" uuid NOT NULL,
	"current_version_id" uuid,
	"status" "journal_entry_status" DEFAULT 'published' NOT NULL,
	"edit_count" integer DEFAULT 1 NOT NULL,
	"pending_suggestion_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"proposer_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"proposed_content" text NOT NULL,
	"status" "journal_suggestion_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "journal_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"version_num" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"editor_id" uuid NOT NULL,
	"source" "journal_version_source" NOT NULL,
	"suggestion_id" uuid,
	"parent_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_versions_entry_id_version_num_unique" UNIQUE("entry_id","version_num")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slot_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"assignments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_assignments_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vocab_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_word_id" uuid NOT NULL,
	"to_word_id" uuid NOT NULL,
	"connection_type" varchar(50) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocab_connections_unique" UNIQUE("from_word_id","to_word_id","connection_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vocab_words" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"word" varchar(255) NOT NULL,
	"language" varchar(50) NOT NULL,
	"category" varchar(100) DEFAULT 'vocabulary' NOT NULL,
	"definition" text,
	"pronunciation" varchar(255),
	"part_of_speech" varchar(50),
	"example_sentence" text,
	"labels" jsonb DEFAULT '[]'::jsonb,
	"ai_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_journal_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."journal_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_reactions" ADD CONSTRAINT "entry_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_reactions" ADD CONSTRAINT "entry_reactions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_comments" ADD CONSTRAINT "journal_comments_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_comments" ADD CONSTRAINT "journal_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_suggestions" ADD CONSTRAINT "journal_suggestions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_suggestions" ADD CONSTRAINT "journal_suggestions_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_suggestions" ADD CONSTRAINT "journal_suggestions_base_version_id_journal_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."journal_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_suggestions" ADD CONSTRAINT "journal_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_versions" ADD CONSTRAINT "journal_versions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_versions" ADD CONSTRAINT "journal_versions_editor_id_users_id_fk" FOREIGN KEY ("editor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_assignments" ADD CONSTRAINT "slot_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vocab_connections" ADD CONSTRAINT "vocab_connections_from_word_id_vocab_words_id_fk" FOREIGN KEY ("from_word_id") REFERENCES "public"."vocab_words"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "vocab_connections" ADD CONSTRAINT "vocab_connections_to_word_id_vocab_words_id_fk" FOREIGN KEY ("to_word_id") REFERENCES "public"."vocab_words"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX "journal_comments_entry_idx" ON "journal_comments" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_suggestions_entry_status_idx" ON "journal_suggestions" USING btree ("entry_id","status");--> statement-breakpoint
CREATE INDEX "journal_suggestions_proposer_idx" ON "journal_suggestions" USING btree ("proposer_id");--> statement-breakpoint
CREATE INDEX "journal_versions_entry_idx" ON "journal_versions" USING btree ("entry_id");--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "vocab_connections_from_idx" ON "vocab_connections" USING btree ("from_word_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "vocab_connections_to_idx" ON "vocab_connections" USING btree ("to_word_id");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "vocab_words_language_idx" ON "vocab_words" USING btree ("language");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "vocab_words_created_at_idx" ON "vocab_words" USING btree ("created_at");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX "vocab_words_category_idx" ON "vocab_words" USING btree ("category");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;
