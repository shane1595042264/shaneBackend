ALTER TABLE "trip_groups" ADD COLUMN IF NOT EXISTS "itinerary" jsonb;
--> statement-breakpoint
ALTER TABLE "trip_groups" ADD COLUMN IF NOT EXISTS "itinerary_generated_at" timestamp with time zone;
