CREATE TABLE "blog_reading_positions" (
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"anchor" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blog_reading_positions_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "blog_reading_positions" ADD CONSTRAINT "blog_reading_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_reading_positions" ADD CONSTRAINT "blog_reading_positions_post_id_blog_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."blog_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blog_reading_positions_user_updated_idx" ON "blog_reading_positions" USING btree ("user_id","updated_at");