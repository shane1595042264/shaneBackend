/**
 * Typed errors that a repo throws and a route maps to a status code.
 *
 * These live in `shared` rather than next to the repo that throws them for a
 * mechanical reason: every journal/blog route test partially mocks the repo
 * module (`vi.mock("@/modules/journal/versions-repo", () => ({ ... }))`). A
 * class exported from the repo is `undefined` under such a mock unless every
 * one of those factories remembers to restate it, and `err instanceof
 * undefined` throws a TypeError from inside the catch block — turning the
 * mapping bug into a worse one. Twelve test files mock those two repos today;
 * nothing mocks `shared`, so importing the class from here means the route's
 * `instanceof` check is always against the real constructor.
 *
 * `VersionConflictError` predates this file and stays where it is (duplicated
 * in each versions-repo) — the route tests already restate it by hand.
 */

/**
 * A caller named a version number that the record does not have — a 404, not a
 * 500. Thrown by `revertToVersion` on both the journal and the blog; both
 * revert handlers map it to `404 { error: "Target version not found" }`.
 *
 * Before SHAN-530 the journal handler rethrew a plain
 * `Error("Target version not found")` into the global handler, so asking to
 * revert to version 99 of a six-version entry was indistinguishable from the
 * backend being down, and the public docs told agents to pre-flight
 * `/versions` to avoid it.
 */
export class VersionNotFoundError extends Error {
  constructor() {
    super("Target version not found");
    this.name = "VersionNotFoundError";
  }
}

/**
 * A suggestion was approved, rejected or withdrawn between the moment the
 * caller read it and the moment they acted on it. `currentStatus` is the
 * status found inside the transaction, or `null` when the row no longer
 * exists at all (hard delete / bad id in a race), which the routes answer as
 * 404 rather than 409.
 */
export class SuggestionNotPendingError extends Error {
  constructor(public currentStatus: string | null) {
    super("Suggestion not pending");
    this.name = "SuggestionNotPendingError";
  }
}
