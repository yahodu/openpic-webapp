import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempRepoRoot, repoRoot, tempDirs } from "../helpers/adr-guard-fixtures.js";
import type {
  AdrRecordText,
  SourceAdrConsumerIssue,
  SourceFileText,
} from "../helpers/adr-guard-types.js";
import { checkRepositoryAdrConsumers, checkSourceAdrConsumers } from "../helpers/adr-consumers.js";
import { checkRepositoryAdrReferences } from "../helpers/adr-source-references.js";

/**
 * ADR guard, invariant (v) — the guard's six invariants are tabulated once, in
 * `ADR-0302` (`## Decision`, the six-row invariant table). This file owns one of
 * them: a citation must be *accurate*, so a record that declares a `Consumers:`
 * field must name every file that cites it.
 */
/* ------------------------------------------------------------------------- *
 * Invariant (v) — citation accuracy (finding F-N1)
 * ------------------------------------------------------------------------- */

/**
 * Unit contract — invariant (v): a citation must be *accurate*, not merely
 * resolvable (finding F-N1, the land review of PR #465, card `t_03a786bd`).
 *
 * **Why this exists.** Invariant (iv) proves that the record a comment cites
 * *exists*. That is half the question. On the OP-129 tree nine spec headers
 * cited the never-minted `0768`; then a record with that number was minted for
 * the OP-128 lane, and overnight all nine became "valid" references to a record
 * about a different feature — the media signer's account-status gate. The
 * existence guard's real-tree case would go green on that tree, and that is how
 * the defect it was written for survives a renumber. This block pins the half of
 * "is this citation right?" that is decidable from the tree: **a record that
 * declares a `Consumers:` field states who consumes it, and a citing file the
 * record never names is a `consumer-mismatch`.**
 *
 * **Contract pinned here** (RED and GREEN must not diverge):
 *
 * ```
 * interface AdrRecordText { fileName: string; text: string }
 * type SourceAdrConsumerIssue = {
 *   code: "consumer-mismatch" | "unlisted-consumer" | "consumers-malformed";
 *   file: string;   // repo-relative POSIX path of the citing file; for
 *                   // consumers-malformed, the record's file name
 *   line: number;   // 1-based line of the reference; for consumers-malformed,
 *                   // the offending line inside the record
 *   number: string; // the four digits as written, leading zeros kept ("0768")
 *   record: string; // the cited record's file name, e.g. "ADR-0768-….md" (adr-fixture: shape only)
 * }
 * checkSourceAdrConsumers(
 *   sources: readonly SourceFileText[],
 *   records: readonly AdrRecordText[],
 * ): { ok: boolean; issues: SourceAdrConsumerIssue[]; unlisted: SourceAdrConsumerIssue[];
 *      checkedReferences: number; exemptReferences: number; danglingReferences: number;
 *      verifiedReferences: number; declaredRecords: string[] }
 * checkRepositoryAdrConsumers(root: string): typeof checkSourceAdrConsumers
 * ```
 *
 * **Participation is declared, never inferred.** A record participates when its
 * text carries a canonical `Consumers:` field — `- **Consumers:**` at column 0,
 * anywhere in the record, header or body — **or** a `Consumers`-shaped line that
 * is not canonical. A `Consumes:` field is *not* a consumer declaration (records
 * use it for what the decision consumes, e.g. an upstream record); neither is
 * prose that happens to contain the word. A record with no `Consumers:` field
 * yields `unlisted-consumer` for each of its citations — reported and counted,
 * not failed (see the decision below).
 *
 * **A non-canonical shape fails the report, and still declares (finding F2).**
 * Only the canonical field used to declare; every other plausible shape —
 * indented, colon outside the bold, no list dash, a `## Consumers` heading, a
 * plain unbolded field — fell into `unlisted-consumer` with `ok: true`, so one
 * punctuation slip in a hand-written record silently switched enforcement off
 * for it and nothing said so. Pinned here: such a line is reported as
 * `consumers-malformed` **in `issues`**, which makes `ok` `false` — it *fails*,
 * it is not merely counted — with `file` and `record` set to the record's file
 * name, `line` to the offending line inside that record (1-based) and `number`
 * to the record's own four digits. The record still declares, so its citations
 * stay hard-checked: a slip must not disable enforcement as a side effect of
 * being reported. Reporting is per record, not per citation: a malformed field
 * in a record nobody cites is still a failure (that is the shape the 175-record
 * adoption programme will produce). A malformed entry joins the same `issues`
 * array and the same `file`/`line`/`number` ordering as a citation issue, so the
 * citation census identity below holds for a malformed-free record set.
 *
 * **The identification rule** — what makes a citation *verified*. A declaring
 * record identifies a citing file when its **whole text** carries one of:
 *   1. the file's repo-relative path (`apps/…`, `packages/…`) as a path token;
 *   2. the file's **bare name** (`attendee-sessions.test.ts`), but only when that
 *      bare name is **unique across the swept population** — the `sources`
 *      argument here, the whole swept tree in `checkRepositoryAdrConsumers`.
 *      A shared bare name identifies nothing: this head holds 85 `route.ts`
 *      files, so a record naming one of them by path used to verify all 85, and
 *      an unrelated route handler citing ADR-0786 (adr-fixture) left the spec green
 *      (finding F1, the reviewer's probe at `1384ac3`);
 *   3. a `@/…` module specifier that resolves to it — `apps/web/src/` + the
 *      specifier for a module, `apps/web/src/app/` + the specifier for an App
 *      Router route (`@/api/v1/p/attendee-sessions` names the route), optionally
 *      followed by a swept source extension, or a directory containing the file;
 *      a trailing `[...]` annotation group is stripped first
 *      (`@/api/v1/p/attendee-sessions[/current]` names both routes);
 *   4. **in backticks, an identifier the citing file exports** — `export
 *      const|let|var|function|class|interface|type|enum <Name>` or an
 *      `export { <Name> }` alias — with `Name` at least **6** characters.
 *
 * Reading the whole record, not only its `Consumers:` block, is deliberate and
 * measured at this head: 11 of the 32 citations of declaring records are named
 * only in the record's prose (§Decision names the implementation file, the
 * field names the pinning spec), so a block-only reading would fail 11
 * legitimate citations on the pristine tree. The backticked-export channel is
 * what covers the last one — a `packages/contracts` source whose exported
 * `AUTH_ERROR_CODES` the record discusses without naming the file. The 6-char
 * floor keeps short generic names (`GET`, `rate`) from verifying arbitrary
 * files. Leniency is intentional in one direction only: a citation the record
 * *does* talk about must never be reported, because a false failure would be
 * silenced by the next worker with a wider exemption.
 *
 * **Decisions recorded here (measured at this head, not asserted as literals):**
 *   - 4 records declare `Consumers:` (the OP-129 lane), 32 of the 1238 checked
 *     references target them, and all 32 are verified — so the hard rule is
 *     green on the pristine tree, exactly as the card requires. The floor in the
 *     real-tree case is `>= 4`: an accepted ADR is never un-declared, so the
 *     declaring population may only grow, and the floor catches a declaration
 *     being quietly dropped.
 *   - `unlisted-consumer` is counted, not failed. 1206 of the 1238 checked
 *     references at this head cite a record written before the `Consumers:`
 *     convention existed (175 distinct records). Failing them would make the
 *     guard permanently red and demand a 175-record docs programme that this
 *     card's scope lock (test files only, no `docs/adr/` byte) forbids. The code
 *     exists so the debt is visible and a follow-up can drive adoption;
 *     enforcement is **per record**, not per file or directory — the moment a
 *     record adds a `Consumers:` field, every citation of it is hard-checked,
 *     and nothing is exempt.
 *   - A reference whose record does not exist is counted in
 *     `danglingReferences` and not evaluated: invariant (iv) owns it, and the
 *     two counters are reconciled against `checkRepositoryAdrReferences` below.
 *   - A duplicate ADR number does not make this guard throw or go vacuous: a
 *     citation is declared when *any* record with that number declares, and
 *     verified when any of them identifies the citing file. Duplicate reporting
 *     stays `checkAdrNumbers`' job.
 *   - The bare-name channel is gated on population uniqueness (finding F1).
 *     Measured at `1384ac3`: of the 32 verified citations, 20 are named by path,
 *     8 by `@/` specifier and 2 by an exported symbol — **0** by bare name. The
 *     gate therefore costs nothing on the real tree, whose accuracy case also
 *     asserts `issues` empty, so it stays green.
 *   - A non-canonical `Consumers` shape fails the report (finding F2). Measured
 *     over the 289 records at `1384ac3`: 6 canonical field lines, **0**
 *     non-canonical ones and 9 prose mentions that are not field shapes, so the
 *     real-tree case stays green and the rule costs nothing until a hand-written
 *     slip appears.
 *
 * **Marker and population parity.** The accuracy sweep reads exactly the
 * reference population invariant (iv) reads, with the same per-line
 * `adr-fixture` exemption and the same `apps/web/src/test/**` path scope: an
 * exempt reference is counted in `exemptReferences` and never classified, and
 * a marked line in shipped source is still checked (finding F-M1).
 *
 * **Ordering.** `issues` and `unlisted` are sorted by `file`, then `line`, then
 * `number`, so the same sources in any order produce the same report.
 */

