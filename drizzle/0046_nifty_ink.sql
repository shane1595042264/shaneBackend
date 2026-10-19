CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"model" varchar(120) NOT NULL,
	"feature" varchar(20) NOT NULL,
	"surface" varchar(20),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reader_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"surface" varchar(20) NOT NULL,
	"resource_id" uuid NOT NULL,
	"parent_id" uuid,
	"anchor" jsonb,
	"meta" jsonb,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_ai_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"key_sealed" text NOT NULL,
	"key_hint" varchar(8) NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_model" varchar(120) NOT NULL,
	"preferred_model" varchar(120),
	"status" varchar(12) DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_keys_user_provider_unique" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "user_ai_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preferred_provider" varchar(20),
	"notes_to_knowledge" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_comments" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_notes" ADD CONSTRAINT "reader_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_notes" ADD CONSTRAINT "reader_notes_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."reader_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_keys" ADD CONSTRAINT "user_ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_settings" ADD CONSTRAINT "user_ai_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_created_idx" ON "ai_usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reader_notes_user_resource_idx" ON "reader_notes" USING btree ("user_id","surface","resource_id");