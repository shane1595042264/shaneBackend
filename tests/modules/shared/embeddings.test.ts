import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the OpenAI SDK before importing the module under test
vi.mock("openai", () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: mockCreate,
      },
    })),
    __mockCreate: mockCreate,
  };
});

import { embed } from "@/modules/shared/embeddings";
import OpenAI from "openai";

describe("embed", () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    const instance = new (OpenAI as unknown as new () => { embeddings: { create: ReturnType<typeof vi.fn> } })();
    mockCreate = instance.embeddings.create;
  });

  it("should return a 1536-dimensional vector", async () => {
    const fakeEmbedding = new Array(1536).fill(0).map((_, i) => i / 1536);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
    });

    const result = await embed("Hello world");

    expect(result).toHaveLength(1536);
    expect(result).toEqual(fakeEmbedding);
  });

  it("should call OpenAI with model text-embedding-3-small", async () => {
    const fakeEmbedding = new Array(1536).fill(0.1);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
    });

    await embed("Test text");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "text-embedding-3-small",
      })
    );
  });

  it("should pass the input text to the API", async () => {
    const fakeEmbedding = new Array(1536).fill(0.1);
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
    });

    await embed("My specific input text");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "My specific input text",
      })
    );
  });

  it("should return an array of numbers", async () => {
    const fakeEmbedding = [0.1, 0.2, 0.3, ...new Array(1533).fill(0.0)];
    mockCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
    });

    const result = await embed("Test");

    expect(Array.isArray(result)).toBe(true);
    result.forEach((val) => {
      expect(typeof val).toBe("number");
    });
  });

  it("should propagate errors from the OpenAI API", async () => {
    mockCreate.mockRejectedValueOnce(new Error("OpenAI API Error"));

    await expect(embed("Test")).rejects.toThrow("OpenAI API Error");
  });
});
