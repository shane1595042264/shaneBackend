import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockList, mockGenerate, repo } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGenerate: vi.fn(),
  repo: {
    recordUsage: vi.fn(),
    upsertKey: vi.fn(async (row: Record<string, unknown>) => ({ id: "k1", ...row })),
    listKeys: vi.fn(),
    getSettings: vi.fn(),
    updateKey: vi.fn(),
    getKey: vi.fn(),
  },
}));

vi.mock("@/modules/ai/providers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/ai/providers")>();
  return { ...real, listModels: mockList, generate: mockGenerate };
});
vi.mock("@/modules/ai/repo", () => repo);

import { ProviderError } from "@/modules/ai/providers";
import { sealKey } from "@/modules/ai/crypto";
import { KeyCheckError, addKey, buildExplainPrompt, chooseKey, explain } from "@/modules/ai/service";

const GEMINI = "AIza" + "B".repeat(35);
const ok = { text: "ok", inputTokens: 4, outputTokens: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
});

describe("addKey", () => {
  it("falls through a listed-but-retired model to the next cheapest that answers", async () => {
    mockList.mockResolvedValue(["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-pro", "lyria-3.5"]);
    mockGenerate
      .mockRejectedValueOnce(new ProviderError("model", 404, "no longer available to new users"))
      .mockResolvedValueOnce(ok);
    const row = await addKey("u1", `  ${GEMINI} `);
    expect(mockGenerate.mock.calls.map((c) => c[2])).toEqual(["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"]);
    expect(row).toMatchObject({ provider: "gemini", keyHint: "BBBB", defaultModel: "gemini-2.5-flash-lite" });
    expect(row.models).toEqual(["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-pro"]);
    expect(row.keySealed).not.toContain(GEMINI);
    expect(repo.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: "validate", model: "gemini-2.5-flash-lite" }));
  });

  it("stops at a key the provider rejects", async () => {
    mockList.mockRejectedValue(new ProviderError("auth", 401, "Incorrect API key provided"));
    await expect(addKey("u1", "sk-" + "x".repeat(48))).rejects.toMatchObject({ code: "auth" });
    expect(repo.upsertKey).not.toHaveBeenCalled();
  });

  it("catches a valid key on an account that cannot pay", async () => {
    mockList.mockResolvedValue(["claude-haiku-5-5"]);
    mockGenerate.mockRejectedValue(new ProviderError("quota", 400, "Your credit balance is too low"));
    await expect(addKey("u1", "sk-ant-api03-" + "x".repeat(80))).rejects.toMatchObject({
      code: "quota",
      message: expect.stringContaining("credit balance"),
    });
  });

  it("names the provider problem before calling anything", async () => {
    await expect(addKey("u1", "gsk_" + "x".repeat(50))).rejects.toBeInstanceOf(KeyCheckError);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("chooseKey", () => {
  const k = (provider: string, status = "ok") => ({ provider, status }) as never;
  it("takes the preferred provider when its key works, else the first working key", () => {
    expect(chooseKey([k("gemini"), k("openai")], { preferredProvider: "openai", notesToKnowledge: true })).toMatchObject({ provider: "openai" });
    expect(chooseKey([k("gemini"), k("openai", "failing")], { preferredProvider: "openai", notesToKnowledge: true })).toMatchObject({ provider: "gemini" });
    expect(chooseKey([k("xai", "failing")], { preferredProvider: null, notesToKnowledge: true })).toBeNull();
  });
});

describe("explain", () => {
  const input = { quote: "ring buffer", before: "Linux keeps messages in a", after: "which", title: "Notes", surface: "journal" as const };

  it("uses the preferred model, records usage and strips em dashes", async () => {
    repo.listKeys.mockResolvedValue([
      { id: "k1", provider: "gemini", status: "ok", keySealed: sealKey(GEMINI), defaultModel: "gemini-3.5-flash-lite", preferredModel: "gemini-3.6-flash" },
    ]);
    repo.getSettings.mockResolvedValue({ preferredProvider: null, notesToKnowledge: true });
    mockGenerate.mockResolvedValue({ text: "A fixed-size queue — oldest out.", inputTokens: 120, outputTokens: 40 });
    const out = await explain("u1", input);
    expect(mockGenerate.mock.calls[0][1]).toBe(GEMINI);
    expect(out).toMatchObject({ provider: "gemini", model: "gemini-3.6-flash", explanation: "A fixed-size queue, oldest out." });
    expect(repo.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: "explain", surface: "journal", inputTokens: 120 }));
  });

  it("says so when there is no usable key", async () => {
    repo.listKeys.mockResolvedValue([]);
    repo.getSettings.mockResolvedValue({ preferredProvider: null, notesToKnowledge: true });
    await expect(explain("u1", input)).rejects.toMatchObject({ code: "no_key" });
  });

  it("marks a key failing when the provider refuses it", async () => {
    repo.listKeys.mockResolvedValue([{ id: "k1", provider: "openai", status: "ok", keySealed: sealKey("sk-x"), defaultModel: "gpt-5-nano", preferredModel: null }]);
    repo.getSettings.mockResolvedValue({ preferredProvider: null, notesToKnowledge: true });
    mockGenerate.mockRejectedValue(new ProviderError("quota", 429, "You exceeded your current quota"));
    await expect(explain("u1", input)).rejects.toMatchObject({ code: "provider", kind: "quota" });
    expect(repo.updateKey).toHaveBeenCalledWith("u1", "k1", expect.objectContaining({ status: "failing" }));
  });

  it("builds a prompt with the selection marked and the context around it", () => {
    const { system, prompt } = buildExplainPrompt({ ...input, heading: "What I learned" });
    expect(system).toMatch(/Use the surrounding text/);
    expect(prompt).toContain("Highlighted: <<ring buffer>>");
    expect(prompt).toContain("Document: Notes");
    expect(prompt).toContain("Section: What I learned");
    expect(prompt).toContain("Text before: ...Linux keeps messages in a");
  });
});
