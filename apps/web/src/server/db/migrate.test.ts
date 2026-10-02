import { describe, expect, it } from "vitest";

import { migrateDoc, type SchemaMigration } from "./migrate";

/**
 * Contract under test — `src/server/db/migrate.ts`.
 *
 * Documents stored in Mongo carry a `schemaVersion` and are evolved by a chain
 * of single-step migrations. `migrateDoc` walks a document from its current
 * version to the latest one the migration list knows about, applying each step
 * in ascending order:
 *
 *   migrateDoc(doc, migrations): T
 *
 *   - `migrations` is a list of `{ from, to, migrate(doc) }` single steps
 *     (`from -> to`, typically `n -> n + 1`).
 *   - The doc is upgraded by applying every step whose `from` matches the
 *     document's current version, in order, until it reaches the latest `to`.
 *   - A document already at the latest version is returned unchanged (a no-op).
 *   - The input document is never mutated.
 *
 * The specs below prove ordering with a chain whose second step refuses to run
 * unless the first step already ran, so a wrong order fails loudly rather than
 * passing by coincidence.
 */
interface Doc {
  readonly schemaVersion: number;
  readonly name?: string;
  readonly steps?: readonly string[];
}

const V3: readonly SchemaMigration<Doc>[] = [
  {
    from: 1,
    to: 2,
    migrate: (doc) => ({
      ...doc,
      schemaVersion: 2,
      steps: [...(doc.steps ?? []), "1->2"],
      ...(doc.name === undefined ? {} : { name: doc.name.toUpperCase() }),
    }),
  },
  {
    from: 2,
    to: 3,
    migrate: (doc) => {
      if (!(doc.steps ?? []).includes("1->2")) {
        throw new Error("migration 2->3 ran before 1->2");
      }
      return { ...doc, schemaVersion: 3, steps: [...(doc.steps ?? []), "2->3"] };
    },
  },
];

describe("migrateDoc", () => {
  it("applies the chain v1 -> v2 -> v3 in order", () => {
    const doc: Doc = { schemaVersion: 1, name: "alice", steps: [] };

    const result = migrateDoc(doc, V3);

    expect(result).toEqual({
      schemaVersion: 3,
      name: "ALICE",
      steps: ["1->2", "2->3"],
    });
  });

  it("applies only the remaining steps when starting part-way through", () => {
    const doc: Doc = { schemaVersion: 2, name: "bob", steps: ["1->2"] };

    const result = migrateDoc(doc, V3);

    expect(result).toEqual({
      schemaVersion: 3,
      name: "bob",
      steps: ["1->2", "2->3"],
    });
  });

  it("is a no-op when the document is already at the latest version", () => {
    const doc: Doc = { schemaVersion: 3, name: "carol", steps: ["1->2", "2->3"] };

    const result = migrateDoc(doc, V3);

    expect(result).toEqual(doc);
  });

  it("never mutates the input document", () => {
    const doc: Doc = { schemaVersion: 1, name: "dave", steps: [] };

    migrateDoc(doc, V3);

    expect(doc).toEqual({ schemaVersion: 1, name: "dave", steps: [] });
  });
});
