/**
 * One-shot script for SHAN-720 (course certificates): adds courses.certified
 * and creates course_certificates, the same statements as drizzle/0051.
 *
 * Run only if drizzle-kit migrate on startup fails to apply 0051 for some
 * reason (the startup sanity check would then crash the container):
 *
 *   bun scripts/add-course-certificates.ts
 *
 * Idempotent: IF NOT EXISTS everywhere, constraints guarded by pg_constraint.
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
  await client.query("BEGIN");
  await client.query(
    `ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "certified" boolean DEFAULT false NOT NULL`,
  );
  await client.query(`CREATE TABLE IF NOT EXISTS "course_certificates" (
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
  )`);
  const fks: [string, string][] = [
    [
      "course_certificates_user_id_users_id_fk",
      `FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade`,
    ],
    [
      "course_certificates_course_id_courses_id_fk",
      `FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade`,
    ],
  ];
  for (const [name, def] of fks) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1`,
      [name],
    );
    if (!rowCount) {
      await client.query(`ALTER TABLE "course_certificates" ADD CONSTRAINT "${name}" ${def}`);
    }
  }
  await client.query("COMMIT");
  console.log("courses.certified and course_certificates are in place");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
