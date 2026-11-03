CREATE TABLE "course_content" (
	"course_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"lesson_count" integer NOT NULL,
	"step_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"lesson_id" varchar(64) NOT NULL,
	"best_score" integer NOT NULL,
	"last_score" integer NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_progress_user_course_lesson_unique" UNIQUE("user_id","course_id","lesson_id")
);
--> statement-breakpoint
ALTER TABLE "courses" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "course_content" ADD CONSTRAINT "course_content_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_progress" ADD CONSTRAINT "course_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_progress" ADD CONSTRAINT "course_progress_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;