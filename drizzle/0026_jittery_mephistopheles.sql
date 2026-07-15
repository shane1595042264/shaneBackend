DROP INDEX "loan_entries_user_id_idx";--> statement-breakpoint
DROP INDEX "loan_entries_created_at_idx";--> statement-breakpoint
CREATE INDEX "loan_entries_user_created_idx" ON "loan_entries" USING btree ("user_id","created_at");