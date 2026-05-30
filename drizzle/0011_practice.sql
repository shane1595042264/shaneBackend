CREATE TABLE "practice_prescriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "set_mode" varchar(10) NOT NULL,
  "set_size" integer NOT NULL,
  "rest_seconds" integer DEFAULT 30 NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "practice_prescriptions_item_id_unique" UNIQUE("item_id"),
  CONSTRAINT "practice_prescriptions_set_mode_check" CHECK ("set_mode" IN ('time', 'reps')),
  CONSTRAINT "practice_prescriptions_set_size_check" CHECK ("set_size" > 0),
  CONSTRAINT "practice_prescriptions_rest_check" CHECK ("rest_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "practice_prescriptions" ADD CONSTRAINT "practice_prescriptions_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "vocab_words"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "practice_prescriptions" ADD CONSTRAINT "practice_prescriptions_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE "practice_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "name" varchar(120) NOT NULL,
  "normalized" varchar(120) NOT NULL,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "practice_locations_user_normalized_unique" UNIQUE("user_id", "normalized")
);
--> statement-breakpoint
ALTER TABLE "practice_locations" ADD CONSTRAINT "practice_locations_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "practice_locations_user_recent_idx" ON "practice_locations" ("user_id", "last_used_at");
--> statement-breakpoint
CREATE TABLE "practice_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "category_filter" varchar(100),
  "n_items_requested" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "practice_sessions_n_items_check" CHECK ("n_items_requested" > 0)
);
--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "practice_sessions_user_started_idx" ON "practice_sessions" ("user_id", "started_at");
--> statement-breakpoint
CREATE TABLE "practice_session_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "location_id" uuid,
  "location_name" varchar(120),
  "sets_completed" integer DEFAULT 0 NOT NULL,
  "timer_state" jsonb,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "practice_session_items_sets_check" CHECK ("sets_completed" >= 0)
);
--> statement-breakpoint
ALTER TABLE "practice_session_items" ADD CONSTRAINT "practice_session_items_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "practice_sessions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "practice_session_items" ADD CONSTRAINT "practice_session_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "vocab_words"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "practice_session_items" ADD CONSTRAINT "practice_session_items_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "practice_locations"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "practice_session_items_item_loc_idx" ON "practice_session_items" ("item_id", "location_id");
--> statement-breakpoint
CREATE INDEX "practice_session_items_session_pos_idx" ON "practice_session_items" ("session_id", "position");
--> statement-breakpoint
CREATE TABLE "practice_settings" (
  "id" integer PRIMARY KEY NOT NULL,
  "sets_per_strike" integer DEFAULT 5 NOT NULL,
  "strikes_per_loaded_location" integer DEFAULT 5 NOT NULL,
  "locations_to_solidify" integer DEFAULT 7 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "practice_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "practice_settings_sps_range" CHECK ("sets_per_strike" BETWEEN 1 AND 50),
  CONSTRAINT "practice_settings_spll_range" CHECK ("strikes_per_loaded_location" BETWEEN 1 AND 50),
  CONSTRAINT "practice_settings_lts_range" CHECK ("locations_to_solidify" BETWEEN 1 AND 50)
);
--> statement-breakpoint
ALTER TABLE "practice_settings" ADD CONSTRAINT "practice_settings_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
INSERT INTO "practice_settings" ("id", "sets_per_strike", "strikes_per_loaded_location", "locations_to_solidify") VALUES (1, 5, 5, 7);
