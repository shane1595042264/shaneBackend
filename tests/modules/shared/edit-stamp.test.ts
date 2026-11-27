import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { stampIfChanged } from "@/modules/shared/edit-stamp";
import { journalComments } from "@/db/schema";

const dialect = new PgDialect();

// SHAN-747: the mocked-drizzle repo tests cannot tell whether this compiles to
// the SQL we mean, so compile it for real.
describe("stampIfChanged", () => {
  it("keeps the old stamp unless the stored content differs from the new text", () => {
    const q = dialect.sqlToQuery(
      stampIfChanged(journalComments.content, "new text", journalComments.editedAt),
    );
    expect(q.sql).toBe(
      'case when "journal_comments"."content" is distinct from $1 then now() else "journal_comments"."edited_at" end',
    );
    expect(q.params).toEqual(["new text"]);
  });
});
