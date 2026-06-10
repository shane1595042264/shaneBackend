CREATE TABLE "trip_group_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"anchor_type" varchar(20) NOT NULL,
	"anchor_day" integer,
	"anchor_activity" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_group_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" varchar(20) DEFAULT 'todo' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_group_notes" ADD CONSTRAINT "trip_group_notes_group_id_trip_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_group_notes" ADD CONSTRAINT "trip_group_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_group_sections" ADD CONSTRAINT "trip_group_sections_group_id_trip_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_group_sections" ADD CONSTRAINT "trip_group_sections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_group_notes_group_idx" ON "trip_group_notes" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "trip_group_sections_group_idx" ON "trip_group_sections" USING btree ("group_id");