/**
 * The record names the fixtures point at. Synthetic on this tree: 0768 and 0786
 * are real records elsewhere, which is the point — the defect this pins is a
 * citation of an existing record that has nothing to do with the citing file.
 */ // adr-fixture: the record names below are fixture targets, not references
const fixtureRecord0768 = "ADR-0768-op128-account-status-gate-pins.md"; // adr-fixture: fixture record name
const fixtureRecord0786 = "ADR-0786-op129-attendee-session-rate-limit-green.md"; // adr-fixture: fixture record name
const fixtureRecord0781 = "ADR-0781-op129-anonymous-attendee-sessions-green.md"; // adr-fixture: fixture record name
const fixtureRecord0780 = "ADR-0780-op129-anonymous-attendee-sessions-red.md"; // adr-fixture: fixture record name
const fixtureRecord0025 = "ADR-0025-auth-guard-table.md"; // adr-fixture: fixture record name

/**
 * Compile-time pins of the accuracy union: an implementation that reports either
 * case without widening `SourceAdrConsumerIssue["code"]` fails `tsc`, not only a
 * runtime assertion.
 */
const consumerMismatchCode: SourceAdrConsumerIssue["code"] = "consumer-mismatch";
const unlistedConsumerCode: SourceAdrConsumerIssue["code"] = "unlisted-consumer";

/**
 * The third code of that union (finding F2), pinned at compile time like its two
 * siblings: the union carries `"consumers-malformed"`, so a rename or a drop on
 * the implementation side fails `tsc` here rather than only at runtime.
 */
const consumersMalformedCode: SourceAdrConsumerIssue["code"] = "consumers-malformed";

/** A record no file of this tree carries: the F2 shape fixtures point at it. */
const fixtureRecord0901 = "ADR-0901-consumers-shape-fixture.md"; // adr-fixture: fixture record name

/**
 * The shape-matrix fixtures (review finding F-A): a record no file of this tree
 * carries, plus two records that deliberately share `0903` for the
 * duplicate-number case — duplicate reporting stays `checkAdrNumbers`' job.
 */
const fixtureRecord0902 = "ADR-0902-consumers-shape-matrix.md"; // adr-fixture: fixture record name
const fixtureRecord0903Alpha = "ADR-0903-consumers-dup-alpha.md"; // adr-fixture: fixture record name
const fixtureRecord0903Beta = "ADR-0903-consumers-dup-beta.md"; // adr-fixture: fixture record name

/** One `docs/adr` record as the accuracy sweep reads it: bare name + whole text. */
function adrRecord(fileName: string, text: string): AdrRecordText {
  return { fileName, text };
}

describe("checkSourceAdrConsumers — a declared consumer is verified", () => {
  it("accepts a citation of a record that names the citing file by repo-relative path", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/classes.test.ts",
        text: "// the class table this spec pins ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0786"],
    });
  });

  it("accepts a citation of a record that names the citing file by module specifier", () => {
    // Arrange — `[...]` is an annotation group, not part of the path: the
    // specifier names the collection route and its `current` child.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0781,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `@/api/v1/p/attendee-sessions[/current]`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/app/api/v1/p/attendee-sessions/current/route.ts",
        text: "// D2 answers this handler ADR-0781", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(1);
  });

  it("accepts a citation of a record that names only the citing file's bare name", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0780,
        [
          "- **Consumers:** the OP-129 RED specs, starting with",
          "  `attendee-sessions.test.ts` (I1–I5)",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// the I1-I5 pins live here ADR-0780", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("accepts a citation of a record that names an identifier the citing file exports", () => {
    // Arrange — the record names the stage helper's API without naming the file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** the rate-limit stage helper",
          "",
          "The gate runs inside `evaluateRateLimit` before the route handler.",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/stage.ts",
        text: "export function evaluateRateLimit() {\n  // stage gate ADR-0786\n}", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("accepts a citation when the record names the citing file's directory", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/server/rate-limit`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/stage.ts",
        text: "// stage gate ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("verifies a citation when any record carrying that number names the citing file", () => {
    // Arrange — a duplicate number is `checkAdrNumbers`' issue; this guard must
    // not throw on it, and must not ignore the record that does name the file.
    const records: AdrRecordText[] = [
      adrRecord("ADR-0786-duplicate-a.md", ["# a record that declares nothing"].join("\n")), // adr-fixture: duplicate-number fixture
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/classes.test.ts",
        text: "// the class table ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.declaredRecords).toEqual(["0786"]);
  });

  it("finds a Consumers: field declared in the record body, not only in its header", () => {
    // Arrange — records add a §Post-review section with its own consumers.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0781,
        [
          "- **Status:** Accepted",
          "- **Lane:** OP-129",
          "",
          "## Post-review status",
          "",
          "- **Consumers:** `apps/web/src/server/db/indexes.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/db/indexes.ts",
        text: "// the slug index entry ADR-0781", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.declaredRecords).toEqual(["0781"]);
  });
});

describe("checkSourceAdrConsumers — a citation the record does not claim", () => {
  it("reports a citation of a record that declares a different consumer and says nothing about this file", () => {
    // Arrange — the F-N1 shape precisely: the target record EXISTS (invariant
    // (iv) is green) but it is another lane's decision.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0768,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/test/integration/media-signed-urls.test.ts`",
          "",
          "## Decision",
          "",
          "The gate runs on the media signer's principal resolution.",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// I3 pins the cookie contract ADR-0768", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: consumerMismatchCode,
          file: "apps/web/src/test/integration/attendee-sessions.test.ts",
          line: 1,
          number: "0768",
          record: fixtureRecord0768,
        },
      ],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0768"],
    });
  });

  it("does not accept a record that names only an exported identifier shorter than six characters", () => {
    // Arrange — the noise floor: a short generic export must not verify a file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** the stage helper", "", "The `rate` value is capped per class."].join(
          "\n"
        )
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/rate-limit/rate.ts",
        text: "export const rate = 1;\n// cap ADR-0786\n", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/rate-limit/rate.ts",
        line: 2,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
  });

  it("reports one issue per occurrence and orders the report by file, then line", () => {
    // Arrange — input order is b, a; the report must be a, b.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        ["- **Consumers:** `apps/web/src/server/rate-limit/classes.test.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/b.ts",
        text: ["// first ADR-0786", "// second ADR-0786"].join("\n"), // adr-fixture: fixture citation targets
      },
      {
        path: "apps/web/src/server/a.ts",
        text: "// once ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues.map((issue) => [issue.file, issue.line])).toEqual([
      ["apps/web/src/server/a.ts", 1],
      ["apps/web/src/server/b.ts", 1],
      ["apps/web/src/server/b.ts", 2],
    ]);
    expect(result.checkedReferences).toBe(3);
    expect(result.verifiedReferences).toBe(0);
  });
});

