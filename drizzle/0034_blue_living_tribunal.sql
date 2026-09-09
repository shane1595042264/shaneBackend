CREATE TABLE "training_plan_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" varchar(160) NOT NULL,
	"kind" varchar(20) DEFAULT 'other' NOT NULL,
	"mode" varchar(10) DEFAULT 'time' NOT NULL,
	"target_seconds" integer,
	"target_reps" integer,
	"sets" integer DEFAULT 1 NOT NULL,
	"rest_seconds" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plan_completions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"iso_date" date NOT NULL,
	"sets_completed" integer DEFAULT 0 NOT NULL,
	"elapsed_seconds" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_plan_completions_user_block_date_unique" UNIQUE("user_id","block_id","iso_date")
);
--> statement-breakpoint
CREATE TABLE "training_plan_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"weekday" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"block_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" varchar(300) NOT NULL,
	"reps" integer,
	"duration_seconds" integer
);
--> statement-breakpoint
CREATE TABLE "training_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" varchar(120) NOT NULL,
	"title" varchar(160) NOT NULL,
	"goal" text,
	"description" text,
	"discipline" varchar(60),
	"status" varchar(12) DEFAULT 'draft' NOT NULL,
	"visibility" varchar(10) DEFAULT 'private' NOT NULL,
	"start_date" date,
	"days_per_week" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_plans_user_slug_unique" UNIQUE("user_id","slug")
);
--> statement-breakpoint
ALTER TABLE "training_plan_blocks" ADD CONSTRAINT "training_plan_blocks_day_id_training_plan_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."training_plan_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_completions" ADD CONSTRAINT "training_plan_completions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_completions" ADD CONSTRAINT "training_plan_completions_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_completions" ADD CONSTRAINT "training_plan_completions_block_id_training_plan_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."training_plan_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_days" ADD CONSTRAINT "training_plan_days_plan_id_training_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan_steps" ADD CONSTRAINT "training_plan_steps_block_id_training_plan_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."training_plan_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "training_plan_blocks_day_pos_idx" ON "training_plan_blocks" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "training_plan_completions_plan_date_idx" ON "training_plan_completions" USING btree ("plan_id","iso_date");--> statement-breakpoint
CREATE INDEX "training_plan_days_plan_pos_idx" ON "training_plan_days" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "training_plan_steps_block_pos_idx" ON "training_plan_steps" USING btree ("block_id","position");--> statement-breakpoint
CREATE INDEX "training_plans_user_updated_idx" ON "training_plans" USING btree ("user_id","updated_at");