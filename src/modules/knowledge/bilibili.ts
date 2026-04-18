/**
 * Bilibili Dynamic (动态) posting service.
 * Posts knowledge entries as text dynamics to the authenticated user's feed.
 *
 * Requires env vars:
 *   BILIBILI_SESSDATA — session cookie from Bilibili login
 *   BILIBILI_CSRF     — bili_jct CSRF token from Bilibili cookies
 */

interface KnowledgeEntry {
  word: string;
  language: string;
  category: string;
  definition?: string | null;
  pronunciation?: string | null;
  partOfSpeech?: string | null;
  exampleSentence?: string | null;
  labels?: unknown;
}

function formatDynamic(entry: KnowledgeEntry): string {
  const lines: string[] = [];

  // Title line
  const meta = [entry.language, entry.category].filter(Boolean).join(" | ");
  lines.push(`📚 ${entry.word} (${meta})`);

  if (entry.pronunciation) {
    lines.push(`🔊 ${entry.pronunciation}`);
  }

  if (entry.partOfSpeech) {
    lines.push(`📝 ${entry.partOfSpeech}`);
  }

  if (entry.definition) {
    lines.push("");
    lines.push(entry.definition);
  }

  if (entry.exampleSentence) {
    lines.push("");
    lines.push(`💡 ${entry.exampleSentence}`);
  }

  const labels = Array.isArray(entry.labels) ? (entry.labels as string[]) : [];
  if (labels.length > 0) {
    lines.push("");
    lines.push(labels.map((l) => `#${l}`).join(" "));
  }

  lines.push("");
  lines.push("#知识分享 #KnowledgeBase");

  return lines.join("\n");
}

export async function postToBilibili(entry: KnowledgeEntry): Promise<void> {
  const sessdata = process.env.BILIBILI_SESSDATA;
  const csrf = process.env.BILIBILI_CSRF;

  if (!sessdata || !csrf) {
    console.log("[bilibili] Skipping post — BILIBILI_SESSDATA or BILIBILI_CSRF not configured");
    return;
  }

  const text = formatDynamic(entry);

  const body = {
    dyn_req: {
      content: {
        contents: [{ raw_text: text, type: 1, biz_id: "" }],
      },
      scene: 4,
    },
    meta: {
      app_meta: { from: "create.dynamic.web", mobi_app: "web" },
    },
  };

  try {
    const resp = await fetch(
      `https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${csrf}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `SESSDATA=${sessdata}; bili_jct=${csrf}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: JSON.stringify(body),
      }
    );

    const result = (await resp.json()) as { code: number; message: string; data?: unknown };

    if (result.code !== 0) {
      console.error(`[bilibili] Post failed: code=${result.code} message=${result.message}`);
      return;
    }

    console.log(`[bilibili] Posted dynamic for "${entry.word}" successfully`);
  } catch (err: any) {
    console.error(`[bilibili] Post error: ${err.message}`);
  }
}
