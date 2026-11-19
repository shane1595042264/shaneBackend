// src/modules/courses/certificate-repo.ts
// SHAN-720: certificates for finishing a certified course.
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { courseCertificates, courses, users } from "@/db/schema";

// Crockford base32: no I, L, O or U, so a code read aloud or retyped from a
// printed certificate cannot be misread. 12 characters = 60 bits.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 12;

export function newCertificateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

/**
 * Accepts the code as printed (grouped with dashes or spaces, any case) and
 * returns the stored form, or null when it cannot be a code at all.
 */
export function normalizeCertificateCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export interface CertificateRow {
  id: string;
  code: string;
  userId: string;
  courseId: string;
  recipientName: string;
  courseTitle: string;
  score: number;
  lessonCount: number;
  issuedAt: Date;
}

export async function getCertificateFor(
  userId: string,
  courseId: string,
): Promise<CertificateRow | null> {
  const [row] = await db
    .select()
    .from(courseCertificates)
    .where(and(eq(courseCertificates.userId, userId), eq(courseCertificates.courseId, courseId)))
    .limit(1);
  return row ?? null;
}

export async function getCertificateByCode(code: string): Promise<CertificateRow | null> {
  const [row] = await db
    .select()
    .from(courseCertificates)
    .where(eq(courseCertificates.code, code))
    .limit(1);
  return row ?? null;
}

/**
 * Issue once. A second claim (a double click, two tabs) lands on the unique
 * (user, course) pair and returns the certificate already issued, unchanged.
 */
export async function issueCertificate(input: {
  userId: string;
  courseId: string;
  recipientName: string;
  courseTitle: string;
  score: number;
  lessonCount: number;
}): Promise<{ row: CertificateRow; created: boolean }> {
  const [row] = await db
    .insert(courseCertificates)
    .values({ ...input, code: newCertificateCode() })
    .onConflictDoNothing({ target: [courseCertificates.userId, courseCertificates.courseId] })
    .returning();
  if (row) return { row, created: true };
  const existing = await getCertificateFor(input.userId, input.courseId);
  if (!existing) throw new Error("certificate vanished after a conflicting insert");
  return { row: existing, created: false };
}

export async function accountName(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.name?.trim() || null;
}

export async function setCertified(courseId: string, certified: boolean): Promise<boolean> {
  const rows = await db
    .update(courses)
    .set({ certified, updatedAt: new Date() })
    .where(eq(courses.id, courseId))
    .returning({ id: courses.id });
  return rows.length > 0;
}
