import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "../helpers/adr-guard-fixtures.js";
import { readTextFile } from "../helpers/adr-source-references.js";
import {
  documentedFieldNames,
  scanWrittenFields,
  type WrittenFieldReport,
} from "../helpers/design-doc-field-sets.js";

/**
 * Guard — the design doc's `### 14.3 `subscriptions`` field table and the two
 * billing **mint** routes must name the same fields.
 *
 * **Why this guard exists.** The `subscriptions` table drifted from its
 * writers **twice in one section**: `checkout` was written by both mint paths
 * (ADR-0420/0421) before its row existed, and `currency` was copied from
 * `prices[]` at mint long before its row existed. Neither drift was visible to
 * any spec, because nothing read the table; both were found by a reviewer
 * reading prose. This spec makes the class mechanical: the written set is
 * parsed out of the routes, the documented set out of the table, and every
 * written field must be documented.
 *
 * **Direction of the check.** Only `written − meta ⊆ documented` is asserted.
 * The reverse is deliberately *not* a requirement: a documented field may be
 * written by a path this scan does not cover — `currentPeriodStart`,
 * `currentPeriodEnd` and `nextChargeAt` are written by the payment webhook
 * projection (`server/billing/webhook-projection.ts`), not by either mint. That
 * reverse diff is pinned explicitly below so the scope boundary is stated
 * rather than implied.
 *
 * **This is a characterization pin, not a RED spec.** It passes at its cut,
 * because the `currency` row landed first (PR #860). It must not be weakened to
 * pass: a red here means the doc and the writers have diverged again.
 *
 * **Discrimination is proven without touching a route file.** The two parsers
 * are pure and are pinned against synthetic strings: a literal that gains a
 * top-level key is reported as undocumented, a nested object contributes only
 * its parent key, and a table row's `/`- and `,`-packed names both parse out.
 * Only the `real tree` cases read the filesystem, and every set is sorted
 * before it is compared, so nothing depends on directory order.
 *
 * **Every depth-1 key shape is pinned (OP-140 follow-up).** A hand-edited mint
 * literal can name a property in more than one way, and a shape the parser
 * cannot see is a field the guard cannot check. The `depth-1 key shapes`
 * describe below pins the whole matrix, one case per row: a plain key, a
 * double- and a single-quoted key (`"taxMinor": 0` — the quotes are stripped
 * and the name counts), a static template key (`` `taxMinor`: 0 `` — same),
 * a spread (`...baseDoc` — `baseDoc` surfaces as a phantom key, a loud red), a
 * method shorthand (`async markPaid() {}` — `async` surfaces as the phantom
 * key, also loud), a template value (skipped whole, never read as a key), the
 * six comment shapes below, and a string value that carries a `//`
 * (`url: "https://example.com/x"` — the string branch consumes it at the
 * opening quote, so it never starts a comment). Two shapes are refused rather
 * than guessed:
 * a **computed** key (`[TAX_KEY]: 1`, `` `${TAX_KEY}`: 1 ``), whose name is not
 * in the text, and an **inline literal spread** (`...{ … }`), whose keys are
 * this literal's own. In both cases a returned set would silently omit a field
 * that was really written — the exact drift class this guard exists to close —
 * so the scan throws instead.
 *
 * **Comments are not code (OP-140 follow-up).** The matrix originally accepted
 * a comment as code: the comment's first word took the key position and
 * surfaced as a phantom key, which was called a loud red. Probing the real
 * parser falsified that — the phantom is only loud for *some* comment shapes.
 * After `// status is derived at mint` the first word is a documented field, so
 * the `taxMinor: 0` that follows it was never examined: the scan returned
 * `["status"]` and the undocumented write passed silently. After
 * `// 1) currency comes from prices[]` it returned no phantom at all (`1` is
 * not an identifier and `)` closed the literal early). A block comment before
 * `billingCycle` whose first word was the documented `currency` was silent too.
 * So the reader now skips a `//` comment to the end of the line and
 * a `/*`-opened block comment whole, leaving the key position untouched: a
 * comment contributes no key, and the property after it is still read. Each
 * comment shape — between two properties with a documented first word, between
 * two properties as a numbered comment, as a block comment between properties,
 * before the first property, and trailing after the last — is its own matrix
 * row.
 *
 * **Why the real-tree census does not move.** Neither mint route writes a
 * quoted, template or computed property name today (verified against the two
 * route files, not assumed: no `"name":` and no `[name]:` at depth 1 in
 * either), and no comment sits inside either mint literal (both routes write
 * their comments above the write call — `subscriptions.insertOne(` or
 * `updateOne(` / `$set:` — never between its braces), so the parser tightening
 * changed the parsed set for synthetic literals only. The measured census stays
 * at 24 and 25 keys, 21 written after meta, 24 documented.
 *
 * **One measured limitation, pinned by a narrowed vacuity case (OP-140
 * follow-up).** The comment branch cannot tell code from a value, so a `/*`
 * inside a *value* expression starts a comment skip and swallows the rest of
 * the literal. That shape is reachable only through a regex literal (such as
 * `/[/*]/`), which no §14.3 field can hold, but it is the guard's own
 * silent-skip class. The real-tree case below therefore reddens on **every
 * `/*` in a value position inside an anchored mint literal** (measured `0`
 * today, over all five literal bodies): a future edit that puts one there
 * reddens there, naming the file, the anchor, the literal, the offset and the
 * fix, instead of losing the rest of that literal's keys in silence.
 *
 * **The ban is exactly the harmful class, and that is measured, not assumed.**
 * The first cut of the case counted a `/*` **anywhere** in a literal body and
 * reddened on two shapes the shipped reader handles correctly: a marker inside
 * a quoted string value (`mandateStatus: "pending/*x"` reddened at offset 376
 * while every census case stayed green — the string branch consumes the literal
 * at its opening quote) and a complete block comment (a `/*` through its
 * closing delimiter) sitting where a property may start (the comment branch
 * skips it whole and still reads the property after it — the `a block comment
 * between properties` matrix row pins that). Both are exempt now, so the
 * remaining red is always the value-position skip. A *complete* value-position
 * comment is still flagged: without a real tokenizer the reader cannot tell it
 * from `/[/*]/`, and a block comment in a mint literal belongs above the write
 * call anyway.
 */

