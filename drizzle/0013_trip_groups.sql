CREATE TABLE "trip_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(80) NOT NULL,
  "owner_id" uuid NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trip_groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "trip_groups" ADD CONSTRAINT "trip_groups_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "trip_groups_owner_idx" ON "trip_groups" ("owner_id");
--> statement-breakpoint
CREATE TABLE "trip_group_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" varchar(20) DEFAULT 'member' NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trip_group_members_group_user_unique" UNIQUE("group_id", "user_id")
);
--> statement-breakpoint
ALTER TABLE "trip_group_members" ADD CONSTRAINT "trip_group_members_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "trip_groups"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "trip_group_members" ADD CONSTRAINT "trip_group_members_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "trip_group_members_user_idx" ON "trip_group_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "trip_ideas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trip_ideas" ADD CONSTRAINT "trip_ideas_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "trip_groups"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "trip_ideas" ADD CONSTRAINT "trip_ideas_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "trip_ideas_group_created_idx" ON "trip_ideas" ("group_id", "created_at");