describe("checkSourceAdrConsumers — records that declare nothing", () => {
  it("reports unlisted-consumer, and does not fail, when the cited record declares no consumers", () => {
    // Arrange
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0025,
        ["# The auth guard table", "", "## Decision", "", "One label table."].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/auth/guards.ts",
        text: "// the label table ADR-0025", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — reported in its own channel, counted, and never a failure.
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [
        {
          code: unlistedConsumerCode,
          file: "apps/web/src/server/auth/guards.ts",
          line: 1,
          number: "0025",
          record: fixtureRecord0025,
        },
      ],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: [],
    });
  });

  it("does not treat a Consumes: field as a consumer declaration", () => {
    // Arrange — `Consumes:` is what the decision consumes, not who consumes it.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0768,
        ["- **Status:** Accepted", "- **Consumes:** ADR-0025 (the auth guard table)"].join("\n") // adr-fixture: fixture citation target
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/auth/guards.ts",
        text: "// the account-status gate ADR-0768", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.unlisted).toEqual([
      {
        code: unlistedConsumerCode,
        file: "apps/web/src/server/auth/guards.ts",
        line: 1,
        number: "0768",
        record: fixtureRecord0768,
      },
    ]);
    expect(result.declaredRecords).toEqual([]);
  });

  it("does not evaluate a reference whose record does not exist", () => {
    // Arrange — invariant (iv) owns the dangling case; this guard must not
    // double-report it, and must still account for it in its counters.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/server/rate-limit`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// a record no file carries ADR-0999", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 0,
      exemptReferences: 0,
      danglingReferences: 1,
      verifiedReferences: 0,
      declaredRecords: ["0786"],
    });
  });
});

/**
 * Finding F1 (the land review of PR #488): the bare-name channel judged a
 * citation by the file's bare name alone, so a record naming *any* `…/route.ts`
 * verified **every** swept file whose bare name is `route.ts` — this head holds
 * 85 of them. The reviewer's probe added a citation of ADR-0786 (adr-fixture) to an
 * unrelated route handler and the whole spec stayed green, although that record names
 * `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`. adr-fixture: the
 * number is a fixture target, not a citation.
 *
 * The rule pinned here: a bare-name mention identifies a file only when that bare
 * name is **unique across the swept population** (the `sources` argument in the
 * pure function, the whole swept tree in `checkRepositoryAdrConsumers`). A shared
 * bare name identifies nothing; the path and `@/` specifier channels keep
 * covering the real citations.
 */