/** The design doc that carries §14.3. */
const DESIGN_DOC_PATH = "docs/Notification and Database Design.md";

/**
 * Collection meta, excluded from the per-field comparison.
 *
 * `_id`, `createdAt`, `updatedAt` and `schemaVersion` are stamped on every
 * collection, so the design doc documents them **once for the whole schema**
 * instead of as per-collection rows in §14.3: §13.3 `tenants` spells the
 * metadata out as the combined row ``| `createdAt`, `updatedAt`, `schemaVersion` |``
 * and lists `_id` as Mongo's implicit primary key, and §26 "Schema versioning"
 * requires every collection that may evolve to carry `schemaVersion`. Both mint
 * literals still write them, so the comparison subtracts them; any other
 * undocumented key is drift.
 */
const SUBSCRIPTION_META_KEYS: ReadonlySet<string> = new Set([
  "_id",
  "createdAt",
  "updatedAt",
  "schemaVersion",
]);

/** One mint route, the write-opening anchors it is scanned for, and the size it must scan to. */
interface MintRouteSource {
  /** Repo-relative POSIX path of the route file. */
  readonly path: string;
  /** The substrings that open a `subscriptions` write in that file. */
  readonly anchors: readonly string[];
  /** How many object literals the anchors must open (a vacuity guard). */
  readonly literals: number;
  /** How many distinct depth-1 keys those literals must carry (a vacuity guard). */
  readonly keys: number;
}

/**
 * The two routes that mint a `subscriptions` row for a self-serve checkout —
 * the only writers of the fields this table documents. Both are read as text:
 * importing them would pull the Next.js runtime into a unit spec.
 *
 * `literals` and `keys` are measured, not assumed: if a refactor renames the
 * scoped `subscriptions` handle, or splits a write, the scan finds fewer
 * literals and this pin reddens instead of passing vacuously on an empty set.
 */
