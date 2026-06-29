import { describe, it, expect, afterEach } from "vitest";
import { getVersionInfo } from "@/modules/shared/version";

describe("getVersionInfo", () => {
  const original = process.env.RAILWAY_GIT_COMMIT_SHA;

  afterEach(() => {
    if (original === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
    else process.env.RAILWAY_GIT_COMMIT_SHA = original;
  });

  it("returns the short 7-char commit SHA from RAILWAY_GIT_COMMIT_SHA", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "740fe20abcdef1234567890";
    expect(getVersionInfo().commit).toBe("740fe20");
  });

  it("reports 'unknown' when RAILWAY_GIT_COMMIT_SHA is absent", () => {
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    expect(getVersionInfo().commit).toBe("unknown");
  });

  it("reports 'unknown' when RAILWAY_GIT_COMMIT_SHA is empty", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "";
    expect(getVersionInfo().commit).toBe("unknown");
  });

  it("returns a non-negative integer uptimeSeconds", () => {
    const { uptimeSeconds } = getVersionInfo();
    expect(Number.isInteger(uptimeSeconds)).toBe(true);
    expect(uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
