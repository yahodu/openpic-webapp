import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "../../../../../../eslint-rules/no-direct-collection-access.mjs";

/**
 * Unit contract — the `no-direct-collection-access` ESLint rule (OP-77,
 * schema §10.2 mitigation 1).
 *
 * Isolation becomes an application invariant because only the repository layer
 * may build filters. The lint rule makes that structural: a `db.collection(...)`
 * call is an error unless the file lives under `src/server/db/**` (where the
 * driver is legitimately touched) or `src/server/repos/**` (which owns the
 * `tenantId` injection). Everywhere else the author must go through
 * `tenantRepo`/`platformRepo`.
 *
 *   rule meta.messageId: "noDirectCollectionAccess"
 *   rule path: eslint-rules/no-direct-collection-access.mjs (default export)
 *
 * RuleTester is wired to Vitest's `describe`/`it` so failures surface as normal
 * test failures.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-direct-collection-access", rule, {
  valid: [
    {
      name: "the repository layer may reach the driver",
      code: 'db.collection("events").find({ tenantId: "t1" });',
      filename: "/repo/apps/web/src/server/repos/tenant.ts",
    },
    {
      name: "the db folder may reach the driver",
      code: 'db.collection("events").find({});',
      filename: "/repo/apps/web/src/server/db/mongo.ts",
    },
    {
      name: "a nested repos path may reach the driver",
      code: 'db.collection("events").insertOne({});',
      filename: "/repo/apps/web/src/server/repos/nested/thing.ts",
    },
    {
      name: "a different receiver is not the raw driver",
      code: 'tenant.collection("events").find({});',
      filename: "/repo/apps/web/src/server/services/events.ts",
    },
  ],
  invalid: [
    {
      name: "a service must not reach the driver directly",
      code: 'db.collection("events").find({});',
      filename: "/repo/apps/web/src/server/services/events.ts",
      errors: [{ messageId: "noDirectCollectionAccess" }],
    },
    {
      name: "a route handler must not reach the driver directly",
      code: 'await db.collection("events").insertOne({ name: "x" });',
      filename: "/repo/apps/web/src/app/api/v1/events/route.ts",
      errors: [{ messageId: "noDirectCollectionAccess" }],
    },
    {
      name: "a sibling server folder must not reach the driver directly",
      code: 'const cursor = db.collection("media_assets").aggregate([]);',
      filename: "/repo/apps/web/src/server/jobs/sweep.ts",
      errors: [{ messageId: "noDirectCollectionAccess" }],
    },
  ],
});