const MINT_ROUTES: readonly MintRouteSource[] = [
  {
    path: "apps/web/src/app/api/v1/tenants/[tenantId]/billing/checkout/route.ts",
    anchors: ["subscriptions.insertOne(", "$set:"],
    literals: 3,
    keys: 24,
  },
  {
    path: "apps/web/src/app/api/v1/tenants/[tenantId]/billing/upgrade/route.ts",
    anchors: ["$set:", "subscriptions.insertOne("],
    literals: 2,
    keys: 25,
  },
];

/** What the real tree measures: both sets, plus the union the guard compares. */
interface RealTreeFields {
  /** §14.3's documented field names, sorted. */
  readonly documented: string[];
  /** One report per mint route, in {@link MINT_ROUTES} order. */
  readonly routes: readonly {
    readonly route: MintRouteSource;
    readonly report: WrittenFieldReport;
  }[];
  /** Every key the two mints write, meta included, sorted. */
  readonly written: string[];
  /** {@link written} minus {@link SUBSCRIPTION_META_KEYS}, sorted. */
  readonly writtenFields: string[];
}

/**
 * Read the design doc and both mint routes off the real tree and parse them.
 * Called from the `real tree` cases only, so the synthetic cases stay pure.
 *
 * @returns The documented set, the per-route reports and the written union.
 */
function measureRealTree(): RealTreeFields {
  const documented = documentedFieldNames(readTextFile(join(repoRoot, DESIGN_DOC_PATH)));
  const routes = MINT_ROUTES.map((route) => ({
    route,
    report: scanWrittenFields(readTextFile(join(repoRoot, route.path)), route.anchors),
  }));
  const written = [...new Set(routes.flatMap(({ report }) => report.keys))].sort();

  return {
    documented,
    routes,
    written,
    writtenFields: written.filter((key) => !SUBSCRIPTION_META_KEYS.has(key)),
  };
}

/**
 * The guard's one comparison: written keys the doc does not document.
 *
 * @param written - The written field names, meta already subtracted.
 * @param documented - §14.3's field names.
 * @returns The undocumented keys, in the input order.
 */
function undocumentedKeys(written: readonly string[], documented: readonly string[]): string[] {
  return written.filter((key) => !documented.includes(key));
}

/** One anchored object literal read off a real route file. */
interface AnchoredLiteralBody {
  /** The anchor substring that opened the literal. */
  readonly anchor: string;
  /** The literal's text, from its opening `{` through its matching `}`. */
  readonly body: string;
}

/**
 * Slice the body of every object literal an anchor opens out of one route
 * file's text — the same anchor-to-first-`{` rule {@link scanWrittenFields}
 * uses, so the vacuity case below measures exactly the literals the census
 * reads.
 *
 * Braces are balanced with quoted strings stepped over, so a `{` or `}` inside
 * a string value cannot end a body early. Comments are deliberately **not**
 * skipped here: slicing is not the place to decide whether a marker is
 * harmful — {@link blockCommentMarkers} classifies each one against the
 * reader's own string and comment branches.
 *
 * @param source - One route file's whole text.
 * @param anchors - The write-opening substrings to slice.
 * @returns One body per anchor occurrence, in source order.
 * @throws If an anchor opens no object literal, as `scanWrittenFields` does.
 */
function anchoredLiteralBodies(source: string, anchors: readonly string[]): AnchoredLiteralBody[] {
  const bodies: AnchoredLiteralBody[] = [];

  for (const anchor of anchors) {
    let from = 0;
    for (;;) {
      const anchorIndex = source.indexOf(anchor, from);
      if (anchorIndex === -1) {
        break;
      }
      const openBrace = source.indexOf("{", anchorIndex);
      if (openBrace === -1) {
        throw new Error(`The anchor \`${anchor}\` opens no object literal.`);
      }

      let depth = 0;
      let index = openBrace;
      while (index < source.length) {
        const char = source.charAt(index);
        if (char === '"' || char === "'" || char === "`") {
          index += 1;
          while (index < source.length && source.charAt(index) !== char) {
            index += source.charAt(index) === "\\" ? 2 : 1;
          }
          index += 1;
          continue;
        }
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            bodies.push({ anchor, body: source.slice(openBrace, index + 1) });
            break;
          }
        }
        index += 1;
      }

      from = openBrace + 1;
    }
  }

  return bodies;
}

