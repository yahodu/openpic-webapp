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
 */

/** The design doc that carries §14.3. */
const DESIGN_DOC_PATH = "docs/Notification and Database Design.md";

/**
 * Collection meta, excluded from the per-field comparison.
 *
 * `_id`, `createdAt`, `updatedAt` and `schemaVersion` are stamped on every
 * collection, so the design doc documents them **once for the whole schema**
 * (§14.2's combined meta row, §26) instead of as per-collection rows in §14.3.
 * Both mint literals still write them, so the comparison subtracts them; any
 * other undocumented key is drift.
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
  });

  describe("the real tree", () => {
    it("scans the anchored literals of both mint routes and no others", () => {
      const { routes } = measureRealTree();

      expect(routes.map(({ report }) => [report.literalCount, report.keys.length])).toEqual(
        MINT_ROUTES.map((route) => [route.literals, route.keys])
      );
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
