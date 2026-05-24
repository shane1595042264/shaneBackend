ALTER TABLE "trips" DROP CONSTRAINT "trips_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;