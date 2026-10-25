import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import rule from "../../../../../../eslint-rules/no-direct-vendor-adapter-import.mjs";

/**
 * Unit contract — the `no-direct-vendor-adapter-import` ESLint rule (OP-105
 * follow-up, acceptance criterion 1 / review finding F1; ADR-0388).
 *
 * OP-105 keeps the payment vendor behind the neutral port
 * (`@/server/payments/payment-provider`): swapping Cashfree for another PSP must
 * be an adapter change and nothing else (`docs/CONVENTIONS.md` §7, ADR-0001,
 * ADR-0380 §"Out of scope", ADR-0381 §Consequences). The port plus the
 * `docs/API Contract.md` §11.1 rule that every ref carries a provider key make
 * the *literal* `"cashfree"` legitimate inside the port's key union and in
 * pre-existing plan config, so a literal-level ban is not the right lever — the
 * enforceable seam is the **adapter import boundary**.
 *
 * The rule makes "only the adapter directory and the one composition root may
 * name the vendor adapter" structural, mirroring the Novu SDK boundary
 * (`no-restricted-imports` in `eslint.config.mjs`) and the tenant-isolation
 * `no-direct-collection-access` rule. It reports any import of a module under
 * `server/adapters/cashfree/**` (`import`, `export ... from`, or dynamic
 * `import()`) unless the importing file is:
 *
 *   - inside that adapter directory itself
 *     (`apps/web/src/server/adapters/cashfree/**`), or
 *   - the payment composition root
 *     (`apps/web/src/server/payments/get-payment-provider.ts`) — the deliberate
 *     seam that selects a concrete provider, exempt exactly as
 *     `apps/web/src/server/adapters/message-transport-provider.ts` is for Novu.
 *
 * Everywhere else (route handlers, services, jobs, sibling payment modules) the
 * caller must depend on the vendor-neutral port or the composition root.
 *
 * Contract the implementation owes:
 *   - module: eslint-rules/no-direct-vendor-adapter-import.mjs (default export,
 *     carrying the JSDoc `@type {import("eslint").Rule.RuleModule}` annotation
 *     the sibling custom rule uses so `tsc` resolves it);
 *   - rule id: openpic/no-direct-vendor-adapter-import (registered in
 *     eslint.config.mjs for `apps/web/src/**`, as `no-direct-collection-access`
 *     is — that registration is the GREEN sibling's job, not this spec's);
 *   - meta.messages.noDirectVendorAdapterImport: the reported message;
 *   - meta.schema: [].
 *
 * RuleTester is wired to Vitest's `describe`/`it` so failures surface as normal
 * test failures (same shape as `no-direct-collection-access.test.ts`).
 */
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

/** The application's source root, as an absolute RuleTester filename. */
const WEB_SRC = "/repo/apps/web/src";
/** The vendor adapter directory a caller may never import across. */
const CASHFREE_ADAPTER = `${WEB_SRC}/server/adapters/cashfree`;
/** The one seam allowed to select the Cashfree adapter (ADR-0388). */
const COMPOSITION_ROOT = `${WEB_SRC}/server/payments/get-payment-provider.ts`;

ruleTester.run("no-direct-vendor-adapter-import", rule, {
  valid: [
    {
      name: "the vendor adapter may import its own modules by relative path",
      code: 'import { cashfreeSubscriptionSchema } from "./schemas";',
      filename: `${CASHFREE_ADAPTER}/cashfree-provider.ts`,
    },
    {
      name: "the vendor adapter may import its own modules by the @/ alias",
      code: 'import { cashfreeSubscriptionSchema } from "@/server/adapters/cashfree/schemas";',
      filename: `${CASHFREE_ADAPTER}/cashfree-provider.ts`,
    },
    {
      name: "a service may depend on the vendor-neutral port",
      code: 'import { paymentProviderKeySchema } from "@/server/payments/payment-provider";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
    },
    {
      name: "a service may import the composition root rather than the adapter",
      code: 'import { getPaymentProvider } from "@/server/payments/get-payment-provider";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
    },
    {
      name: "a route handler may import the composition root rather than the adapter",
      code: 'import { getPaymentProvider } from "@/server/payments/get-payment-provider";',
      filename: `${WEB_SRC}/app/api/v1/tenants/t1/billing/route.ts`,
    },
    {
      name: "the payment composition root is the one seam that may name the vendor adapter",
      code: 'import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: COMPOSITION_ROOT,
    },
    {
      name: "a differently named vendored folder is not the payment adapter",
      code: 'import { createNovuTransport } from "@/server/adapters/novu/novu-transport";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
    },
  ],
  invalid: [
    {
      name: "a route handler must not import the vendor adapter by alias",
      code: 'import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/app/api/v1/tenants/t1/billing/route.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "a service must not import the vendor adapter by alias",
      code: 'import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "the exemption is the composition-root file, not the whole payments folder",
      code: 'import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/server/payments/charge.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "a service must not re-export the vendor adapter",
      code: 'export { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "a service must not reach the vendor adapter by relative path",
      code: 'import { createCashfreeProvider } from "../adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/server/services/billing.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "a service must not bypass the boundary with a dynamic import",
      code: 'const provider = await import("@/server/adapters/cashfree/cashfree-provider");',
      filename: `${WEB_SRC}/server/services/billing.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
    {
      name: "a job must not import the vendor adapter",
      code: 'import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";',
      filename: `${WEB_SRC}/server/jobs/reconcile.ts`,
      errors: [{ messageId: "noDirectVendorAdapterImport" }],
    },
  ],
});
