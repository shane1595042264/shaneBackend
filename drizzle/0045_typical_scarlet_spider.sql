-- SHAN-584. Hand-edited from the generated file: prod drifted from the 0000
-- snapshot (user_id already exists there with an unnamed, non-cascading FK
-- "rng_monthly_spend_user_id_fkey", and the month unique is named "_key", not
-- "_unique"), so every step tolerates both shapes.
ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_year_month_unique";--> statement-breakpoint
ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_year_month_key";--> statement-breakpoint
ALTER TABLE "rng_monthly_spend" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "rng_monthly_spend" DROP CONSTRAINT IF EXISTS "rng_monthly_spend_user_id_fkey";--> statement-breakpoint
ALTER TABLE "rng_monthly_spend" ADD CONSTRAINT "rng_monthly_spend_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rng_monthly_spend" ADD CONSTRAINT "rng_monthly_spend_user_year_month_unique" UNIQUE("user_id","year_month");
