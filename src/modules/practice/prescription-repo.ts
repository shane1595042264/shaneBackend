import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { practicePrescriptions } from "@/db/schema";

export interface Prescription {
  id: string;
  itemId: string;
  setMode: "time" | "reps";
  setSize: number;
  restSeconds: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrescriptionInput {
  setMode: "time" | "reps";
  setSize: number;
  restSeconds: number;
}

export async function getPrescription(itemId: string): Promise<Prescription | null> {
  const [row] = await db
    .select()
    .from(practicePrescriptions)
    .where(eq(practicePrescriptions.itemId, itemId))
    .limit(1);
  return (row as Prescription | undefined) ?? null;
}

/**
 * Upsert by item_id (UNIQUE). createdBy is set on first insert; updates
 * leave it alone (history of original configurer is preserved).
 */
export async function upsertPrescription(
  itemId: string,
  userId: string,
  input: PrescriptionInput,
): Promise<Prescription> {
  const [row] = await db
    .insert(practicePrescriptions)
    .values({
      itemId,
      setMode: input.setMode,
      setSize: input.setSize,
      restSeconds: input.restSeconds,
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: practicePrescriptions.itemId,
      set: {
        setMode: input.setMode,
        setSize: input.setSize,
        restSeconds: input.restSeconds,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as Prescription;
}

export async function deletePrescription(itemId: string): Promise<boolean> {
  const out = await db
    .delete(practicePrescriptions)
    .where(eq(practicePrescriptions.itemId, itemId))
    .returning({ id: practicePrescriptions.id });
  return out.length > 0;
}
