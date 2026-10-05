/**
 * Novu workflow drift guard CLI (OP-92 §5, notification design §8.3).
 *
 * Fetches every workflow from the configured Novu instance and exits `1` unless
 * the set is exactly the three transport workflows, each with one active step
 * whose channel matches its name. CI invokes this so a dashboard edit that adds,
 * removes or reshapes a workflow fails the build instead of silently changing
 * production behaviour.
 *
 * Run from the repo root:
 *
 *   pnpm novu:assert-no-drift
 *
 * Requires `NOVU_API_KEY` (and optionally `NOVU_BASE_URL`). Values are read
 * through `src/server/config`, never printed.
 */
import { runTransportDriftCheck } from "../../apps/web/src/server/adapters/novu/workflow-drift.ts";
import { getAppEnv, getNovuRuntimeConfig } from "../../apps/web/src/server/config/env.ts";
import { createLogger, stdoutJsonTransport } from "../../apps/web/src/server/logging/index.ts";

const { baseUrl, apiKey } = getNovuRuntimeConfig();

if (apiKey.length === 0) {
  process.stderr.write("NOVU_API_KEY is not set; cannot assert Novu workflow drift.\n");
  process.exit(1);
}

const logger = createLogger({
  level: "info",
  transports: [stdoutJsonTransport()],
  service: "openpic-novu-drift",
  env: getAppEnv(),
});

const exitCode = await runTransportDriftCheck({ baseUrl, apiKey, logger });
process.exit(exitCode);