describe("checkSourceAdrConsumers — the bare-name channel needs a unique name (finding F1)", () => {
  it("does not verify a citation from another file that shares the named file's bare name", () => {
    // Arrange — the record names one of the tree's 85 `route.ts` files by full
    // path; the second source shares only the bare name.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0786,
        [
          "- **Status:** Accepted",
          "- **Consumers:** `apps/web/src/app/api/v1/p/attendee-sessions/route.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/app/api/v1/p/attendee-sessions/route.ts",
        text: "// the session rate-limit gate ADR-0786", // adr-fixture: fixture citation target
      },
      {
        path: "apps/web/src/app/api/v1/addons/route.ts",
        text: "// a route the record never names ADR-0786", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — only the path the record names is verified; the shared bare name
    // is not a claim about every file that carries it.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/app/api/v1/addons/route.ts",
        line: 1,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.checkedReferences).toBe(2);
    expect(result.verifiedReferences).toBe(1);
  });

  it("keeps the bare-name channel for a name that is unique across the swept population", () => {
    // Arrange — the gate must not delete the channel: a bare name no other swept
    // file carries still identifies its file.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0780,
        [
          "- **Consumers:** the OP-129 RED specs, starting with",
          "  `attendee-sessions.test.ts` (I1–I5)",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/integration/attendee-sessions.test.ts",
        text: "// the I1-I5 pins live here ADR-0780", // adr-fixture: fixture citation target
      },
      {
        path: "apps/web/src/test/integration/media-signed-urls.test.ts",
        text: "export const nothingToSee = 0;",
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkedReferences).toBe(1);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Finding F2 (the land review of PR #488): only `- **Consumers:**` at column 0
 * with the colon inside the bold declared. Every other plausible shape fell into
 * `unlisted-consumer` with `ok: true`, so one punctuation slip in a hand-written
 * record silently switched enforcement off for it — and the `Consumers:`
 * adoption programme writes the field into 175 records by hand.
 *
 * The contract pinned here:
 *   - a `Consumers`-shaped line that is not the canonical field is reported as
 *     `consumers-malformed` **in `issues`**, so `ok` is `false`: it fails, it is
 *     not merely counted. `file` and `record` carry the record's file name,
 *     `line` the offending line inside that record, `number` the record's digits;
 *   - the record still declares, so a slip cannot switch enforcement off as a
 *     side effect of being reported;
 *   - reporting is per record: a malformed field in a record nobody cites fails
 *     too;
 *   - the canonical shapes keep declaring — the header field and a column-0 field
 *     in a later section are pinned in the blocks above;
 *   - `Consumes:` is another field and prose is not a field shape; both stay
 *     silent (pinned above).
 */
describe("checkSourceAdrConsumers — a malformed Consumers field (finding F2)", () => {
  it.each<[string, string[], number]>([
    [
      "an indented field",
      ["- **Status:** Accepted", "  - **Consumers:** `apps/web/src/server/x.ts`"],
      2,
    ],
    [
      "the colon outside the bold",
      ["- **Status:** Accepted", "- **Consumers**: `apps/web/src/server/x.ts`"],
      2,
    ],
    ["no list dash", ["- **Status:** Accepted", "**Consumers:** `apps/web/src/server/x.ts`"], 2],
    [
      "a section heading",
      ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"],
      2,
    ],
    [
      "a plain, unbolded field",
      ["- **Status:** Accepted", "- Consumers: `apps/web/src/server/x.ts`"],
      2,
    ],
  ])(
    "reports consumers-malformed, and fails the report, for %s",
    (_shape, recordLines, expectedLine) => {
      // Arrange
      const records: AdrRecordText[] = [adrRecord(fixtureRecord0901, recordLines.join("\n"))];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0901", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the slip fails the report and does not switch enforcement off:
      // the record still declares, so the citation it does name is verified.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0901,
          line: expectedLine,
          number: "0901",
          record: fixtureRecord0901,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0901"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  it("still hard-checks a malformed record's citations against a file it does not name", () => {
    // Arrange — the record's field has the colon outside the bold and names
    // `x.ts`; the citing file is `y.ts`.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0901,
        ["- **Status:** Accepted", "- **Consumers**: `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/y.ts",
        text: "// a file that field does not name ADR-0901", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — a malformed entry and a citation entry share one sorted `issues`
    // array (by `file`, so "ADR-…" sorts before "apps/…" in code-unit order).
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0901,
        line: 2,
        number: "0901",
        record: fixtureRecord0901,
      },
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/y.ts",
        line: 1,
        number: "0901",
        record: fixtureRecord0901,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
  });

  it("reports a malformed field in a record that no source cites", () => {
    // Arrange — the adoption programme will write the field into records nobody
    // cites yet; a slip there must not be silent either.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0901,
        ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      { path: "apps/web/src/server/x.ts", text: "// no record is cited here" },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0901,
        line: 2,
        number: "0901",
        record: fixtureRecord0901,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.checkedReferences).toBe(0);
    expect(result.unlisted).toEqual([]);
  });
});

/**
 * The `Consumers` shape matrix (review finding F-A, the follow-up to F2's
 * `consumers-malformed`). F2 pins the five slipping shapes the land review
 * enumerated; every other shape measured at `11ec3d9` was unpinned, so a
 * refactor of the classifier could change it silently. This block pins them.
 *
 * **Canonical-adjacent shapes still declare and stay silent.** The `\s+` after
 * the bullet in the field pattern is load-bearing: several spaces after the
 * dash and a tab after the dash are canonical, and trailing whitespace on the
 * line changes nothing. A tightening to one literal space would only be noticed
 * by the real tree, which carries 0 such lines, so it is pinned here instead.
 *
 * **A space before the colon is a slip, not a silence.** `- **Consumers :**`
 * declares *and* reports `consumers-malformed` at that line: the record keeps
 * hard-checking its citations while the slip fails the report.
 *
 * **Reporting is positional and per offending line.** A malformed entry carries
 * the offending line's 1-based number inside the record — not the canonical
 * field's line, and not a citation's line — one entry per offending line, and
 * with a duplicate number the entry carries that record's own `file` and
 * `record`. Duplicate numbering stays `checkAdrNumbers`' job.
 *
 * **Fences are not parsed** (review finding F-B). The classifier reads physical
 * lines, so a column-0 canonical field inside a fenced sample declares, exactly
 * as it did before F2 existed, while an indented field inside the fence is
 * reported as `consumers-malformed`. No record in this tree carries either
 * shape, so neither costs anything today.
 */
describe("checkSourceAdrConsumers — the Consumers shape matrix (review finding F-A)", () => {
  it.each<[string, string[]]>([
    [
      "several spaces after the bullet",
      ["- **Status:** Accepted", "-   **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "a tab after the bullet",
      ["- **Status:** Accepted", "-\t**Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "trailing spaces on the line",
      ["- **Status:** Accepted", "- **Consumers:** `apps/web/src/server/x.ts`   "],
    ],
  ])("declares, reports nothing and verifies the citation for %s", (_shape, recordLines) => {
    // Arrange — the `\s+` after the bullet is what these three rows protect.
    const records: AdrRecordText[] = [adrRecord(fixtureRecord0902, recordLines.join("\n"))];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });

  it("reports a space before the colon, and keeps the record declaring", () => {
    // Arrange — the colon is inside the bold but not glued to the label.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["- **Status:** Accepted", "- **Consumers :** `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — a slip reports, and does not switch enforcement off.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports the offending line, not the canonical field's line, when both are in the record", () => {
    // Arrange — the canonical field sits on line 4 and the heading on line 256;
    // the report must name 256 (1-based inside the record), not 4. The filler
    // keeps that arithmetic visible instead of hidden in a loop.
    const recordLines = [
      "- **Status:** Accepted", // 1
      "", // 2
      "", // 3
      "- **Consumers:** `apps/web/src/server/x.ts`", // 4
      ...Array.from({ length: 251 }, () => ""), // 5-255
      "## Consumers", // 256
      "- `apps/web/src/server/x.ts`", // 257
    ];
    const records: AdrRecordText[] = [adrRecord(fixtureRecord0902, recordLines.join("\n"))];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — one entry, at the offending line, and the record still declares.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 256,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports one entry per offending line when a record carries two", () => {
    // Arrange — an indented field and a dashless field, on lines 2 and 3.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        [
          "- **Status:** Accepted",
          "  - **Consumers:** `apps/web/src/server/x.ts`",
          "**Consumers:** `apps/web/src/server/x.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — both lines, in line order, and one record's worth of declaration.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 3,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports a malformed record by its own file and record when the number is duplicated", () => {
    // Arrange — both records carry `0903`; only the first is canonical, and only
    // the second is malformed. Duplicate numbering is not this guard's report.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0903Alpha,
        ["- **Status:** Accepted", "- **Consumers:** `apps/web/src/server/x.ts`"].join("\n")
      ),
      adrRecord(
        fixtureRecord0903Beta,
        ["- **Status:** Accepted", "## Consumers", "", "- `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0903", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the entry points at the offending record, not at its twin.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0903Beta,
        line: 2,
        number: "0903",
        record: fixtureRecord0903Beta,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0903"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("declares a canonical field inside a fenced code sample and reports nothing", () => {
    // Arrange — pre-existing behaviour: fences are not parsed, so a column-0
    // field inside a sample declares like any other.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["```md", "- **Consumers:** `apps/web/src/server/x.ts`", "```"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });

  it("reports an indented field inside a fenced code sample (review finding F-B)", () => {
    // Arrange — the same sample, indented: a slip is a slip inside a fence too.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["```md", "  - **Consumers:** `apps/web/src/server/x.ts`", "```"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Residual `Consumers` shapes of the F2 class (review finding F-A) — measured at
 * `11ec3d9` and each one silently unenforced (`declares: false`, `issues: []`,
 * `ok: true`, `unlisted: 1`).
 *
 * **The decision: report them, and keep the record declaring.** The
 * `Consumers:` adoption programme writes the field into 175 records by hand, and
 * the point of F2 is that a punctuation slip must not switch enforcement off
 * without a signal. So the GREEN widens *recognition* — never *canonicality*:
 *
 *   - a leading `>` blockquote marker is stripped per level, with the spaces
 *     that follow it, before the rest of the line is classified;
 *   - `__…__` bold around the label is the same field vocabulary as `**…**`;
 *   - a `\d+[.)]` ordered-list marker stands where the canonical shape has its
 *     `-` bullet.
 *
 * A widened match is **always** `consumers-malformed`: only `-` + `\s+` +
 * `**Consumers:**` at column 0 is canonical, so a shape that merely normalizes
 * to it (a blockquote bullet, an underscore-bold label) still fails the report
 * and still declares — the F2 rule, applied to the wider vocabulary.
 *
 * The widened matcher must not reach prose: the label needs its colon, not just
 * the word, or the real tree's nine prose mentions of `Consumers` would redden
 * the citation sweep.
 */
describe("checkSourceAdrConsumers — residual Consumers shapes report instead of going silent (review finding F-A)", () => {
  it.each<[string, string[]]>([
    ["a blockquote bullet", ["> - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a blockquote with an indented bullet", [">   - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a nested blockquote bullet", ["> > - **Consumers:** `apps/web/src/server/x.ts`"]],
    ["an underscore-bold label", ["- __Consumers:__ `apps/web/src/server/x.ts`"]],
    ["an ordered-list label", ["1. **Consumers:** `apps/web/src/server/x.ts`"]],
    ["an indented ordered-list label", ["  1. **Consumers:** `apps/web/src/server/x.ts`"]],
  ])("reports consumers-malformed, and still declares, for %s", (_shape, fieldLines) => {
    // Arrange — the field is on line 2 of the record, after the status line.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the slip fails the report, and the record keeps hard-checking.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  /**
   * The rows above are six **literal** shapes, and an alternation of exactly
   * those six literals satisfies them while leaving every *composition* of the
   * three recognition axes (blockquote level × list marker × bold-marker style)
   * silently enforced-off — the F-A defect this block exists to close, one level
   * up. The rows below therefore **sample** the compositions, one per axis
   * pairing.
   *
   * What the sample encodes is the contract: the axis vocabulary is recognized
   * by peeling the blockquote levels, then the list marker, then the bold
   * markers — in sequence — because every composition of the three axes is the
   * same field. What the sample does **not** prove is that the classifier cannot
   * *enumerate* instead: an alternation of the pinned literals alone was
   * measured green on this file, so the blocks below widen the sample rather than
   * treating it as that proof.
   */
  it.each<[string, string[]]>([
    ["blockquote × ordered marker", ["> 1. **Consumers:** `apps/web/src/server/x.ts`"]],
    ["blockquote × underscore bold", ["> - __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × asterisk bullet × underscore bold",
      ["> * __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["ordered marker × underscore bold", ["1. __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × ordered marker × underscore bold",
      ["> 1. __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "nested blockquote × ordered marker × underscore bold",
      ["> > 1. __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["parenthesized marker × underscore bold", ["1) __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × plus bullet × underscore bold",
      ["> + __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
  ])(
    "reports consumers-malformed, and still declares, for the shape cross-product %s",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the composition is reported once, and the record keeps
      // hard-checking, exactly like its single-axis siblings.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  /**
   * Eight further samples of the same three axes, composed the other way round —
   * the residue the F2 finding recorded (plus the triple-underscore bold style
   * whose coverage gap card t_53ef51f6 recorded): nested quotes, a column-0 `*`
   * bullet, a `+` bullet, an indented `1)` marker, and the triple-underscore
   * label. Every one of them is the same field vocabulary, so every one must
   * report and keep the record declaring; a classifier that recognizes only the
   * pairings sampled above goes silent on these, which is the F-A defect one
   * composition further out.
   */
  it.each<[string, string[]]>([
    [
      "nested blockquote × ordered marker × double-star bold",
      ["> > 1. **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "blockquote × asterisk bullet × double-star bold",
      ["> * **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "nested blockquote × bullet × underscore bold",
      ["> > - __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["column-0 asterisk bullet × underscore bold", ["* __Consumers:__ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × plus bullet × double-star bold",
      ["> + **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "indented parenthesised ordered marker × underscore bold",
      ["  1) __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    ["triple-underscore bold", ["- ___Consumers:___ `apps/web/src/server/x.ts`"]],
    [
      "blockquote × ordered marker × triple-underscore bold",
      ["> 1. ___Consumers:___ `apps/web/src/server/x.ts`"],
    ],
  ])(
    "reports consumers-malformed, and still declares, for the residual shape %s",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — the residual composition is reported once, and the record keeps
      // hard-checking, exactly like its single-axis siblings.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  /**
   * A heading is a fourth way to write the field. At `319532d` it was classified
   * on the **raw** line, before the blockquote peel, so a heading inside a
   * blockquote was silently unenforced (measured: `issues: []`, `ok: true`,
   * `unlisted: 1`); the GREEN (card t_ba4928fb) peels the blockquote levels
   * first, so both rows below pass since `25a5c52`. That is the exact F2/F-A
   * failure mode: a punctuation slip must not switch enforcement off without a
   * signal. Do not weaken these rows — a blockquoted heading declares exactly
   * like the column-0 one.
   *
   * Of the column-0 controls, only the **colon-less** `## Consumers` heading is
   * pinned elsewhere in this file (four rows: the malformed report, the
   * declaration, the counting arm and the counter reconciliation). The
   * `## **Consumers:** …` column-0 heading was pinned nowhere, so the `it` after
   * the underscore-heading block below pins it.
   */
  it.each<[string, string[]]>([
    ["a double-star bold heading", ["> ## **Consumers:** `apps/web/src/server/x.ts`"]],
    ["a plain heading", ["> ## Consumers: `apps/web/src/server/x.ts`"]],
  ])(
    "reports consumers-malformed, and still declares, for %s inside a blockquote",
    (_shape, fieldLines) => {
      // Arrange — the field is on line 2 of the record, after the status line.
      const records: AdrRecordText[] = [
        adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
      ];
      const sources: SourceFileText[] = [
        {
          path: "apps/web/src/server/x.ts",
          text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
        },
      ];

      // Act
      const result = checkSourceAdrConsumers(sources, records);

      // Assert — a blockquoted heading is not a licence to go silent: it reports,
      // and the record keeps hard-checking.
      expect(result.issues).toEqual([
        {
          code: consumersMalformedCode,
          file: fixtureRecord0902,
          line: 2,
          number: "0902",
          record: fixtureRecord0902,
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.unlisted).toEqual([]);
      expect(result.declaredRecords).toEqual(["0902"]);
      expect(result.verifiedReferences).toBe(1);
    }
  );

  /**
   * The heading axis has a second bold style, and every `__…__` row pinned above
   * composes it with a *list* marker. A heading carries no list marker, so the
   * second peel (`^(?:\d+[.)]|[-*+])[ \t]+`) removes nothing and
   * `## __Consumers:__ …` reaches the label test as prose: measured at `25a5c52`
   * as `issues: []`, `declares: []`, `ok: true`, `unlisted: 1` for all three rows
   * below. `__…__` is the same field vocabulary as `**…**` in every non-heading
   * composition, so the heading axis must not be the one combination left
   * unenforced (finding F1 of card t_ba4928fb).
   *
   * These three rows are green since the `#{1,6}` alternative landed (squash
   * `a96253b`), and the peel now **repeats until the line stops changing**
   * (squash `4a8fe73`, card t_6402c405), so **any number of marker axes
   * compose**: a line may carry a bullet, an ordered marker and a heading in any
   * order and still reach `^Consumers[*_]{0,3}\s*:`. The three-or-more-axis rows
   * below pin that. Measured at `4a8fe73`, each returns one
   * `consumers-malformed` entry at line 2 with `declaredRecords: ["0902"]`,
   * `ok: false`, `unlisted: []` and `verifiedReferences: 1` — the same report
   * shape as its single- and two-axis siblings. Under the earlier one-pass peel
   * those four rows were silent (`issues: []`, `declares: []`, `ok: true`,
   * `unlisted: 1`), which is the composition class the repeat closes.
   *
   * **The two hash negatives are deliberate non-headings.** A heading needs
   * `#{1,6}` *followed by whitespace*, so `##Consumers:` (no space after the
   * hashes) and `####### Consumers:` (seven hashes) are neither headings nor
   * fields: both stay silent and their citation is reported `unlisted-consumer`
   * (control rows after the column-0 heading pin below). A peel that widened
   * `#{1,6}` to `#+`, or dropped the whitespace requirement, would start
   * reading prose as a field — these two rows are what notices.
   *
   * Do not weaken these rows — a second marker is punctuation, not a licence to
   * stop declaring.
   */
  it.each<[string, string[]]>([
    [
      "a double-underscore bold heading inside a blockquote",
      ["> ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a triple-underscore bold heading inside a blockquote",
      ["> ## ___Consumers:___ `apps/web/src/server/x.ts`"],
    ],
    [
      "a double-underscore bold heading at column 0",
      ["## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "an ordered marker before a double-underscore bold heading",
      ["1. ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a double-underscore bold heading before an ordered marker",
      ["## 1. __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a bullet before a double-underscore bold heading",
      ["- ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a blockquote × ordered marker × double-underscore bold heading",
      ["> 1. ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a blockquote × bullet × double-underscore bold heading",
      ["> - ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a nested blockquote × ordered marker × double-underscore bold heading",
      ["> > 1. ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a parenthesized ordered marker before a double-underscore bold heading",
      ["1) ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "a bullet before an ordered marker before a double-underscore bold heading",
      ["- 1. ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "an ordered marker before a bullet before a double-star bold heading",
      ["1. - ## **Consumers:** `apps/web/src/server/x.ts`"],
    ],
    [
      "a triple blockquote × an ordered marker × a double-underscore bold heading",
      ["> > > 1. ## __Consumers:__ `apps/web/src/server/x.ts`"],
    ],
    [
      "an asterisk bullet × a parenthesised ordered marker × a triple-underscore bold heading",
      ["* 1) ## ___Consumers:___ `apps/web/src/server/x.ts`"],
    ],
  ])("reports consumers-malformed, and still declares, for %s", (_shape, fieldLines) => {
    // Arrange — the field is on line 2 of the record, after the status line.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0902, ["- **Status:** Accepted", ...fieldLines].join("\n")),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the underscore-bold heading reports exactly like its
    // double-star sibling, and the record keeps hard-checking.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("reports consumers-malformed for a double-star bold heading at column 0", () => {
    // Arrange — the control the widened peel must not disturb: a column-0
    // heading is matched by the heading test before any peel runs.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["- **Status:** Accepted", "## **Consumers:** `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — still reported once, still declaring, still verified.
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.declaredRecords).toEqual(["0902"]);
    expect(result.verifiedReferences).toBe(1);
  });

  /**
   * The two hash negatives, pinned as silent controls. A heading needs
   * `#{1,6}` *followed by whitespace*, so neither `##Consumers:` (no space after
   * the hashes) nor `####### Consumers:` (seven hashes) is a heading — and with
   * no marker peeled the label does not open the line, so neither is a field
   * either. Both rows therefore stay silent: `issues: []`, `declaredRecords: []`,
   * `ok: true`, and the citation is reported `unlisted-consumer` because the
   * record declares nothing.
   *
   * The direction matters: a peel that widened `#{1,6}` to `#+`, or that dropped
   * the whitespace requirement after the hashes, would start reading a
   * non-field line as a field and redden exactly these two rows.
   */
  it.each<[string, string]>([
    ["no space after the hashes", "##Consumers: `apps/web/src/server/x.ts`"],
    ["seven hashes", "####### Consumers: `apps/web/src/server/x.ts`"],
  ])("stays silent for the non-heading shape with %s", (_shape, fieldLine) => {
    // Arrange — the line that is neither a heading nor a field is line 2.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0902, ["- **Status:** Accepted", fieldLine].join("\n")),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — nothing declared, nothing failed, and the citation is unlisted.
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [
        {
          code: unlistedConsumerCode,
          file: "apps/web/src/server/x.ts",
          line: 1,
          number: "0902",
          record: fixtureRecord0902,
        },
      ],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: [],
    });
  });

  it("reports the citation mismatch too when a blockquote field does not name the citing file", () => {
    // Arrange — the field names `x.ts`; `y.ts` cites the record.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        ["- **Status:** Accepted", "> - **Consumers:** `apps/web/src/server/x.ts`"].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/y.ts",
        text: "// a file the field does not name ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — one malformed entry and one mismatch in the same sorted array
    // (by `file`, so the record name sorts before the citing path).
    expect(result.issues).toEqual([
      {
        code: consumersMalformedCode,
        file: fixtureRecord0902,
        line: 2,
        number: "0902",
        record: fixtureRecord0902,
      },
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/y.ts",
        line: 1,
        number: "0902",
        record: fixtureRecord0902,
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.unlisted).toEqual([]);
    expect(result.verifiedReferences).toBe(0);
  });

  it("keeps prose that starts with the word Consumers silent", () => {
    // Arrange — a widened classifier must not read an English sentence as a
    // field: the label needs its colon, not just the word.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0902,
        [
          "- **Status:** Accepted",
          "Consumers of this record are the OP-129 specs listed below.",
          "- **Consumers:** `apps/web/src/server/x.ts`",
        ].join("\n")
      ),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/x.ts",
        text: "// the helper the field names ADR-0902", // adr-fixture: fixture citation target
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert — the canonical field on line 3 declares; line 2 is prose.
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 1,
      declaredRecords: ["0902"],
    });
  });
});

/**
 * The colon-bearing App Router handler of OP-124 I5 — `POST …/uploads:link`. The
 * `:` is literal: it is the contract's URL, not a placeholder.
 */
const colonRoutePath =
  "apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts";

/**
 * Its colon-free sibling, the `params` handler, and the **decoy** of every row:
 * the truncated colon token is exactly this file's directory, so a channel that
 * reads the truncation verifies the sibling instead of the route.
 */
const uploadsParamsRoutePath =
  "apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts";

/** The record every row cites: OP-124 GREEN, which carries the `uploads:link` rule. */
const fixtureRecord0721 = "ADR-0721-op124-single-put-complete-link-only-green.md"; // adr-fixture: fixture record name

/**
 * The two-`route.ts` population every row of the two blocks below runs: the colon
 * route and its colon-free sibling, both citing the OP-124 GREEN record on line 1.
 */
function colonRouteSources(): SourceFileText[] {
  return [
    {
      path: colonRoutePath,
      text: "// the link-only attach ADR-0721", // adr-fixture: fixture citation target
    },
    {
      path: uploadsParamsRoutePath,
      text: "// the session route ADR-0721", // adr-fixture: fixture citation target
    },
  ];
}

/**
 * Finding F-C (the OP-128 follow-up, card `t_399927fa`): a **colon-bearing path**
 * is a live route in this tree and neither token pattern could see it.
 *
 * `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts`
 * is a shipped App Router handler (OP-124 I5; `ADR-0721` — adr-fixture: the record
 * the rows below cite); the `:` is literal,
 * because the contract's URL is `POST …/uploads:link`, not a placeholder.
 * `RECORD_PATH_TOKEN_PATTERN` and `RECORD_SPECIFIER_TOKEN_PATTERN` were
 * `[A-Za-z0-9_./[\\]-]` before #506 widened both to `[A-Za-z0-9_./[\\]:-]`, so the `:`
 * ended the match and the token truncated at `…/events/[eventId]/uploads`.
 *
 * The truncation is *worse than a miss*: `…/uploads` is the directory of the
 * colon-free sibling `…/uploads/params/route.ts`, so the channel verifies the
 * sibling and reports the colon file — the one the record actually names — as a
 * `consumer-mismatch`. Every row below therefore runs the same two-`route.ts`
 * population and asserts both halves: exactly one verified reference (the file
 * the record claims) and exactly one mismatch (the sibling). A channel that
 * verified both would be worthless, and a row that only counted
 * `verifiedReferences` would pass on the truncation, because the truncation
 * verifies something too.
 *
 * **RED.** The full-path row, the directory row, the `@/` row and the
 * colon-bearing `path:line` row fail; the two control rows (the colon-free
 * sibling named by path, and the colon-free sibling named with a `:42`
 * annotation) pass. The GREEN widens the class to carry `:` — a legal POSIX file
 * name character, and the separator Next.js route segments use here.
 *
 * **`path:line` is trimmed, not swallowed** (review finding F-C2). No record in
 * this tree writes `path:42` today (measured: 0 tokens under `docs/adr`), so
 * widening cannot redden the tree — but the moment `:` is a token character a
 * `…/route.ts:42` token stops matching its file exactly *and* stops matching the
 * directory arm, which needs a following `/`: a **false negative**, the one
 * direction the guard must never drift in. Two trims ship: the one
 * `trimPathToken` already applies to trailing punctuation — a trailing
 * `:<digits>` is a line annotation and is trimmed — plus `stripTrailingAnnotation`
 * (#519; dot allowed in the suffix since #522) for a `:<suffix>` such as `:D1.2`
 * on a token that names no swept file (F-C3's blocks). "Unsupported" was the
 * review's alternative; trimming wins because it keeps a shape that works today.
 *
 * The token class is the whole change: nothing here asks the guard to resolve a
 * dynamic segment, and no fixture of this block exists on disk — `records` and
 * `sources` are in-memory fixtures, so the real `ADR-0721` (adr-fixture: it does
 * declare `Consumers:` since PR #511) is not consulted; nothing here reads a file.
 */
describe("checkSourceAdrConsumers — a colon-bearing path token (review finding F-C)", () => {
  it("keeps the colon-free sibling verified when the record names it by path (control)", () => {
    // Arrange — the harness itself: on this record text nothing depends on `:`.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert — the sibling the record names verifies; the colon route does not.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon route when the record names its full repo-relative path", () => {
    // Arrange — the path as `git ls-files` prints it: `:` included.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon route when the record names the `…/uploads:link` directory", () => {
    // Arrange — the directory arm needs the `:` too: `…/uploads:link` + `/` is
    // what the citing path starts with, and `…/uploads` + `/` is the sibling.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("verifies the colon route when the record names it as an `@/app/api/…` specifier", () => {
    // Arrange — a real shape, not a hypothetical: the OP-124 RED record
    // (adr-fixture: `ADR-0720`) cites this feature's routes as
    // `@/app/api/v1/…/route`, so the specifier channel carries `:` for the same
    // reason the path channel does.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Finding F-C2, the second half of the same change: widening the token class to
 * carry `:` must not cost the `path:line` shape. The two rows here isolate it —
 * one colon-free, one colon-bearing — so a GREEN that widens the class without
 * trimming `:<digits>` reddens the first row and a GREEN that trims but does not
 * widen reddens the second.
 */
describe("checkSourceAdrConsumers — a trailing `:line` annotation (review finding F-C2)", () => {
  it("keeps the colon-free sibling verified when the record annotates its path with `:42`", () => {
    // Arrange — `docs/adr` carries no such token today, so this row costs
    // nothing on the current tree and only pins the future.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:42`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("verifies the colon route when the record annotates its path with `:42`", () => {
    // Arrange — both characters at once: the `:` of the segment and the `:` of
    // the line annotation. Only trimming `:<digits>` after a widened match
    // leaves the file's path behind.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts:42`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });
});

/**
 * Finding F-C3 (the OP-128 follow-up, card `t_4a7e37a6`): the one **narrowing**
 * direction the colon widening introduced.
 *
 * `trimPathToken` drops a trailing `:<digits>` annotation only, so a record that
 * glues a path to a non-digit suffix — `…/route.ts:D1`, no space after the colon
 * — now yields a token that names no file at all. Before `:` became a token
 * character the match stopped at the colon and identified `…/route.ts`; the same
 * record text therefore went from *verified* to `consumer-mismatch` **in the file
 * the record does talk about**. Nothing in the token class is wrong: `:` is a
 * legal path character and stays one. The missing half is the trim.
 *
 * **The decision pinned here is (a): the citation verifies.** The rule that
 * satisfies every row of this block is *literal first, annotation second* — a
 * token whose written form names a swept file is read exactly as written, and
 * only a token that names no swept file at all is re-read with **one** trailing
 * `:<suffix>` stripped. Verification is unchanged for every token that resolves
 * today, and the narrowing direction is closed.
 *
 * **Why not a blind trim.** The directory row of the block above writes a token
 * that ends in `:link` and *does* identify the colon route through the directory
 * arm (`…/uploads:link` + `/`). A blind `:\w+$` rewrite turns it into `…/uploads`,
 * which is the sibling's directory, so both files verify and the decoy vanishes
 * — the exact wrong-file failure the widening removed, reintroduced for a shape
 * the block above already pins. The `still identifies exactly the colon route`
 * row below restates that pin inside this block, so the two annotation rows
 * cannot be satisfied by over-trimming.
 *
 * **Why not (b), a distinct named failure.** The shape occurs **0** times under
 * `docs/adr` on this base (`grep -rEn "(apps|packages)/[A-Za-z0-9_./[]-]+:[A-Za-z]"
 * docs/adr` prints nothing, and the same holds for `@/`-prefixed tokens), so a
 * hard failure would make the guard *stricter* than it was before the widening,
 * for a benign annotation, and would need a new issue code for a suffix the guard
 * cannot distinguish from a path. The module's stated bias runs the other way: a
 * false accept hides a citation the record does talk about, while a false failure
 * gets silenced with a wider exemption. This block is drift control, not a live
 * defect.
 *
 * **RED** before #519 (`8b6abe2`): the two path rows (a non-digit suffix on the
 * colon-free sibling and the colon route) and the `@/` row failed with *both* citing
 * files reported as `consumer-mismatch` and `verifiedReferences: 0` — the record names
 * a file and the guard accuses it. The three controls pass: `:42`, `:42.`, and the
 * directory token. All six pass at this head; #519 changed the helper only.
 *
 * In-memory, like the two blocks above: nothing here reads a file, and the rows
 * reuse the same two-`route.ts` population and the same fixture record name, so
 * this block adds no fixture and no `docs/adr` record. Two colons compose here —
 * the segment's own `:` and the annotation's — and the two-level shape
 * (`…:a:b`) is deliberately out of scope: one trailing suffix is the contract.
 */
describe("checkSourceAdrConsumers — a non-digit colon suffix on a path token (review finding F-C3)", () => {
  it("verifies the colon-free sibling when the record glues `:D1` to its path", () => {
    // Arrange — the finding's literal shape: a `.ts` path followed by `:D1` and
    // nothing else, so no space ends the token and the trim is the only way out.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:D1`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert — the file the record names verifies; the sibling is the mismatch.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon route when the record glues `:D1` to its colon-bearing path", () => {
    // Arrange — both colons at once: the segment's `:` mid-path and the
    // annotation's `:` at the end. Stripping the last suffix must leave the
    // segment's colon intact.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts:D1`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("keeps verifying the colon-free sibling when the record annotates its path with `:42` (control)", () => {
    // Arrange — the numeric annotation the shipped trim already drops. This row
    // and the next must stay green through the change.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:42`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("keeps verifying the colon-free sibling when the annotation ends with a full stop (control)", () => {
    // Arrange — `:42.` is the prose shape: the punctuation trim runs first and
    // leaves `:42`, which the numeric trim then drops.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:42.`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
  });

  it("still identifies exactly the colon route for the `…/uploads:link` directory token (control)", () => {
    // Arrange — the token whose written form resolves, and therefore must never
    // be re-read: it ends in `:link`, and a blind suffix trim would rewrite it to
    // the sibling's directory and verify both files.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert — one verified (the colon route), one mismatch (the sibling): the
    // population is not swallowed.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon route when the record glues `:D1` to its `@/app/api/…` specifier", () => {
    // Arrange — the same narrowing in the specifier channel: `:` is a token
    // character for both patterns, so `trimPathToken`'s gap is both patterns'
    // gap. Fixing only the path channel would leave this arm narrowing.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts:D1`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });
});
/**
 * Finding F-C3, dotted half (the OP-128 follow-up, card `t_177466f2`): the
 * delivered annotation trim now covers every suffix its class can see — the dot
 * included since #522.
 *
 * `stripTrailingAnnotation` strips one trailing `:<suffix>`; the class is
 * `[A-Za-z0-9_.-]` since #522 (`df6a199`), `[A-Za-z0-9_-]+` before that widening.
 * So `…/route.ts:D1` reduces to `…/route.ts` and verifies (pinned above), and so
 * do `:D1.2` and `:4.2`. Before the widening the dot survived, the token named no
 * swept file, and the guard reported **both** citing files as a mismatch.
 *
 * The decided contract (pin card `t_4a7e37a6`) is "**one** trailing `:<suffix>`"
 * with no character restriction. A dotted suffix is one trailing `:<suffix>`, so
 * the class was the gap, not the decision. `.` is already a token character in
 * both `RECORD_PATH_TOKEN_PATTERN` and `RECORD_SPECIFIER_TOKEN_PATTERN`, so the
 * suffix sits *inside* the matched token: the trim is the only remedy, and
 * widening the single-suffix class by one dot served both channels.
 *
 * **RED** before the fix: the two path rows and the `@/` row failed with both
 * citing files reported as `consumer-mismatch` and `verifiedReferences: 0`. They
 * pass at this head, and the two controls pass and must stay passing.
 *
 * **The literal-first precedence stays.** `…/uploads:link` is a real directory of
 * this population, so a blind suffix trim (`:…` with a dot in the class too)
 * rewrites it to the sibling's directory, verifies both files, and reintroduces
 * the wrong-file failure the F-C block above removed. The directory-token row
 * below restates that pin inside this block: the widened class is the fix,
 * dropping `namesAFile` first is not.
 *
 * In-memory, like the blocks above: no fixture is read, and every row runs the
 * same two-`route.ts` population and the same `ADR-0721` (adr-fixture: the record
 * the rows below cite, never read from disk).
 */
describe("checkSourceAdrConsumers — a dotted colon suffix on a path token (review finding F-C3)", () => {
  it("verifies the colon-free sibling when the record glues `:D1.2` to its path", () => {
    // Arrange — the same `.ts`-followed-by-`:D1` shape the block above pins,
    // with a dotted section pointer after the colon. No space ends the token.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:D1.2`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert — the file the record names verifies; only the sibling mismatches.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon-free sibling when the record glues the section pointer `:4.2` to its path", () => {
    // Arrange — the plausible prose shape: a dotted section number, no letter
    // anywhere in the suffix, so a class widened only for `[A-Za-z]` cannot
    // satisfy it.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:4.2`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("keeps the literal-first precedence for the `…/uploads:link` directory token (control)", () => {
    // Arrange — a token whose written form names a directory of the population,
    // so it must never be re-read with a suffix stripped, whatever the suffix
    // class becomes.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert — one verified (the colon route), one mismatch (the sibling): the
    // population is not swallowed.
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("keeps verifying the colon route when the record glues `:D1` to its colon-bearing path (control)", () => {
    // Arrange — the undotted suffix on the colon route: green today, and a row
    // that must not regress when the class is widened.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `apps/web/src/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads:link/route.ts:D1`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: uploadsParamsRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });

  it("verifies the colon-free sibling when the record glues `:D1.2` to its `@/app/api/…` specifier", () => {
    // Arrange — the same dotted suffix in the specifier channel; both token
    // patterns keep `.`, so fixing only the path channel leaves this arm
    // narrowing.
    const records: AdrRecordText[] = [
      adrRecord(
        fixtureRecord0721,
        [
          "- **Consumers:** `@/app/api/v1/tenants/[tenantId]/events/[eventId]/uploads/params/route.ts:D1.2`",
        ].join("\n")
      ),
    ];

    // Act
    const result = checkSourceAdrConsumers(colonRouteSources(), records);

    // Assert
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: colonRoutePath,
        line: 1,
        number: "0721",
        record: fixtureRecord0721,
      },
    ]);
    expect(result.verifiedReferences).toBe(1);
    expect(result.checkedReferences).toBe(2);
  });
});

describe("checkSourceAdrConsumers — the fixture marker", () => {
  it("exempts a marked fixture line from the accuracy rule", () => {
    // Arrange — the marker's scope is the guard's own test tree, same as (iv).
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/test/unit/other.test.ts`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/test/unit/x.test.ts",
        text: "// a synthetic citation ADR-0786 adr-fixture", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result).toEqual({
      ok: true,
      issues: [],
      unlisted: [],
      checkedReferences: 0,
      exemptReferences: 1,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0786"],
    });
  });

  it("does not exempt a marked line outside the guard's test tree", () => {
    // Arrange — finding F-M1's shape: the marker appended to a real pointer.
    const records: AdrRecordText[] = [
      adrRecord(fixtureRecord0786, "- **Consumers:** `apps/web/src/test/integration/x.test.ts`"),
    ];
    const sources: SourceFileText[] = [
      {
        path: "apps/web/src/server/media/signed-urls.ts",
        text: "// a real pointer adr-fixture ADR-0786", // adr-fixture: the line under test is itself a fixture
      },
    ];

    // Act
    const result = checkSourceAdrConsumers(sources, records);

    // Assert
    expect(result.exemptReferences).toBe(0);
    expect(result.checkedReferences).toBe(1);
    expect(result.issues).toEqual([
      {
        code: consumerMismatchCode,
        file: "apps/web/src/server/media/signed-urls.ts",
        line: 1,
        number: "0786",
        record: fixtureRecord0786,
      },
    ]);
  });
});

describe("checkRepositoryAdrConsumers — the repository sweep", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the repository's real source tree as citation-accurate", () => {
    // Act — every citation of a declaring record at this head is made by a file
    // that record names: the OP-129 lane declares its consumers, and the
    // pristine tree is clean under the rule.
    const report = checkRepositoryAdrConsumers(repoRoot);

    // Assert
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    // Non-vacuity: a green report must come from the tree's declaring records,
    // not from an empty population. An accepted ADR is never un-declared, so the
    // floor may only rise.
    expect(report.declaredRecords.length).toBeGreaterThanOrEqual(4);
    expect(report.verifiedReferences).toBeGreaterThan(0);
    // Every evaluated reference is classified exactly once.
    expect(report.verifiedReferences + report.issues.length + report.unlisted.length).toBe(
      report.checkedReferences
    );
  });

  it("sweeps exactly the reference population the existence guard sweeps", () => {
    // Act
    const existence = checkRepositoryAdrReferences(repoRoot);
    const accuracy = checkRepositoryAdrConsumers(repoRoot);

    // Assert — the two guards cannot drift apart: same fixtures exempted, same
    // references seen, the dangling ones credited to invariant (iv).
    expect(accuracy.exemptReferences).toBe(existence.exemptReferences);
    expect(accuracy.checkedReferences + accuracy.danglingReferences).toBe(
      existence.checkedReferences
    );
  });

  it("reports a wrong-but-existing target in a throwaway repository", () => {
    // Arrange — the record exists, the citation resolves, and the record is
    // about another lane's file: the case invariant (iv) cannot see.
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0768-op128-account-status-gate-pins.md": [
        // adr-fixture: fixture record name
        "- **Status:** Accepted",
        "- **Consumers:** `apps/web/src/test/integration/media-signed-urls.test.ts`",
      ].join("\n"), // adr-fixture: fixture record name
      "apps/web/src/test/integration/attendee-sessions.test.ts": "// I3 ADR-0768\n", // adr-fixture: fixture citation target
      "packages/contracts/src/empty.ts": "export const nothing = 0;",
    });

    // Act
    const report = checkRepositoryAdrConsumers(root);

    // Assert
    expect(report).toEqual({
      ok: false,
      issues: [
        {
          code: consumerMismatchCode,
          file: "apps/web/src/test/integration/attendee-sessions.test.ts",
          line: 1,
          number: "0768",
          record: fixtureRecord0768,
        },
      ],
      unlisted: [],
      checkedReferences: 1,
      exemptReferences: 0,
      danglingReferences: 0,
      verifiedReferences: 0,
      declaredRecords: ["0768"],
    });
  });

  it("reports the undeclared-record citation in the unlisted channel instead of failing it", () => {
    // Arrange
    const root = makeTempRepoRoot({
      "docs/adr/ADR-0025-auth-guard-table.md": "# The auth guard table", // adr-fixture: fixture record name
      "apps/web/src/server/auth/guards.ts": "// the label table ADR-0025", // adr-fixture: fixture citation target
      "packages/contracts/src/empty.ts": "export const nothing = 0;",
    });

    // Act
    const report = checkRepositoryAdrConsumers(root);

    // Assert
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.unlisted).toEqual([
      {
        code: unlistedConsumerCode,
        file: "apps/web/src/server/auth/guards.ts",
        line: 1,
        number: "0025",
        record: fixtureRecord0025,
      },
    ]);
    expect(report.declaredRecords).toEqual([]);
  });

  it("throws an ENOENT error when the root has no docs/adr directory", () => {
    // Arrange — a wrong root must fail loudly, never pass vacuously.
    const root = makeTempRepoRoot({ "apps/web/src/x.ts": "// no references here" });

    // Act + Assert
    expect(() => checkRepositoryAdrConsumers(root)).toThrow(
      expect.objectContaining({ code: "ENOENT" })
    );
  });
});
