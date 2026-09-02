import { Pool } from "pg";

// The SuperSync server (Railway service `supersync`) owns the `supersync`
// database; Prisma manages its schema. We touch exactly one table, `users`,
// and only to provision verified accounts the same way the server's own
// email-verification path does (auth.ts in super-sync-server). Never run
// drizzle-kit against this connection.
let _pool: Pool | null = null;

export function getSupersyncPool(): Pool {
  if (!_pool) {
    const url = process.env.SUPERSYNC_DATABASE_URL;
    if (!url) throw new Error("SUPERSYNC_DATABASE_URL environment variable is required");
    _pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Railway's public TCP proxy presents a self-signed cert; the private
      // network (railway.internal) is plain WireGuard-encrypted TCP.
      ssl: url.includes("railway.internal") ? undefined : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

export interface SupersyncUser {
  id: number;
  tokenVersion: number;
}

/**
 * Find-or-create the SuperSync account for an email. Idempotent: a second call
 * returns the same row. An unverified row left behind by the server's magic-link
 * flow is promoted to verified, since Google already verified the address.
 */
export async function ensureSupersyncUser(email: string): Promise<SupersyncUser> {
  const normalized = email.trim().toLowerCase();
  const { rows } = await getSupersyncPool().query<{ id: number; token_version: number }>(
    `INSERT INTO users (email, is_verified)
       VALUES ($1, 1)
     ON CONFLICT (email) DO UPDATE SET is_verified = 1
     RETURNING id, token_version`,
    [normalized],
  );
  const row = rows[0];
  return { id: row.id, tokenVersion: row.token_version };
}
