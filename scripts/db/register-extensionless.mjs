// Node ESM resolve hook for running repo scripts with `--experimental-strip-types`.
//
// The application source is authored for a bundler (Next/Vite): relative
// imports are extensionless (`import { getLogger } from "../logging"`). Node's
// built-in type stripping executes `.ts` files but resolves specifiers with ESM
// rules, so those extensionless imports fail. This hook retries an unresolved
// relative specifier with a `.ts` extension (and `index.ts` for directories) so
// a one-off admin script can traverse the application module graph unchanged.
//
// Used only by the admin script entrypoints, e.g.:
//
//   node --experimental-strip-types \
//     --import ./scripts/db/register-extensionless.mjs \
//     scripts/db/ensure-indexes.ts
import { registerHooks } from "node:module";

const TS_EXTENSION = /\.[cm]?[jt]sx?$/;
const CANDIDATES = [".ts", "/index.ts"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    if (isRelative && !TS_EXTENSION.test(specifier)) {
      for (const suffix of CANDIDATES) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // Try the next candidate extension.
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
