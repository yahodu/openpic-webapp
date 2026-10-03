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
 * Anywhere else, `db.collection(...)` is reported. Application code is expected
 * to obtain a scoped handle from `tenantRepo`/`platformRepo` instead of the
 * driver handle.
 *
 * The rule is not fooled by trivial indirection: a binding that resolves to the
 * raw driver — an alias (`const driver = db; driver.collection(...)`) or a
 * destructured method (`const { collection } = db; collection(...)`) — is
 * reported at the offending call just like a literal `db.collection(...)`.
 * Aliases and destructured bindings are traced through scope analysis, so a
 * differently named variable that does not come from the driver (a repository
 * handle, an unrelated import) is never flagged. The literal identifier `db`,
 * however, is always treated as the driver handle — it is the canonical name of
 * the driver in this codebase and is frequently an ambient/unresolved global —
 * so a local binding that shadows it (e.g. a parameter named `db`) is reported
 * as well.
 */
const ALLOWED_PATH = /[/\\]src[/\\]server[/\\](db|repos)[/\\]/;

/** The raw driver handle's identifier. */
const RAW_DB = "db";
/** The collection-returning method name. */
const RAW_COLLECTION = "collection";

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

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    /**
     * Resolve an identifier reference to the variable it binds, walking up the
     * scope chain from the reference. Returns `null` for unresolved globals.
     *
     * @param {import("estree").Identifier} node
     * @returns {import("eslint").Scope.Variable | null}
     */
    function resolveVariable(node) {
      let scope = sourceCode.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (variable) {
          return variable;
        }
        scope = scope.upper;
      }
      return null;
    }

    /**
     * The kind a variable was bound to, if it can be traced back to the raw
     * driver:
     *   - `"db"`         — the driver handle itself (`db`, `const a = db`, …).
     *   - `"collection"` — the driver's `collection` method (`const { collection } = db`).
     *   - `undefined`    — anything else, including repository handles.
     *
     * @type {WeakMap<import("eslint").Scope.Variable, "db" | "collection" | undefined>}
     */
    const kindByVariable = new WeakMap();

    /**
     * @param {import("eslint").Scope.Variable} variable
     * @param {Set<import("eslint").Scope.Variable>} seen guards alias cycles
     * @returns {"db" | "collection" | undefined}
     */
    function variableKind(variable, seen) {
      if (kindByVariable.has(variable)) {
        return kindByVariable.get(variable);
      }
      if (seen.has(variable)) {
        return undefined;
      }
      seen.add(variable);

      let kind;
      for (const def of variable.defs) {
        // Every binding we can trace comes from a `const`/`let`/`var`
        // declaration; parameter, catch and import bindings are ignored.
        if (def.type !== "Variable") {
          continue;
        }
        const declarator = def.node;
        if (!declarator || declarator.type !== "VariableDeclarator") {
          continue;
        }
        const init = declarator.init;
        if (!init || init.type !== "Identifier") {
          continue;
        }
        if (identifierKind(init, seen) !== RAW_DB) {
          continue;
        }

        if (declarator.id.type === "Identifier") {
          // `const driver = db;` (or an alias of an alias).
          kind = RAW_DB;
          break;
        }

        if (declarator.id.type === "ObjectPattern") {
          // `const { collection } = db;` / `const { collection: c } = db;`.
          const property = declarator.id.properties.find(
            (entry) => entry.type === "Property" && entry.value === def.name
          );
          if (
            property &&
            property.computed === false &&
            property.key.type === "Identifier" &&
            property.key.name === RAW_COLLECTION
          ) {
            kind = RAW_COLLECTION;
            break;
          }
        }
      }

      kindByVariable.set(variable, kind);
      seen.delete(variable);
      return kind;
    }

    /**
     * The kind an identifier reference denotes. A bare `db` is always the
     * driver handle (preserving the rule's original behaviour); anything else
     * must resolve through the scope chain.
     *
     * @param {import("estree").Identifier} node
     * @param {Set<import("eslint").Scope.Variable>} seen
     * @returns {"db" | "collection" | undefined}
     */
    function identifierKind(node, seen) {
      if (node.name === RAW_DB) {
        return RAW_DB;
      }
      const variable = resolveVariable(node);
      return variable ? variableKind(variable, seen) : undefined;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // `db.collection(...)`, `driver.collection(...)` where `driver` is an
        // alias of `db`.
        if (
          callee.type === "MemberExpression" &&
          callee.computed === false &&
          callee.property.type === "Identifier" &&
          callee.property.name === RAW_COLLECTION &&
          callee.object.type === "Identifier" &&
          identifierKind(callee.object, new Set()) === RAW_DB
        ) {
          context.report({ node, messageId: "noDirectCollectionAccess" });
          return;
        }

        // `collection(...)` where `collection` was destructured off `db`.
        if (callee.type === "Identifier" && identifierKind(callee, new Set()) === RAW_COLLECTION) {
          context.report({ node, messageId: "noDirectCollectionAccess" });
        }
      },
    };
  },
};

export default rule;
