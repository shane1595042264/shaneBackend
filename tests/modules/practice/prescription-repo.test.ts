import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockSelect() }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: () => mockInsert() }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => mockUpdate() }) }),
    }),
    delete: () => ({
      where: () => ({ returning: () => mockDelete() }),
    }),
  },
}));

import { getPrescription, upsertPrescription, deletePrescription } from "@/modules/practice/prescription-repo";

beforeEach(() => vi.clearAllMocks());

describe("getPrescription", () => {
  it("returns the row when found", async () => {
    mockSelect.mockResolvedValue([{ itemId: "i1", setMode: "time", setSize: 60, restSeconds: 30 }]);
    const got = await getPrescription("i1");
    expect(got?.setSize).toBe(60);
  });

  it("returns null when not found", async () => {
    mockSelect.mockResolvedValue([]);
    expect(await getPrescription("i1")).toBeNull();
  });
});

describe("upsertPrescription", () => {
  it("inserts when missing, returns the new row", async () => {
    mockInsert.mockResolvedValue([{ itemId: "i1", setMode: "time", setSize: 60, restSeconds: 30 }]);
    const got = await upsertPrescription("i1", "u1", { setMode: "time", setSize: 60, restSeconds: 30 });
    expect(got.setSize).toBe(60);
  });
});

describe("deletePrescription", () => {
  it("returns true when row removed", async () => {
    mockDelete.mockResolvedValue([{ id: "row1" }]);
    expect(await deletePrescription("i1")).toBe(true);
  });

  it("returns false when nothing was there", async () => {
    mockDelete.mockResolvedValue([]);
    expect(await deletePrescription("i1")).toBe(false);
  });
});
