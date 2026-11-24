// In-memory per-entry failed-PIN rate limiter for GET /api/tea-entries/:id.
// 4-digit PINs only span 10K keys; without this an attacker who learns the
// entry UUID can brute-force the gate at HTTP speed. We bucket per entryId
// (not per IP) so a single attacker rotating IPs still hits the cap.
//
// Two ceilings per bucket (SHAN-736). The minute window stops a burst; the day
// window bounds the total. With only the minute window the cap just restarted
// every 60s, so 10 a minute walked the whole keyspace in under 17 hours. With
// 50 a day a full sweep takes at least 200 days.
//
// Mirrors the in-memory pattern in shared/rate-limit.ts. Acceptable while
// the backend is single-Railway-instance; if we scale horizontally, swap to
// a Postgres-backed counter.

const WINDOW_MS = 60_000;
const MAX_FAILS_PER_WINDOW = 10;
const DAY_WINDOW_MS = 24 * 60 * 60_000;
const MAX_FAILS_PER_DAY = 50;

interface Bucket {
  failedCount: number;
  windowStart: number;
  dayFailedCount: number;
  dayStart: number;
}

const attempts = new Map<string, Bucket>();

export interface BlockState {
  blocked: boolean;
  retryAfterSec: number;
}

const OPEN: BlockState = { blocked: false, retryAfterSec: 0 };

function blockFor(ms: number): BlockState {
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) };
}

// Rolls expired windows forward in place and drops the bucket once both have
// expired. Returns the live bucket, or undefined when nothing is left.
function liveBucket(key: string, now: number): Bucket | undefined {
  const b = attempts.get(key);
  if (!b) return undefined;
  if (now - b.dayStart >= DAY_WINDOW_MS) {
    attempts.delete(key);
    return undefined;
  }
  if (now - b.windowStart >= WINDOW_MS) {
    b.failedCount = 0;
    b.windowStart = now;
  }
  return b;
}

// The day block outlasts the minute block, so it wins when both apply.
function stateOf(b: Bucket, now: number): BlockState {
  if (b.dayFailedCount >= MAX_FAILS_PER_DAY) return blockFor(DAY_WINDOW_MS - (now - b.dayStart));
  if (b.failedCount >= MAX_FAILS_PER_WINDOW) return blockFor(WINDOW_MS - (now - b.windowStart));
  return OPEN;
}

export function isPinAttemptBlocked(entryId: string): BlockState {
  const now = Date.now();
  const b = liveBucket(entryId, now);
  return b ? stateOf(b, now) : OPEN;
}

export function recordFailedPinAttempt(entryId: string): BlockState {
  const now = Date.now();
  const b = liveBucket(entryId, now);
  if (!b) {
    attempts.set(entryId, { failedCount: 1, windowStart: now, dayFailedCount: 1, dayStart: now });
    return OPEN;
  }
  b.failedCount += 1;
  b.dayFailedCount += 1;
  return stateOf(b, now);
}

// Bucket key for an author's universal PIN (SHAN-581), which unlocks every one
// of their entries and so needs a counter of its own. The prefix keeps it from
// colliding with an entry id; the helpers below take any key.
export function universalPinBucket(authorId: string): string {
  return `universal:${authorId}`;
}

export function clearPinAttempts(entryId: string): void {
  attempts.delete(entryId);
}

export function __resetPinAttempts(): void {
  attempts.clear();
}
