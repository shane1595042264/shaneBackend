import type { NormalizedActivity, IntegrationConnector } from "./types";

export class TwitchConnector implements IntegrationConnector {
  private clientId: string;
  private clientSecret: string;
  private userId: string;

  constructor(clientId: string, clientSecret: string, userId: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.userId = userId;
  }

  /**
   * Twitch uses a client-credentials flow for reading public data like videos.
   * No user refresh token needed — app access token suffices for /helix/videos.
   */
  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
    });

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Twitch token request failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  async fetchActivities(date: string): Promise<NormalizedActivity[]> {
    const accessToken = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Client-ID": this.clientId,
    };

    // Fetch archived VODs (past broadcasts) for this user
    const url = `https://api.twitch.tv/helix/videos?user_id=${this.userId}&type=archive&first=100`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(
        `Twitch videos fetch failed: ${response.status} ${response.statusText}`
      );
    }

    const payload = (await response.json()) as {
      data: Array<{
        id: string;
        title: string;
        created_at: string;
        duration: string; // e.g. "3h2m1s"
        view_count: number;
        stream_id: string;
        language: string;
      }>;
    };

    // Filter to only streams that started on the given date
    const dayVideos = payload.data.filter((v) => {
      const videoDate = v.created_at.slice(0, 10); // "YYYY-MM-DD"
      return videoDate === date;
    });

    if (dayVideos.length === 0) {
      return [];
    }

    // Resolve stream IDs to game names via /helix/streams is not reliable for
    // past broadcasts. Instead, fetch the channel info for the game currently
    // set or use the video title which typically includes the game.
    // For VODs, Twitch doesn't directly embed game_id, so we skip game lookup
    // to keep things simple and reliable.

    return dayVideos.map((video) => ({
      date,
      source: "twitch" as const,
      type: "stream",
      data: {
        id: video.id,
        title: video.title,
        durationSeconds: parseTwitchDuration(video.duration),
        createdAt: video.created_at,
        viewCount: video.view_count,
        streamId: video.stream_id,
        language: video.language,
      },
    }));
  }
}

/**
 * Parses Twitch duration strings like "3h2m1s", "45m0s", "1h0m0s" into seconds.
 */
function parseTwitchDuration(duration: string): number {
  let total = 0;
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  const seconds = duration.match(/(\d+)s/);
  if (hours) total += parseInt(hours[1], 10) * 3600;
  if (minutes) total += parseInt(minutes[1], 10) * 60;
  if (seconds) total += parseInt(seconds[1], 10);
  return total;
}
