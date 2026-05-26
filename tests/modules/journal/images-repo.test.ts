import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelect, mockInsert } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: { select: mockSelect, insert: mockInsert },
}));
vi.mock("@/db/schema", () => ({
  journalImages: {
    id: {},
    uploadedBy: {},
    mimeType: {},
    byteSize: {},
    data: {},
    createdAt: {},
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c: unknown, v: unknown) => ({ c, v })),
}));

import { insertImage, getImageById } from "@/modules/journal/images-repo";

beforeEach(() => vi.clearAllMocks());

describe("insertImage", () => {
  it("inserts the row with byteSize derived from the buffer and returns the new id", async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const valuesSpy = vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: "img-1" }])),
    }));
    mockInsert.mockReturnValue({ values: valuesSpy });

    const result = await insertImage({
      uploadedBy: "user-1",
      mimeType: "image/png",
      data: buf,
    });

    expect(result).toEqual({ id: "img-1" });
    expect(valuesSpy).toHaveBeenCalledWith({
      uploadedBy: "user-1",
      mimeType: "image/png",
      byteSize: buf.byteLength,
      data: buf,
    });
  });
});

describe("getImageById", () => {
  it("returns the row when found", async () => {
    const row = {
      id: "img-1",
      mimeType: "image/png",
      byteSize: 8,
      data: Buffer.from([1, 2, 3, 4]),
    };
    const chain: Record<string, unknown> = {};
    const promise = Promise.resolve([row]);
    for (const m of ["from", "where", "limit"]) chain[m] = vi.fn(() => chain);
    Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
    mockSelect.mockReturnValue(chain);

    const result = await getImageById("img-1");
    expect(result).toEqual(row);
  });

  it("returns null when no row matches", async () => {
    const chain: Record<string, unknown> = {};
    const promise = Promise.resolve([]);
    for (const m of ["from", "where", "limit"]) chain[m] = vi.fn(() => chain);
    Object.assign(chain, { then: (r: any, j: any) => promise.then(r, j) });
    mockSelect.mockReturnValue(chain);

    const result = await getImageById("missing");
    expect(result).toBeNull();
  });
});
