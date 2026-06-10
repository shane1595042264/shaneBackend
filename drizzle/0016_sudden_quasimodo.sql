CREATE TABLE "trip_itinerary_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"itinerary" jsonb NOT NULL,
	"changed_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid
);
--> statement-breakpoint
ALTER TABLE "trip_itinerary_suggestions" ADD CONSTRAINT "trip_itinerary_suggestions_group_id_trip_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_itinerary_suggestions" ADD CONSTRAINT "trip_itinerary_suggestions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_itinerary_suggestions" ADD CONSTRAINT "trip_itinerary_suggestions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_itinerary_suggestions_group_status_idx" ON "trip_itinerary_suggestions" USING btree ("group_id","status");