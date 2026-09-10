ALTER TABLE "training_plans" ADD COLUMN "session_time" varchar(5);--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "reminder_minutes" integer;--> statement-breakpoint
ALTER TABLE "training_plans" ADD COLUMN "ics_token" uuid;--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_ics_token_unique" UNIQUE("ics_token");