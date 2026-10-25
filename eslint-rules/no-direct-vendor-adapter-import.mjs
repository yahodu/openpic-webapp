/**
 * ESLint rule `no-direct-vendor-adapter-import` (OP-105 follow-up, review
 * finding F1; ADR-0388 / ADR-0389).
 *
 * The payment vendor sits behind the vendor-neutral port
 * (`@/server/payments/payment-provider`): swapping Cashfree for another PSP must
 * be an adapter change and nothing else. A convention is not enough — a future
 * caller could import the adapter anywhere and pull vendor wire knowledge
 * (field names, status strings, signature scheme) across the seam. This rule
 * makes "only the adapter directory and the one composition root may name the
 * vendor adapter" a lint-enforced invariant, mirroring the Novu SDK boundary
 * (`no-restricted-imports` in `eslint.config.mjs`) and the tenant-isolation
 * `no-direct-collection-access` rule.
 *
 * Two locations legitimately reach the Cashfree adapter:
 *   - `src/server/adapters/cashfree/**` — the adapter itself; and
 *   - `src/server/payments/get-payment-provider.ts` — the composition root that
 *     selects a concrete provider, the deliberate seam, exempt exactly as
 *     `src/server/adapters/message-transport-provider.ts` is for Novu.
 *
 * Anywhere else the caller must depend on the neutral port or on the
 * composition root. The rule reports `import … from`, `export … from`, dynamic
 * `import()` and a relative specifier (`../adapters/cashfree/…`) alike: a
 * relative path is resolved against the importing file before the match, so it
 * cannot slip past the boundary, and a path that merely resembles the adapter
 * (a differently named vendored folder, or a `cashfree` folder outside
 * `server/adapters/`) is never flagged.
 */
import path from "node:path";

/** The vendor adapter directory, as a whole-path-segment match. */
const ADAPTER_PATH = /(?:^|\/)server\/adapters\/cashfree(?:\/|$)/;

/** The one composition root allowed to select the vendor adapter. */
const COMPOSITION_ROOT_PATH = /(?:^|\/)server\/payments\/get-payment-provider\.ts$/;

/**
 * Normalize a filesystem path to forward slashes, so the boundary matches the
 * same way on Windows and POSIX.
 *
 * @param value - A path or a module specifier.
 * @returns The same string with `\` replaced by `/`.
 */
function toPosix(value) {
  return value.split("\\").join("/");
}

/**
 * Whether a file is exempt from the boundary — the adapter itself or the one
 * composition root.
 *
 * @param filename - The absolute path of the file being linted.
 * @returns `true` when the file may name the vendor adapter.
 */
function isExemptFile(filename) {
  const posix = toPosix(filename);
  return ADAPTER_PATH.test(posix) || COMPOSITION_ROOT_PATH.test(posix);
}

/**
 * Whether an import specifier names a module under the vendor adapter
 * directory. A relative specifier is resolved against the importing file's
 * directory first, so `../adapters/cashfree/…` is caught; the `@/` alias and
 * any other non-relative specifier are matched as written.
 *
 * @param specifier - The import/export source, e.g. `@/server/adapters/cashfree/cashfree-provider`.
 * @param filename - The absolute path of the importing file.
 * @returns `true` when the specifier resolves into the vendor adapter.
 */
function isVendorAdapterSpecifier(specifier, filename) {
  const candidate = specifier.startsWith(".")
    ? path.resolve(path.dirname(filename), specifier)
    : specifier;
  return ADAPTER_PATH.test(toPosix(candidate));
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing the Cashfree adapter outside src/server/adapters/cashfree and the payment composition root; depend on the PaymentProvider port.",
      recommended: false,
    },
    schema: [],
    messages: {
      noDirectVendorAdapterImport:
        "Do not import the Cashfree adapter directly. Depend on the PaymentProvider port from @/server/payments/payment-provider or on the composition root @/server/payments/get-payment-provider so the vendor stays behind the adapter.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();

    if (isExemptFile(filename)) {
      return {};
    }

    /**
     * Report an import/export source when it names the vendor adapter.
     *
     * @param {import("estree").Node | null | undefined} sourceNode - The source literal,
     *   when the construct has one.
     */
    function checkSource(sourceNode) {
      if (!sourceNode || sourceNode.type !== "Literal" || typeof sourceNode.value !== "string") {
        return;
      }
      if (!isVendorAdapterSpecifier(sourceNode.value, filename)) {
        return;
      }
      context.report({ node: sourceNode, messageId: "noDirectVendorAdapterImport" });
    }

    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
      ImportExpression(node) {
        checkSource(node.source);
      },
      // Pre-`ImportExpression` parser shape for a dynamic `import()`.
      CallExpression(node) {
        if (node.callee.type === "Import") {
          checkSource(node.arguments[0]);
        }
      },
    };
  },
};

export default rule;
