DROP INDEX "vocab_words_language_idx";--> statement-breakpoint
DROP INDEX "vocab_words_category_idx";--> statement-breakpoint
CREATE INDEX "vocab_words_language_created_idx" ON "vocab_words" USING btree ("language","created_at");--> statement-breakpoint
CREATE INDEX "vocab_words_category_created_idx" ON "vocab_words" USING btree ("category","created_at");