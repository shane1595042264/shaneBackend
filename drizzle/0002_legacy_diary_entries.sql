DO $$
BEGIN
  -- Rename table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'diary_entries') THEN
    ALTER TABLE "diary_entries" RENAME TO "legacy_diary_entries";
  END IF;

  -- Rename index
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'diary_entries_embedding_hnsw_idx') THEN
    ALTER INDEX "diary_entries_embedding_hnsw_idx" RENAME TO "legacy_diary_entries_embedding_hnsw_idx";
  END IF;

  -- Rename unique constraint
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND constraint_name = 'diary_entries_date_unique'
  ) THEN
    ALTER TABLE "legacy_diary_entries" RENAME CONSTRAINT "diary_entries_date_unique" TO "legacy_diary_entries_date_unique";
  END IF;

  -- Rename FK on corrections table
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND constraint_name = 'corrections_entry_id_diary_entries_id_fk'
  ) THEN
    ALTER TABLE "corrections" RENAME CONSTRAINT "corrections_entry_id_diary_entries_id_fk" TO "corrections_entry_id_legacy_diary_entries_id_fk";
  END IF;
END $$;
