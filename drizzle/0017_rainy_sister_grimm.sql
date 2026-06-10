CREATE TABLE "trip_group_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"uploader_id" uuid,
	"source" varchar(20) DEFAULT 'user' NOT NULL,
	"mime_type" varchar(100),
	"byte_size" integer,
	"data" "bytea",
	"external_url" text,
	"attribution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_group_photos" ADD CONSTRAINT "trip_group_photos_group_id_trip_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."trip_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_group_photos" ADD CONSTRAINT "trip_group_photos_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_group_photos_group_day_idx" ON "trip_group_photos" USING btree ("group_id","day");