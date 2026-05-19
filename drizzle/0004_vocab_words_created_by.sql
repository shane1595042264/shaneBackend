ALTER TABLE "vocab_words" ADD COLUMN IF NOT EXISTS "created_by" uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'vocab_words_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "vocab_words"
      ADD CONSTRAINT "vocab_words_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "vocab_words_created_by_idx" ON "vocab_words" ("created_by");
