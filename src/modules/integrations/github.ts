import type { NormalizedActivity, IntegrationConnector } from "./types";

export class GitHubConnector implements IntegrationConnector {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const url = `https://api.github.com/search/commits?q=author-date:${date}+author:@me`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.cloak-preview+json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json() as {
      items: Array<{
        sha: string;
        commit: {
          message: string;
          author: { date: string };
        };
        repository: { full_name: string };
        html_url: string;
      }>;
    };

    return data.items.map((item) => ({
      date,
      source: "github" as const,
      type: "commit",
      data: {
        sha: item.sha,
        message: item.commit.message,
        repo: item.repository.full_name,
        url: item.html_url,
        timestamp: item.commit.author.date,
      },
    }));
  }
}
