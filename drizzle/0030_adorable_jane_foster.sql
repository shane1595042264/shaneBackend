CREATE TABLE "vocab_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"grade" varchar(10) NOT NULL,
	"level_before" integer NOT NULL,
	"level_after" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocab_srs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid,
	"location_name" varchar(120) NOT NULL,
	"location_normalized" varchar(120) NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"due_at" timestamp with time zone,
	"memorized_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vocab_srs_user_item_loc_unique" UNIQUE("user_id","item_id","location_normalized")
);
--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "mode" varchar(10) DEFAULT 'workout' NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "location_name" varchar(120);--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "location_normalized" varchar(120);--> statement-breakpoint
ALTER TABLE "practice_settings" ADD COLUMN "vocab_interval_l1_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_settings" ADD COLUMN "vocab_interval_l2_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_settings" ADD COLUMN "vocab_lapse_interval_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_settings" ADD COLUMN "vocab_level_to_memorize" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "vocab_reviews" ADD CONSTRAINT "vocab_reviews_session_id_practice_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_reviews" ADD CONSTRAINT "vocab_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_reviews" ADD CONSTRAINT "vocab_reviews_item_id_vocab_words_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vocab_words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_srs" ADD CONSTRAINT "vocab_srs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_srs" ADD CONSTRAINT "vocab_srs_item_id_vocab_words_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vocab_words"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vocab_srs" ADD CONSTRAINT "vocab_srs_location_id_practice_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."practice_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vocab_reviews_session_idx" ON "vocab_reviews" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "vocab_srs_due_idx" ON "vocab_srs" USING btree ("user_id","location_normalized","due_at");--> statement-breakpoint
CREATE INDEX "vocab_srs_item_idx" ON "vocab_srs" USING btree ("user_id","item_id");--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_location_id_practice_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."practice_locations"("id") ON DELETE set null ON UPDATE no action;