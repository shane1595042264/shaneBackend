CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"source" varchar(50) NOT NULL,
	"type" varchar(100) NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_date_source_type_data_unique" UNIQUE("date","source","type","data")
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"suggestion_text" text NOT NULL,
	"original_content" text NOT NULL,
	"corrected_content" text,
	"extracted_facts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(384),
	"voice_profile_version" integer,
	"generation_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_entries_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "element_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" varchar(3) NOT NULL,
	"name" varchar(100) NOT NULL,
	"category" varchar(50),
	"row_pos" integer,
	"col_pos" integer,
	"type" varchar(20) DEFAULT 'internal' NOT NULL,
	"route" varchar(255),
	"url" varchar(512),
	"status" varchar(30) DEFAULT 'coming-soon' NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "element_config_symbol_unique" UNIQUE("symbol")
);
--> statement-breakpoint
CREATE TABLE "learned_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_text" text NOT NULL,
	"embedding" vector(384),
	"source_correction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rng_ban_list" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"generic_category" text NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"source_decision_id" uuid
);
--> statement-breakpoint
CREATE TABLE "rng_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"url" text,
	"product_name" text NOT NULL,
	"price" text NOT NULL,
	"generic_category" text NOT NULL,
	"is_entertainment" boolean NOT NULL,
	"avatar_url" text,
	"balance_at_time" text,
	"remaining_budget" text,
	"threshold" integer,
	"roll" integer,
	"result" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rng_monthly_spend" (
	"id" serial PRIMARY KEY NOT NULL,
	"year_month" varchar(7) NOT NULL,
	"total_spend" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rng_monthly_spend_year_month_unique" UNIQUE("year_month")
);
--> statement-breakpoint
CREATE TABLE "rng_plaid_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"access_token" text NOT NULL,
	"item_id" text NOT NULL,
	"institution_name" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"level" varchar(20) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "summaries_level_start_date_end_date_unique" UNIQUE("level","start_date","end_date")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"profile_text" text NOT NULL,
	"derived_from" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_profiles_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_entry_id_diary_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_facts" ADD CONSTRAINT "learned_facts_source_correction_id_corrections_id_fk" FOREIGN KEY ("source_correction_id") REFERENCES "public"."corrections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rng_ban_list" ADD CONSTRAINT "rng_ban_list_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rng_ban_list" ADD CONSTRAINT "rng_ban_list_source_decision_id_rng_decisions_id_fk" FOREIGN KEY ("source_decision_id") REFERENCES "public"."rng_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rng_decisions" ADD CONSTRAINT "rng_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rng_plaid_tokens" ADD CONSTRAINT "rng_plaid_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_date_idx" ON "activities" USING btree ("date");--> statement-breakpoint
CREATE INDEX "corrections_entry_id_idx" ON "corrections" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "diary_entries_embedding_hnsw_idx" ON "diary_entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "learned_facts_embedding_hnsw_idx" ON "learned_facts" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "rng_ban_list_expires_at_idx" ON "rng_ban_list" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rng_decisions_created_at_idx" ON "rng_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "summaries_embedding_hnsw_idx" ON "summaries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "users_google_id_idx" ON "users" USING btree ("google_id");