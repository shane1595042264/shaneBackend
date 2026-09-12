/**
 * One-shot recovery script to add blog_posts.cover_image_url (SHAN-487) on
 * prod, in case drizzle-kit migrate on startup ever fails to apply 0039.
 *
 *   bun scripts/add-blog-cover.ts
 *
 * Idempotent: checks before altering.
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
  const before = await client.query(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'blog_posts' AND column_name = 'cover_image_url'`
  );
  if (before.rows.length === 0) {
    await client.query(
      `ALTER TABLE "blog_posts" ADD COLUMN "cover_image_url" varchar(500)`
    );
    console.log("added column cover_image_url");
  } else {
    console.log("column cover_image_url already exists, no change");
  }

  const after = await client.query(
    `SELECT column_name, data_type, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'blog_posts' AND column_name = 'cover_image_url'`
  );
  console.log("column after:", after.rows);
} finally {
  await client.end();
}
