CREATE TABLE "course_exam_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"lesson_id" varchar(64) NOT NULL,
	"best_score" integer NOT NULL,
	"last_score" integer NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"passed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_exam_results_user_course_lesson_unique" UNIQUE("user_id","course_id","lesson_id")
);
--> statement-breakpoint
ALTER TABLE "course_exam_results" ADD CONSTRAINT "course_exam_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_exam_results" ADD CONSTRAINT "course_exam_results_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;