/**
 * Novu workflows-as-code upsert CLI (OP-92 §5, ADR-0074).
 *
 * Creates the three single-step transport workflows if they are missing and is
 * idempotent otherwise. The engine lives in `src/server/adapters/novu` so it is
 * unit-testable in-process; this entrypoint only reads configuration, builds a
 * logger and maps the engine's exit code onto the process.
 *
 * Run from the repo root:
 *
 *   pnpm novu:upsert-workflows
 *
 * Requires `NOVU_API_KEY` (and optionally `NOVU_BASE_URL`). Values are read
 * through `src/server/config`, never printed.
 */
import { runWorkflowUpsert } from "../../apps/web/src/server/adapters/novu/upsert-workflows.ts";
import { getAppEnv, getNovuRuntimeConfig } from "../../apps/web/src/server/config/env.ts";
import { createLogger, stdoutJsonTransport } from "../../apps/web/src/server/logging/index.ts";

const { baseUrl, apiKey } = getNovuRuntimeConfig();

if (apiKey.length === 0) {
  process.stderr.write("NOVU_API_KEY is not set; cannot upsert Novu workflows.\n");
  process.exit(1);
}

const logger = createLogger({
  level: "info",
  transports: [stdoutJsonTransport()],
  service: "openpic-novu-upsert",
  env: getAppEnv(),
});

const exitCode = await runWorkflowUpsert({ baseUrl, apiKey, logger });
process.exit(exitCode);