/**
 * The offsets of the `/*` markers in one literal body that the reader's
 * comment branch turns into a key-swallowing skip.
 *
 * The reader steps over a quoted string before it looks for a comment, so a
 * marker inside a string value never reaches the comment branch. It also skips
 * a complete block comment whole and leaves the key position untouched, so a
 * comment that begins where a property may start costs no key — the matrix's
 * block-comment rows pin that. Both shapes are parser-safe and are exempt here;
 * a vacuity case that reddened on them named a defect while nothing was broken.
 *
 * What remains is the harmful class: a marker in a **value** position, which
 * the comment branch cannot tell from a regex literal such as `/[/*]/`, and a
 * marker that the body never closes. Either way the skip runs on to the next
 * closing delimiter — possibly past the end of this literal — and every key in
 * between is lost in silence. The exempt position is the literal's own start, a
 * `{`, or a `,` at the literal's top level, with only whitespace and comments
 * since.
 *
 * @param body - One anchored literal's text, from its opening `{` through its
 *   matching `}`.
 * @returns The harmful marker offsets, in source order.
 */
function blockCommentMarkers(body: string): number[] {
  const markers: number[] = [];
  let depth = 0;
  let atPropertyStart = false;
  let index = 0;

  while (index < body.length) {
    const char = body.charAt(index);

    // A string is data from its opening quote on, so a `/*` inside one never
    // reaches the comment branch.
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < body.length && body.charAt(index) !== char) {
        index += body.charAt(index) === "\\" ? 2 : 1;
      }
      index += 1;
      atPropertyStart = false;
      continue;
    }

    // A line comment runs to the end of its line; a `/*` inside it is text.
    if (char === "/" && body.charAt(index + 1) === "/") {
      const lineEnd = body.indexOf("\n", index + 2);
      index = lineEnd === -1 ? body.length : lineEnd;
      continue;
    }

    if (char === "/" && body.charAt(index + 1) === "*") {
      const commentEnd = body.indexOf("*/", index + 2);
      const closes = commentEnd !== -1;
      if (!atPropertyStart || !closes) {
        markers.push(index);
      }
      index = closes ? commentEnd + 2 : body.length;
      // A comment changes no key position: the property after it is still read.
      continue;
    }

    if (char === "{") {
      depth += 1;
      atPropertyStart = true;
    } else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      atPropertyStart = false;
    } else if (char === "[" || char === "(") {
      depth += 1;
      atPropertyStart = false;
    } else if (char === "," && depth === 1) {
      atPropertyStart = true;
    } else if (!/\s/.test(char)) {
      atPropertyStart = false;
    }

    index += 1;
  }

  return markers;
}

/** One literal body and the lines the marker detector must redden on. */
interface LiteralMarkerShape {
  /** The shape's name, used as the case title. */
  readonly shape: string;
  /** The literal's body lines, between its braces. */
  readonly body: readonly string[];
  /** The 1-based line of each harmful marker, counting the opening `{` as line 1. */
  readonly flagged: readonly number[];
}

/**
 * The detector matrix: the shapes a `/*` can take inside a mint literal, and the
 * markers that must be reported as harmful.
 *
 * The exempt rows are the parser-safe class the first cut of the vacuity case
 * reddened on — a marker inside a string value (the reader consumes the string
 * at its opening quote) and a complete block comment where a property may start
 * (the reader skips it whole and still reads the property after it). The
 * flagged rows are the value-position skip, the shape reachable only through a
 * regex literal, and the unterminated comment whose skip swallows the rest of
 * the literal.
 */
