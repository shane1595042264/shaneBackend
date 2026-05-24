ALTER TABLE "journal_appends" ADD COLUMN "author_timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "journal_comments" ADD COLUMN "author_timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "author_timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "journal_suggestions" ADD COLUMN "author_timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" varchar(64) DEFAULT 'America/Chicago' NOT NULL;
