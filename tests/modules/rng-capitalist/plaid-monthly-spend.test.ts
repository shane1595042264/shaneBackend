// SHAN-584: the monthly spend cache used to be keyed by month alone, so the
// first user's cached total came back for every user. The read must filter on
// the caller's user_id and the write must stamp it and conflict on the pair.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { mockSelect, mockInsert, mockTransactionsGet } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockTransactionsGet: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

vi.mock("plaid", () => ({
  Configuration: class {},
  PlaidApi: class {
    transactionsGet = mockTransactionsGet;
  },
  PlaidEnvironments: { sandbox: "https://sandbox.plaid.com" },
  Products: { Transactions: "transactions" },
  CountryCode: { Us: "US" },
}));

import { getLastMonthSpend } from "@/modules/rng-capitalist/plaid";

const dialect = new PgDialect();
const USER_A = "11111111-1111-4111-8111-111111111111";

// Each db.select() returns a chain whose terminal call resolves to the next
// queued result; every where() argument is recorded for inspection.
const whereArgs: any[] = [];
function queueSelects(...results: any[][]) {
  for (const rows of results) {
    mockSelect.mockImplementationOnce(() => {
      const chain: any = {
        from: () => chain,
        where: (w: any) => {
          whereArgs.push(w);
          return chain;
        },
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    });
  }
}

let insertedValues: any;
let conflictTarget: any;

beforeEach(() => {
  vi.clearAllMocks();
  whereArgs.length = 0;
  insertedValues = undefined;
  conflictTarget = undefined;
  mockInsert.mockImplementation(() => ({
    values: (v: any) => {
      insertedValues = v;
      return {
        onConflictDoNothing: (opts: any) => {
          conflictTarget = opts?.target;
          return Promise.resolve();
        },
      };
    },
  }));
});

describe("getLastMonthSpend cache scoping", () => {
  it("reads the cache by user and month, not month alone", async () => {
    queueSelects([{ totalSpend: "123.45" }]);

    const spend = await getLastMonthSpend(USER_A);

    expect(spend).toBe(123.45);
    const { sql, params } = dialect.sqlToQuery(whereArgs[0]);
    expect(sql).toContain('"user_id"');
    expect(sql).toContain('"year_month"');
    expect(params).toContain(USER_A);
  });

  it("returns null for a user with no cached row and no bank, never another user's total", async () => {
    queueSelects([], []); // cache miss, then no Plaid token

    const spend = await getLastMonthSpend(USER_A);

    expect(spend).toBeNull();
    expect(mockTransactionsGet).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("caches a freshly fetched total under the caller's user_id", async () => {
    queueSelects([], [{ accessToken: "access-sandbox-a" }]);
    mockTransactionsGet.mockResolvedValue({
      data: { transactions: [{ amount: 40 }, { amount: -15 }, { amount: 2.5 }] },
    });

    const spend = await getLastMonthSpend(USER_A);

    expect(spend).toBe(42.5);
    expect(insertedValues).toMatchObject({ userId: USER_A, totalSpend: "42.50" });
    expect(conflictTarget).toHaveLength(2);
  });
});
