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

describe("clearPinAttempts", () => {
  it("clears the bucket so legitimate viewers aren't punished", () => {
    for (let i = 0; i < 10; i++) recordFailedPinAttempt(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(true);
    clearPinAttempts(ENTRY);
    expect(isPinAttemptBlocked(ENTRY).blocked).toBe(false);
  });
});
