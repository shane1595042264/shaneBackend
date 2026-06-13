// In-memory per-entry failed-PIN rate limiter for GET /api/tea-entries/:id.
// 4-digit PINs only span 10K keys; without this an attacker who learns the
// entry UUID can brute-force the gate at HTTP speed. We bucket per entryId
// (not per IP) so a single attacker rotating IPs still hits the cap.
//
// Mirrors the in-memory pattern in shared/rate-limit.ts. Acceptable while
// the backend is single-Railway-instance; if we scale horizontally, swap to
// a Postgres-backed counter.

const WINDOW_MS = 60_000;
const MAX_FAILS_PER_WINDOW = 10;

interface Bucket {
  failedCount: number;
  windowStart: number;
}

const attempts = new Map<string, Bucket>();

export interface BlockState {
  blocked: boolean;
  retryAfterSec: number;
}

export function isPinAttemptBlocked(entryId: string): BlockState {
  const b = attempts.get(entryId);
  if (!b) return { blocked: false, retryAfterSec: 0 };
  const now = Date.now();
  if (now - b.windowStart >= WINDOW_MS) {
    attempts.delete(entryId);
    return { blocked: false, retryAfterSec: 0 };
  }
  if (b.failedCount >= MAX_FAILS_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (now - b.windowStart);
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export function recordFailedPinAttempt(entryId: string): BlockState {
  const now = Date.now();
  const existing = attempts.get(entryId);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    attempts.set(entryId, { failedCount: 1, windowStart: now });
    return { blocked: false, retryAfterSec: 0 };
  }
  existing.failedCount += 1;
  if (existing.failedCount >= MAX_FAILS_PER_WINDOW) {
    const retryAfterMs = WINDOW_MS - (now - existing.windowStart);
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

export function clearPinAttempts(entryId: string): void {
  attempts.delete(entryId);
}

export function __resetPinAttempts(): void {
  attempts.clear();
}
