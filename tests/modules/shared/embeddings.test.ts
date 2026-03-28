import { describe, it, expect, vi } from "vitest";

// Mock @xenova/transformers to avoid downloading model in tests
vi.mock("@xenova/transformers", () => {
  const mockPipeline = vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue({
      data: new Float32Array(384).fill(0.1),
    })
  );
  return { pipeline: mockPipeline };
});

import { embed, EMBEDDING_DIM } from "@/modules/shared/embeddings";

describe("embed", () => {
  it("should return a 384-dimensional vector", async () => {
    const result = await embed("Hello world");
    expect(result).toHaveLength(384);
  });

  it("should return an array of numbers", async () => {
    const result = await embed("Test text");
    expect(Array.isArray(result)).toBe(true);
    result.forEach((val) => {
      expect(typeof val).toBe("number");
    });
  });

  it("should export EMBEDDING_DIM as 384", () => {
    expect(EMBEDDING_DIM).toBe(384);
  });
});
