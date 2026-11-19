CREATE TABLE "course_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(16) NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"recipient_name" varchar(120) NOT NULL,
	"course_title" varchar(200) NOT NULL,
	"score" integer NOT NULL,
	"lesson_count" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_certificates_code_unique" UNIQUE("code"),
	CONSTRAINT "course_certificates_user_course_unique" UNIQUE("user_id","course_id")
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "certified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_certificates" ADD CONSTRAINT "course_certificates_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;