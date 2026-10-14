-- SHAN-574: promote any reply whose parent is already gone, so the FK below can be added.
UPDATE "course_comments" SET "parent_comment_id" = NULL WHERE "parent_comment_id" IS NOT NULL AND "parent_comment_id" NOT IN (SELECT "id" FROM "course_comments");--> statement-breakpoint
-- SHAN-574: promote any reply whose parent is already gone, so the FK below can be added.
UPDATE "journal_comments" SET "parent_comment_id" = NULL WHERE "parent_comment_id" IS NOT NULL AND "parent_comment_id" NOT IN (SELECT "id" FROM "journal_comments");--> statement-breakpoint
-- SHAN-574: promote any reply whose parent is already gone, so the FK below can be added.
UPDATE "knowledge_comments" SET "parent_comment_id" = NULL WHERE "parent_comment_id" IS NOT NULL AND "parent_comment_id" NOT IN (SELECT "id" FROM "knowledge_comments");--> statement-breakpoint
ALTER TABLE "course_comments" ADD CONSTRAINT "course_comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."course_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_comments" ADD CONSTRAINT "journal_comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."journal_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_comments" ADD CONSTRAINT "knowledge_comments_parent_comment_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."knowledge_comments"("id") ON DELETE set null ON UPDATE no action;