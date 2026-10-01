/**
 * Boot guard (OP-70): validate the environment before the app starts.
 *
 * Run as `node scripts/check-env.ts` (Node >= 22 type stripping) from the repo
 * root. Exits 1 and writes the offending environment variable KEY NAMES ONLY
 * to stderr when the configuration is missing or invalid; exits 0 otherwise.
 * Environment values are never printed.
 */
import { getConfig } from "../apps/web/src/server/config/env.ts";

try {
  getConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : "Invalid application configuration";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

process.exit(0);
