import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubConnector } from "@/modules/integrations/github";

describe("GitHubConnector", () => {
  const token = "test-token";
  let connector: GitHubConnector;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new GitHubConnector(token);
  });

  it("should fetch commits for a given date and return NormalizedActivity[]", async () => {
    const mockResponse = {
      items: [
        {
          sha: "abc123",
          commit: {
            message: "feat: add feature",
            author: { date: "2024-01-15T10:00:00Z" },
          },
          repository: { full_name: "user/repo" },
          html_url: "https://github.com/user/repo/commit/abc123",
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      date: "2024-01-15",
      source: "github",
      type: "commit",
      data: {
        sha: "abc123",
        message: "feat: add feature",
        repo: "user/repo",
        url: "https://github.com/user/repo/commit/abc123",
        timestamp: "2024-01-15T10:00:00Z",
      },
    });
  });

  it("should call the GitHub search commits API with correct URL and headers", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    } as Response);

    await connector.fetchActivities("2024-01-15");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/search/commits?q=author-date:2024-01-15+author:@me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.cloak-preview+json",
        }),
      })
    );
  });

  it("should return an empty array when no commits are found", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toEqual([]);
  });

  it("should handle multiple commits", async () => {
    const mockResponse = {
      items: [
        {
          sha: "abc123",
          commit: {
            message: "feat: first",
            author: { date: "2024-01-15T09:00:00Z" },
          },
          repository: { full_name: "user/repo1" },
          html_url: "https://github.com/user/repo1/commit/abc123",
        },
        {
          sha: "def456",
          commit: {
            message: "fix: second",
            author: { date: "2024-01-15T11:00:00Z" },
          },
          repository: { full_name: "user/repo2" },
          html_url: "https://github.com/user/repo2/commit/def456",
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const activities = await connector.fetchActivities("2024-01-15");

    expect(activities).toHaveLength(2);
    expect(activities[0].data.sha).toBe("abc123");
    expect(activities[1].data.sha).toBe("def456");
  });

  it("should throw an error when the API response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    await expect(connector.fetchActivities("2024-01-15")).rejects.toThrow();
  });
});