const LITERAL_MARKER_SHAPES: readonly LiteralMarkerShape[] = [
  {
    shape: "a marker in a regex value position, which starts a key-swallowing skip",
    body: ["pattern: /[/*]/,", 'status: "active",'],
    flagged: [2],
  },
  {
    shape: "a marker in a regex value position that a later `*/` closes",
    body: ["pattern: /[/*]/,", "note: 1 */,", 'status: "active",'],
    flagged: [2],
  },
  {
    shape: "an unterminated block comment at key position, whose skip swallows the literal",
    body: ["/* taxMinor is billed at renewal", 'status: "active",'],
    flagged: [2],
  },
  {
    shape: "a marker inside a double-quoted string value, which the string branch consumes",
    body: ['mandateStatus: "pending/*x",', 'status: "active",'],
    flagged: [],
  },
  {
    shape: "a marker inside a single-quoted string value",
    body: ["note: 'a /* b',", 'status: "active",'],
    flagged: [],
  },
  {
    shape: "a marker inside a template value",
    body: ["note: `a /* b`,", 'status: "active",'],
    flagged: [],
  },
  {
    shape: "a marker inside a line comment, which is text to the end of the line",
    body: ['status: "active",', "// see /* the mint table", "taxMinor: 0,"],
    flagged: [],
  },
  {
    shape: "a complete block comment between properties, which the reader skips whole",
    body: ['status: "active",', "/* currency comes from prices[] */", 'billingCycle: "monthly"'],
    flagged: [],
  },
  {
    shape: "a complete block comment before the first property",
    body: ["/* taxMinor is billed at renewal */", 'status: "active",'],
    flagged: [],
  },
  {
    shape: "a complete trailing block comment, which contributes no key",
    body: ['status: "active",', "/* taxMinor is billed at renewal */"],
    flagged: [],
  },
];

/** One way a hand-edited mint literal can name a depth-1 property. */
interface DepthOneKeyShape {
  /** The shape's name, used as the case title. */
  readonly shape: string;
  /** The literal's body lines, at depth 1. */
  readonly body: readonly string[];
  /** The depth-1 names the scan must report, sorted. */
  readonly keys: readonly string[];
}

/**
 * The shape matrix: the ways a mint literal can name a property, and the set
 * the scan must report for each.
 *
 * The matrix is the contract, so every row is its own case. Two rows are
 * *supposed* to report a name that is not a real field — a spread reports its
 * target (`baseDoc`) and a method shorthand reports `async` — because a phantom
 * key fails `written − meta ⊆ documented` loudly, which is safe; a *missing*
 * key passes, which is not. Comments are the counter-example that replaced this
 * rule: a comment is not code, its first word must never stand in the key
 * position, and the property after it must still be read, so every comment row
 * reports exactly the real properties around it and no phantom (see the module
 * TSDoc). Quoted and static template keys are real names and must be reported.
 * The two shapes that cannot be resolved at all — a computed key and an inline
 * literal spread — are pinned separately as throws.
 */
const DEPTH_ONE_KEY_SHAPES: readonly DepthOneKeyShape[] = [
  {
    shape: "a plain key",
    body: ['currency: "INR",', "status"],
    keys: ["currency", "status"],
  },
  {
    shape: "a double-quoted key, with the quotes stripped",
    body: ['"taxMinor": 0,', "status"],
    keys: ["status", "taxMinor"],
  },
  {
    shape: "a single-quoted key, with the quotes stripped",
    body: ["'taxMinor': 0,", "status"],
    keys: ["status", "taxMinor"],
  },
  {
    shape: "a static template key, with the backticks stripped",
    body: ["`taxMinor`: 0,", "status"],
    keys: ["status", "taxMinor"],
  },
  {
    shape: "a spread, which surfaces its target as a phantom key",
    body: ["...baseDoc,", "status"],
    keys: ["baseDoc", "status"],
  },
  {
    shape: "a method shorthand, which surfaces `async` as a phantom key",
    body: ["async markPaid() {},", 'status: "active"'],
    keys: ["async", "status"],
  },
  // A comment used to report its first word as a phantom key, which the matrix
  // accepted as "loud, therefore safe". That posture is replaced: the phantom
  // was only loud for *some* comment shapes — a documented first word or a
  // numbered comment swallowed the property after it in silence — so a comment
  // now contributes no key, and each row expects only the real properties
  // around it.
  {
    shape: "a line comment between properties, whose first word is a documented field",
    body: ['status: "active",', "// currency comes from prices[]", "taxMinor: 0,"],
    keys: ["status", "taxMinor"],
  },
  {
    shape: "a numbered line comment between properties",
    body: ['status: "active",', "// 1) currency comes from prices[]", "taxMinor: 0,"],
    keys: ["status", "taxMinor"],
  },
  {
    shape: "a block comment between properties",
    body: ['status: "active",', "/* currency comes from prices[] */", 'billingCycle: "monthly"'],
    keys: ["billingCycle", "status"],
  },
  {
    shape: "a comment before the first property",
    body: ["// taxMinor is billed at renewal", 'status: "active",'],
    keys: ["status"],
  },
  {
    shape: "a trailing line comment, which contributes no key",
    body: ['status: "active",', "// taxMinor is billed at renewal"],
    keys: ["status"],
  },
  {
    shape: "a trailing block comment, which contributes no key",
    body: ['status: "active",', "/* taxMinor is billed at renewal */"],
    keys: ["status"],
  },
  {
    shape: "a template value, which is skipped whole and never read as a key",
    body: ["note: `auto`,", 'status: "active"'],
    keys: ["note", "status"],
  },
  {
    shape: "a string value containing `//`, which never starts a comment",
    body: ['url: "https://example.com/x",', 'status: "active",', "taxMinor: 0,"],
    keys: ["status", "taxMinor", "url"],
  },
  {
    shape: "a key whose colon is separated by whitespace",
    body: ["cancelReason : null,", 'status: "active"'],
    keys: ["cancelReason", "status"],
  },
];

