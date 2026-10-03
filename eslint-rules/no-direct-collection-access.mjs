/**
 * ESLint rule `no-direct-collection-access` (OP-77, schema §10.2 mitigation 1).
 *
 * Tenant isolation only holds if every tenant-scoped query is built by the
 * repository layer, which structurally injects `tenantId` (see
 * `src/server/repos`). A raw `db.collection(...)` call outside that layer is a
 * hole: someone can author a filter that forgets the scope, or reach across
 * tenants on purpose. This rule makes "only the repository layer touches the
 * driver" a lint-enforced invariant rather than a convention.
 *
 * Two directories legitimately hold the driver:
 *   - `src/server/db/**`    — the MongoDB client, indexes and lifecycle.
 *   - `src/server/repos/**` — the scope-injecting repository layer.
 *
 * Anywhere else, `db.collection(...)` is reported. The rule matches the literal
 * receiver name `db`; application code is expected to obtain a scoped handle
 * from `tenantRepo`/`platformRepo` instead of the driver handle.
 */
const ALLOWED_PATH = /[/\\]src[/\\]server[/\\](db|repos)[/\\]/;

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct db.collection(...) access outside src/server/db and src/server/repos; use tenantRepo/platformRepo.",
      recommended: false,
    },
    schema: [],
    messages: {
      noDirectCollectionAccess:
        "Do not access MongoDB collections directly. Use tenantRepo(tenantId) or platformRepo() from @/server/repos so tenantId is injected structurally.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();

    if (ALLOWED_PATH.test(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.computed === false &&
          callee.object.type === "Identifier" &&
          callee.object.name === "db" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "collection"
        ) {
          context.report({ node, messageId: "noDirectCollectionAccess" });
        }
      },
    };
  },
};

export default rule;
