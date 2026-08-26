import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchIcons,
  fetchIconPath,
  __resetIconCache,
  __setTreeCache,
} from "@/modules/scoreboard/icon-search";

const mockFetch = vi.fn();
beforeEach(() => {
  __resetIconCache();
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function treeResponse(paths: string[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({ tree: paths.map((p) => ({ path: p, type: "blob" })) }),
  };
}

describe("searchIcons", () => {
  it("fetches the GitHub tree once and caches it", async () => {
    mockFetch.mockResolvedValue(
      treeResponse(["delapouite/8-ball.svg", "lorc/pillow.svg"]),
    );
    await searchIcons("pillow");
    await searchIcons("pillow");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("ranks an exact name match first and returns previewUrl", async () => {
    __setTreeCache(["delapouite/pillow-fight", "lorc/pillow"]);
    const out = await searchIcons("pillow");
    expect(out[0].slug).toBe("lorc/pillow");
    expect(out[0].previewUrl).toBe(
      "https://raw.githubusercontent.com/game-icons/icons/master/lorc/pillow.svg",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ranks eight-ball first for 'pool' via the synonym map", async () => {
    __setTreeCache(["delapouite/eight-ball", "lorc/swimming-pool", "lorc/dart"]);
    const out = await searchIcons("pool");
    expect(out[0].slug).toBe("delapouite/eight-ball");
  });

  it("caps results at 12", async () => {
    __setTreeCache(Array.from({ length: 30 }, (_, i) => `lorc/ball-${i}`));
    const out = await searchIcons("ball");
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it("returns [] for a query with no usable tokens", async () => {
    __setTreeCache(["lorc/pillow"]);
    const out = await searchIcons("a");
    expect(out).toEqual([]);
  });

  it("serves the stale cache when GitHub errors", async () => {
    __setTreeCache(["lorc/pillow"], true);
    mockFetch.mockRejectedValue(new Error("rate limited"));
    const out = await searchIcons("pillow");
    expect(out[0].slug).toBe("lorc/pillow");
  });
});

describe("fetchIconPath", () => {
  it("rejects a slug with path traversal or bad characters", async () => {
    await expect(fetchIconPath("../etc/passwd")).rejects.toThrow();
    await expect(fetchIconPath("lorc/pillow<script>")).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("extracts path d and viewBox, dropping the 512 background path", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/><path fill="#fff" d="M100 100L200 200z"/></svg>',
        ),
    });
    const out = await fetchIconPath("lorc/pillow");
    expect(out.viewBox).toBe("0 0 512 512");
    expect(out.path).toBe("M100 100L200 200z");
    expect(out.path).not.toContain("h512");
    expect(out.slug).toBe("lorc/pillow");
  });

  it("throws when the svg has no non-background path", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          '<svg viewBox="0 0 512 512"><path d="M0 0h512v512H0z"/></svg>',
        ),
    });
    await expect(fetchIconPath("lorc/pillow")).rejects.toThrow(/path/i);
  });

  it("throws on a non-ok response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchIconPath("lorc/missing")).rejects.toThrow();
  });
});
