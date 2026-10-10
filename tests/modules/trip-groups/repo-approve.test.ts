import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectFor, mockTransaction, mockSet, mockReturning } = vi.hoisted(() => ({
  mockSelectFor: vi.fn(),
  mockTransaction: vi.fn(),
  mockSet: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock("@/db/client", () => {
  // approveSuggestion reads the group with .for("update") inside a transaction
  // (SHAN-563); the claim UPDATE returns rows, the itinerary UPDATE does not.
  const select = () => ({ from: () => ({ where: () => ({ for: mockSelectFor }) }) });
  const update = () => ({
    set: (v: unknown) => {
      mockSet(v);
      const where = { returning: mockReturning, then: (r: (v: unknown) => void) => r(undefined) };
      return { where: () => where };
    },
  });
  return {
    db: {
      transaction: (fn: (tx: unknown) => unknown) => {
        mockTransaction();
        return fn({ select, update });
      },
    },
  };
});

import { approveSuggestion } from "@/modules/trip-groups/repo";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approveSuggestion (SHAN-563)", () => {
  it("merges onto the itinerary read under FOR UPDATE, then claims and writes", async () => {
    mockSelectFor.mockResolvedValue([{ itinerary: { stored: true } }]);
    mockReturning.mockResolvedValue([{ id: "s1" }]);
    const merge = vi.fn(() => ({ merged: true }));

    const result = await approveSuggestion("g1", "s1", "u1", merge);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSelectFor).toHaveBeenCalledWith("update");
    expect(merge).toHaveBeenCalledWith({ stored: true });
    expect(mockSet).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "approved", resolvedBy: "u1" }));
    expect(mockSet).toHaveBeenNthCalledWith(2, expect.objectContaining({ itinerary: { merged: true } }));
    expect(result).toMatchObject({ itinerary: { merged: true } });
  });

  it("returns invalid without claiming or writing when the merge fails", async () => {
    mockSelectFor.mockResolvedValue([{ itinerary: { stored: true } }]);
    expect(await approveSuggestion("g1", "s1", "u1", () => null)).toBe("invalid");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("returns resolved without writing the itinerary when the claim loses", async () => {
    mockSelectFor.mockResolvedValue([{ itinerary: null }]);
    mockReturning.mockResolvedValue([]);
    expect(await approveSuggestion("g1", "s1", "u1", () => ({ merged: true }))).toBe("resolved");
    expect(mockSet).toHaveBeenCalledTimes(1);
  });
});
