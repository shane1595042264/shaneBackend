CREATE TABLE IF NOT EXISTS "knowledge_comments" (
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
DO $$ BEGIN
	ALTER TABLE "knowledge_comments" ADD CONSTRAINT "knowledge_comments_entry_id_vocab_words_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."vocab_words"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "knowledge_comments" ADD CONSTRAINT "knowledge_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_comments_entry_idx" ON "knowledge_comments" ("entry_id");