describe("design doc §14.3 `subscriptions` field list", () => {
  describe("reading the documented set", () => {
    it("takes the column headed `Field` and splits its `/` and `,` packed names", () => {
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "| Type | Field | Purpose |",
        "| --- | --- | --- |",
        "| ObjectId | `tenantId` | owner |",
        "| date | `currentPeriodStart` / `currentPeriodEnd` | window |",
        "| — | `cancelAt`, `cancelledAt`, `cancelReason` | end of period |",
        '| `"pending" \\| "active"` | `mandateStatus` | its own axis |',
      ].join("\n");

      expect(documentedFieldNames(markdown)).toEqual([
        "cancelAt",
        "cancelReason",
        "cancelledAt",
        "currentPeriodEnd",
        "currentPeriodStart",
        "mandateStatus",
        "tenantId",
      ]);
    });

    it("throws when the doc carries no §14.3 `subscriptions` section", () => {
      const markdown = ["### 14.2 `tenants`", "", "| Field | Type |", "| --- | --- |"].join("\n");

      expect(() => documentedFieldNames(markdown)).toThrow(/14\.3/);
    });

    it("does not borrow a later section's table when §14.3 has none", () => {
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "No table here.",
        "",
        "### 14.4 `billingTransactions`",
        "",
        "| Field | Type |",
        "| --- | --- |",
        "| `amountMinor` | int |",
      ].join("\n");

      expect(() => documentedFieldNames(markdown)).toThrow(/14\.3/);
    });

    it("throws when §14.3's table has no `Field` column", () => {
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "| Type | Purpose |",
        "| --- | --- |",
        "| ObjectId | owner |",
      ].join("\n");

      expect(() => documentedFieldNames(markdown)).toThrow(/has no `Field` column/);
    });
  });

  describe("reading the written set", () => {
    it("returns the parent key of a nested object, not its children", () => {
      const source = [
        "await subscriptions.insertOne({",
        "  dunning: { attemptCount: 0, remindersSent: [] },",
        '  status: "incomplete",',
        "});",
      ].join("\n");

      expect(scanWrittenFields(source, ["subscriptions.insertOne("]).keys).toEqual([
        "dunning",
        "status",
      ]);
    });

    it("never reads a key out of a string value, and counts a shorthand property", () => {
      const source = [
        "await subscriptions.insertOne({",
        '  note: "a, b } c",',
        '  cancelReason: "say \\"hi\\", ok",',
        "  tenantId,",
        '  status: "active",',
        "});",
      ].join("\n");

      expect(scanWrittenFields(source, ["subscriptions.insertOne("]).keys).toEqual([
        "cancelReason",
        "note",
        "status",
        "tenantId",
      ]);
    });

    it("scans every anchored literal and skips the literals it was not asked for", () => {
      const source = [
        "await subscriptions.insertOne({ subscribedPlanKey: key });",
        'await subscriptions.updateOne({ _id: id }, { $set: { status: "cancelled" } });',
        "await subscriptions.updateOne({ _id: id }, { $set: { cancelledAt: now } });",
      ].join("\n");

      expect(scanWrittenFields(source, ["subscriptions.insertOne(", "$set:"])).toEqual({
        literalCount: 3,
        keys: ["cancelledAt", "status", "subscribedPlanKey"],
      });
    });

    it("reports a top-level key the doc does not document", () => {
      const source = [
        "await subscriptions.insertOne({",
        '  status: "active",',
        "  seats: 3,",
        "});",
      ].join("\n");
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "| Field | Type |",
        "| --- | --- |",
        "| `status` | string |",
      ].join("\n");

      const written = scanWrittenFields(source, ["subscriptions.insertOne("]).keys;

      expect(undocumentedKeys(written, documentedFieldNames(markdown))).toEqual(["seats"]);
    });

    it("reports a quoted top-level key the doc does not document", () => {
      const source = [
        "await subscriptions.insertOne({",
        '  "taxMinor": 0,',
        '  status: "active",',
        "});",
      ].join("\n");
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "| Field | Type |",
        "| --- | --- |",
        "| `status` | string |",
      ].join("\n");

      const written = scanWrittenFields(source, ["subscriptions.insertOne("]).keys;

      expect(undocumentedKeys(written, documentedFieldNames(markdown))).toEqual(["taxMinor"]);
    });

    it("reports the undocumented key after a comment, and invents no key from the comment", () => {
      const source = [
        "await subscriptions.insertOne({",
        '  status: "active",',
        "  // currency comes from prices[]",
        "  taxMinor: 0,",
        "});",
      ].join("\n");
      const markdown = [
        "### 14.3 `subscriptions`",
        "",
        "| Field | Type |",
        "| --- | --- |",
        "| `status` | string |",
      ].join("\n");

      const written = scanWrittenFields(source, ["subscriptions.insertOne("]).keys;

      expect(undocumentedKeys(written, documentedFieldNames(markdown))).toEqual(["taxMinor"]);
    });

    it("throws when an anchor's write is a variable, because its fields are unknowable", () => {
      const source = "await subscriptions.updateOne({ _id: id }, { $set: patch, $push: history });";

      expect(() => scanWrittenFields(source, ["$set:"])).toThrow(/opens no object literal/);
    });
  });

  describe("the depth-1 key shapes", () => {
    it.each(DEPTH_ONE_KEY_SHAPES)("reads $shape", ({ body, keys }) => {
      const source = [
        "await subscriptions.insertOne({",
        ...body.map((line) => `  ${line}`),
        "});",
      ].join("\n");

      expect(scanWrittenFields(source, ["subscriptions.insertOne("]).keys).toEqual(keys);
    });

    it("throws, naming the literal's line, when a key is computed", () => {
      const source = [
        "await subscriptions.insertOne({",
        "  [TAX_KEY]: 1,",
        '  status: "active",',
        "});",
      ].join("\n");

      expect(() => scanWrittenFields(source, ["subscriptions.insertOne("])).toThrow(
        /line 1 writes a computed property name/
      );
    });

    it("throws when a template key interpolates, because its name is not in the text", () => {
      const source = [
        "await subscriptions.insertOne({",
        "  `${TAX_KEY}`: 1,",
        '  status: "active",',
        "});",
      ].join("\n");

      expect(() => scanWrittenFields(source, ["subscriptions.insertOne("])).toThrow(
        /computed property name/
      );
    });

    it("throws when a spread is an inline literal, because its keys are this literal's", () => {
      const source = [
        "await subscriptions.insertOne({",
        "  ...{ taxMinor: 0 },",
        '  status: "active",',
        "});",
      ].join("\n");

      expect(() => scanWrittenFields(source, ["subscriptions.insertOne("])).toThrow(
        /spreads an inline object literal/
      );
    });
  });

  describe("the literal marker detector", () => {
    it.each(LITERAL_MARKER_SHAPES)("classifies $shape", ({ body, flagged }) => {
      const literal = ["{", ...body.map((line) => `  ${line}`), "}"].join("\n");

      expect(
        blockCommentMarkers(literal).map((at) => literal.slice(0, at).split("\n").length)
      ).toEqual(flagged);
    });
  });

  describe("the real tree", () => {
    it("scans the anchored literals of both mint routes and no others", () => {
      const { routes } = measureRealTree();

      expect(routes.map(({ report }) => [report.literalCount, report.keys.length])).toEqual(
        MINT_ROUTES.map((route) => [route.literals, route.keys])
      );
    });

    // A `/*` in a value position starts a comment skip that would swallow the
    // rest of the literal, so the pinned population must stay free of one.
    // Parser-safe markers — inside a quoted string value, or a complete block
    // comment where a property may start — are exempt: `blockCommentMarkers`
    // classifies both, and its matrix pins that they never redden.
    it("carries no `/*` marker in a value position inside any anchored mint literal", () => {
      const routes = MINT_ROUTES.map((route) => ({
        route,
        bodies: anchoredLiteralBodies(readTextFile(join(repoRoot, route.path)), route.anchors),
      }));

      // Vacuity guard first: the marker assertion below must run over every
      // anchored literal, not over a slice that silently found none.
      expect(routes.map(({ route, bodies }) => [route.path, bodies.length])).toEqual(
        MINT_ROUTES.map((route) => [route.path, route.literals])
      );

      expect(
        routes.flatMap(({ route, bodies }) =>
          bodies.flatMap(({ anchor, body }, index) =>
            blockCommentMarkers(body).map(
              (offset) =>
                `${route.path} anchor \`${anchor}\` literal ${String(index + 1)} ` +
                `carries a \`/*\` at offset ${String(offset)} in a value position: ` +
                "the reader starts a block-comment skip there and swallows the rest of the " +
                `literal — move the comment above the write call on \`${anchor}\``
            )
          )
        )
      ).toEqual([]);
    });

    it("writes no field that §14.3 does not document", () => {
      const { writtenFields, documented } = measureRealTree();

      expect(undocumentedKeys(writtenFields, documented)).toEqual([]);
    });

    it("writes exactly the 21 documented fields the two mints set", () => {
      const { writtenFields } = measureRealTree();

      expect(writtenFields).toEqual([
        "activePlanKey",
        "billingCycle",
        "cancelAt",
        "cancelReason",
        "cancelledAt",
        "checkout",
        "currency",
        "dunning",
        "externalRefs",
        "gracePeriodEndsAt",
        "mandateStatus",
        "paymentMethodKind",
        "pendingDueMinor",
        "previousSubscriptionId",
        "priceKey",
        "scheduledChange",
        "status",
        "statusHistory",
        "subscribedPlanKey",
        "subscribedPlanVersion",
        "tenantId",
      ]);
    });

    it("documents exactly the 24 field names of the section", () => {
      const { documented } = measureRealTree();

      expect(documented).toEqual([
        "activePlanKey",
        "billingCycle",
        "cancelAt",
        "cancelReason",
        "cancelledAt",
        "checkout",
        "currency",
        "currentPeriodEnd",
        "currentPeriodStart",
        "dunning",
        "externalRefs",
        "gracePeriodEndsAt",
        "mandateStatus",
        "nextChargeAt",
        "paymentMethodKind",
        "pendingDueMinor",
        "previousSubscriptionId",
        "priceKey",
        "scheduledChange",
        "status",
        "statusHistory",
        "subscribedPlanKey",
        "subscribedPlanVersion",
        "tenantId",
      ]);
    });

    it("documents the two rows the mints shipped without: `checkout` and `currency`", () => {
      const { documented } = measureRealTree();

      expect(documented).toEqual(expect.arrayContaining(["checkout", "currency"]));
    });

    it("names the three documented fields no mint writes: the period window and the charge instant", () => {
      const { documented, writtenFields } = measureRealTree();

      expect(documented.filter((key) => !writtenFields.includes(key))).toEqual([
        "currentPeriodEnd",
        "currentPeriodStart",
        "nextChargeAt",
      ]);
    });
  });
});
