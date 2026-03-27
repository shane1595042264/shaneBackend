import { db } from "@/db/client";
import { diaryEntries, learnedFacts } from "@/db/schema";
import { sql, desc } from "drizzle-orm";

export interface SimilarityQuery {
  sql: string;
  params: (string | number)[];
}

/**
 * Builds a raw SQL query for pgvector cosine similarity search.
 * Returns { sql, params } without executing the query.
 */
export function buildSimilarityQuery(
  table: string,
  queryEmbedding: number[],
  limit: number,
  excludeDate?: string
): SimilarityQuery {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  if (excludeDate !== undefined) {
    return {
      sql: `SELECT *, (embedding <=> $1::vector) AS distance FROM ${table} WHERE date != $2 ORDER BY distance ASC LIMIT $3`,
      params: [embeddingStr, excludeDate, limit],
    };
  }

  return {
    sql: `SELECT *, (embedding <=> $1::vector) AS distance FROM ${table} ORDER BY distance ASC LIMIT $2`,
    params: [embeddingStr, limit],
  };
}

/**
 * Executes a cosine similarity search against the diary_entries table.
 */
export async function findSimilarEntries(
  queryEmbedding: number[],
  limit = 5,
  excludeDate?: string
) {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  if (excludeDate !== undefined) {
    const result = await db.execute(
      sql`SELECT id, date, content, (embedding <=> ${embeddingStr}::vector) AS distance
          FROM diary_entries
          WHERE date != ${excludeDate}
          ORDER BY distance ASC
          LIMIT ${limit}`
    );
    return result.rows;
  }

  const result = await db.execute(
    sql`SELECT id, date, content, (embedding <=> ${embeddingStr}::vector) AS distance
        FROM diary_entries
        ORDER BY distance ASC
        LIMIT ${limit}`
  );
  return result.rows;
}

/**
 * Executes a cosine similarity search against the learned_facts table.
 */
export async function findRelevantFacts(
  queryEmbedding: number[],
  limit = 5
) {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;

  const result = await db.execute(
    sql`SELECT id, fact_text, (embedding <=> ${embeddingStr}::vector) AS distance
        FROM learned_facts
        ORDER BY distance ASC
        LIMIT ${limit}`
  );
  return result.rows;
}
