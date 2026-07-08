CREATE TABLE "skincare_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"time_of_day" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"image_url" text,
	"position" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skincare_products" ADD CONSTRAINT "skincare_products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skincare_products_user_time_pos_idx" ON "skincare_products" USING btree ("user_id","time_of_day","position");