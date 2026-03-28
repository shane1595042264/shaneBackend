import { describe, it, expect, vi } from "vitest";

// Mock the db client to avoid DATABASE_URL requirement
vi.mock("@/db/client", () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { buildSimilarityQuery } from "@/modules/shared/vector-search";

describe("buildSimilarityQuery", () => {
  const sampleEmbedding = new Array(384).fill(0.1);

  it("should return an object with sql and params properties", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    expect(result).toHaveProperty("sql");
    expect(result).toHaveProperty("params");
    expect(typeof result.sql).toBe("string");
    expect(Array.isArray(result.params)).toBe(true);
  });

  it("should include the table name in the SQL", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    expect(result.sql).toContain("diary_entries");
  });

  it("should include cosine distance operator in SQL", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    // pgvector cosine distance operator is <=>
    expect(result.sql).toContain("<=>");
  });

  it("should include LIMIT in SQL", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 10);

    expect(result.sql).toContain("LIMIT");
  });

  it("should include the limit value in params", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 7);

    expect(result.params).toContain(7);
  });

  it("should include the embedding as a param", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    // The embedding should appear in params as a string vector or directly
    expect(result.params.length).toBeGreaterThan(0);
    // First param should be the embedding representation
    expect(result.params[0]).toContain("[");
  });

  it("should include WHERE clause to exclude a date when excludeDate is provided", () => {
    const result = buildSimilarityQuery(
      "diary_entries",
      sampleEmbedding,
      5,
      "2025-01-15"
    );

    expect(result.sql).toMatch(/WHERE|where/);
    expect(result.params).toContain("2025-01-15");
  });

  it("should NOT include WHERE clause when excludeDate is not provided", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    // Should not have a WHERE clause for date exclusion
    expect(result.sql).not.toMatch(/WHERE\s+date/i);
  });

  it("should work with learned_facts table", () => {
    const result = buildSimilarityQuery("learned_facts", sampleEmbedding, 3);

    expect(result.sql).toContain("learned_facts");
  });

  it("should order by similarity (cosine distance ascending)", () => {
    const result = buildSimilarityQuery("diary_entries", sampleEmbedding, 5);

    expect(result.sql).toMatch(/ORDER BY/i);
  });
});
