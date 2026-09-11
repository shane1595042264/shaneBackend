CREATE TYPE "public"."journal_activity_action" AS ENUM('entry.create', 'entry.delete', 'entry.revert', 'append.create', 'append.update', 'append.delete', 'comment.create', 'comment.update', 'comment.delete', 'suggestion.create', 'suggestion.approve', 'suggestion.reject', 'suggestion.withdraw');--> statement-breakpoint
CREATE TABLE "journal_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid,
	"entry_date" date NOT NULL,
	"action" "journal_activity_action" NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" uuid,
	"actor_id" uuid NOT NULL,
	"actor_token_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_appends" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal_appends" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal_activity" ADD CONSTRAINT "journal_activity_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_activity" ADD CONSTRAINT "journal_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_activity" ADD CONSTRAINT "journal_activity_actor_token_id_api_tokens_id_fk" FOREIGN KEY ("actor_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_activity_created_idx" ON "journal_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "journal_activity_entry_created_idx" ON "journal_activity" USING btree ("entry_id","created_at");