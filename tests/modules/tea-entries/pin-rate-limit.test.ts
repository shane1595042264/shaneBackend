import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetPinAttempts,
  clearPinAttempts,
  isPinAttemptBlocked,
  recordFailedPinAttempt,
} from "@/modules/tea-entries/pin-rate-limit";

const ENTRY = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  __resetPinAttempts();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-13T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isPinAttemptBlocked", () => {
  it("returns blocked=false for a fresh entry", () => {
    expect(isPinAttemptBlocked(ENTRY)).toEqual({ blocked: false, retryAfterSec: 0 });
  });
});

describe("recordFailedPinAttempt", () => {
  it("does not block under the threshold", () => {
    for (let i = 0; i < 9; i++) {
      expect(recordFailedPinAttempt(ENTRY).blocked).toBe(false);
    }
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
  });

  it("blocks once the threshold is reached and reports a retry-after", () => {
    let state = { blocked: false, retryAfterSec: 0 };
    for (let i = 0; i < 10; i++) {
      state = recordFailedPinAttempt(ENTRY);
    }
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(0);
    expect(state.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("isolates buckets between entries", () => {
    for (let i = 0; i < 10; i++) recordFailedPinAttempt(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(true);
    expect(isPinAttemptBlocked(OTHER).blocked).toBe(false);
  });

  it("resets when the 60s window rolls", () => {
    for (let i = 0; i < 10; i++) recordFailedPinAttempt(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
    // First attempt after window-roll counts again from 1.
    expect(recordFailedPinAttempt(ENTRY).blocked).toBe(false);
  });
});

describe("daily ceiling (SHAN-736)", () => {
  // 9 misses a minute stays under the minute limit forever, which used to
  // make the cap a rate and never a total.
  const pace = (total: number) => {
    let state = { blocked: false, retryAfterSec: 0 };
    for (let i = 0; i < total; i++) {
      if (i > 0 && i % 9 === 0) vi.advanceTimersByTime(60_001);
      state = recordFailedPinAttempt(ENTRY);
    }
    return state;
  };

  it("does not block 49 misses paced under the minute limit", () => {
    expect(pace(49).blocked).toBe(false);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
  });

  it("blocks on the 50th paced miss with a day-long retry-after", () => {
    const state = pace(50);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSec).toBeGreaterThan(60);
    expect(state.retryAfterSec).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("stays blocked across minute rolls until the day window ends", () => {
    pace(50);
    vi.advanceTimersByTime(60 * 60_000);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(isPinAttemptBlocked(ENTRY)).toEqual({ blocked: false, retryAfterSec: 0 });
    expect(recordFailedPinAttempt(ENTRY).blocked).toBe(false);
  });

  it("reports the day block when it outlasts a live minute block", () => {
    pace(40);
    vi.advanceTimersByTime(60_001);
    // 10 in a fresh minute: the minute bucket and the day bucket trip together.
    let state = { blocked: false, retryAfterSec: 0 };
    for (let i = 0; i < 10; i++) state = recordFailedPinAttempt(ENTRY);
    expect(state.retryAfterSec).toBeGreaterThan(60);
  });

  it("is cleared by a correct PIN like the minute bucket", () => {
    pace(50);
    clearPinAttempts(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
  });
});

describe("clearPinAttempts", () => {
  it("clears the bucket so legitimate viewers aren't punished", () => {
    for (let i = 0; i < 10; i++) recordFailedPinAttempt(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(true);
    clearPinAttempts(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
  });
});
