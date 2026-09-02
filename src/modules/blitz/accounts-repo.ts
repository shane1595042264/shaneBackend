import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { blitzSyncAccounts, users } from "@/db/schema";
import { ensureSupersyncUser } from "./supersync-db";
import { generateEncryptKey, unwrapKey, wrapKey } from "./keys";

export interface SyncAccount {
  supersyncUserId: number;
  encryptKey: string;
  email: string;
}

/**
 * Returns the caller's Blitz sync account, creating the SuperSync user and a
 * fresh encryption key on first use. The key is generated exactly once per
 * user; every device that signs in later receives the same key, which is what
 * lets them decrypt each other's data.
 */
export async function getOrCreateSyncAccount(userId: string): Promise<SyncAccount> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error("User not found");
  const email = user.email.trim().toLowerCase();

  const [existing] = await db
    .select({
      supersyncUserId: blitzSyncAccounts.supersyncUserId,
      keyCiphertext: blitzSyncAccounts.keyCiphertext,
    })
    .from(blitzSyncAccounts)
    .where(eq(blitzSyncAccounts.userId, userId))
    .limit(1);
  if (existing) {
    return {
      supersyncUserId: existing.supersyncUserId,
      encryptKey: unwrapKey(existing.keyCiphertext),
      email,
    };
  }

  const remote = await ensureSupersyncUser(email);
  const encryptKey = generateEncryptKey();
  // Two sign-ins racing on first use both reach here; unique(user_id) makes
  // the loser fail, and it simply re-reads the row the winner inserted.
  try {
    await db.insert(blitzSyncAccounts).values({
      userId,
      supersyncUserId: remote.id,
      keyCiphertext: wrapKey(encryptKey),
    });
  } catch (err) {
    const [row] = await db
      .select({
        supersyncUserId: blitzSyncAccounts.supersyncUserId,
        keyCiphertext: blitzSyncAccounts.keyCiphertext,
      })
      .from(blitzSyncAccounts)
      .where(eq(blitzSyncAccounts.userId, userId))
      .limit(1);
    if (!row) throw err;
    return { supersyncUserId: row.supersyncUserId, encryptKey: unwrapKey(row.keyCiphertext), email };
  }
  return { supersyncUserId: remote.id, encryptKey, email };
}
