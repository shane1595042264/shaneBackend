/**
 * Manual end-to-end test for the Nibbler ingest contract.
 *
 *   bun scripts/test-nibbler-ingest.ts <pat>
 *   API_URL=http://localhost:8080 bun scripts/test-nibbler-ingest.ts <pat>
 *
 * Mint the PAT in the browser at /settings/tokens with the knowledge:write
 * scope first, then paste the raw "pat_..." token as the argument.
 * Defaults to production (shanebackend-production.up.railway.app).
 */

const PAT = process.argv[2];
if (!PAT) {
  console.error("Usage: bun scripts/test-nibbler-ingest.ts <pat_...>");
  process.exit(1);
}

const BASE_URL =
  process.env.API_URL ?? "https://shanebackend-production.up.railway.app";

async function post(body: unknown, label: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/knowledge/notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PAT}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n[${label}] ${res.status} ${res.statusText}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

await post(
  { text: "prueba = test", source: "nibbler" },
  "1. single, string source"
);

await post(
  {
    text: "дворецкий = butler",
    source: {
      app: "nibbler",
      book: "War and Peace",
      author: "Tolstoy",
      location: "ch. 3",
    },
  },
  "2. single, object source"
);

await post(
  {
    notes: [
      {
        text: "сени = entryway",
        source: { app: "nibbler", book: "War and Peace" },
      },
      {
        text: "kuchnia = kitchen",
        source: { app: "nibbler", book: "Polish lessons" },
      },
    ],
  },
  "3. batch of 2"
);

await post(
  { text: "the speed of light is about 299,792,458 m/s" },
  "4. single, no source (classifier should leave source null)"
);
