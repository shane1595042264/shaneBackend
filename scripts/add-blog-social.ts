/**
 * SHAN-488. One-shot recovery for the blog social layer: blog_comments,
 * blog_post_reactions, and the denormalized blog_posts.comment_count.
 *
 *   bun scripts/add-blog-social.ts
 *
 * Normally you never run this — drizzle/0040_whole_zaladane.sql applies on
 * startup via runStartupMigrations(). This exists for the case where that
 * fails against prod (a Railway incident mid-migrate, a half-applied journal)
 * and you need a psql-equivalent that can be run by hand.
 *
 * Idempotent: every statement is IF NOT EXISTS, and the comment_count
 * backfill recomputes from blog_comments rather than incrementing, so
 * re-running it converges instead of drifting.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "blog_comments" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "post_id" uuid NOT NULL REFERENCES "blog_posts"("id") ON DELETE cascade,
      "author_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
      "author_timezone" varchar(64),
      "content" text NOT NULL,
      "edited_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS "blog_comments_post_created_idx"
       ON "blog_comments" USING btree ("post_id","created_at")`
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS "blog_post_reactions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
      "post_id" uuid NOT NULL REFERENCES "blog_posts"("id") ON DELETE cascade,
      "emoji" "reaction_emoji" NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "blog_post_reactions_user_id_post_id_emoji_unique"
        UNIQUE("user_id","post_id","emoji")
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS "blog_post_reactions_post_id_idx"
       ON "blog_post_reactions" USING btree ("post_id")`
  );

  await client.query(
    `ALTER TABLE "blog_posts"
       ADD COLUMN IF NOT EXISTS "comment_count" integer DEFAULT 0 NOT NULL`
  );

  // Recompute rather than trust whatever is there: if the column was added
  // after comments already existed, every row reads 0.
  const backfilled = await client.query(`
    UPDATE "blog_posts" p
       SET "comment_count" = c.n
      FROM (SELECT "post_id", count(*)::int AS n FROM "blog_comments" GROUP BY "post_id") c
     WHERE c."post_id" = p."id" AND p."comment_count" <> c.n
  `);
  console.log("comment_count rows corrected:", backfilled.rowCount);

  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('blog_comments','blog_post_reactions')`
  );
  const column = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'blog_posts' AND column_name = 'comment_count'`
  );
  console.log("tables now present:", tables.rows.map((r) => r.table_name));
  console.log("blog_posts.comment_count present:", column.rows.length === 1);
} finally {
  await client.end();
}
