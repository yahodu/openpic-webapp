import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeEnv, makeProductionEnv, toProcessEnv } from "../factories/env";

/**
 * I1 — the boot check `scripts/check-env.ts`.
 *
 * This script is the process-level guard that satisfies "the app refuses to
 * boot with a clear error": it reads the environment through the config module
 * and, when anything is missing or invalid, writes the offending environment
 * variable KEY NAMES ONLY to stderr and exits 1. On a valid environment it
 * exits 0 without printing any secret value.
 *
 * It is run as a real child process (`node scripts/check-env.ts`) because the
 * contract is the process exit code, not a function return. Node's built-in
 * TypeScript type stripping runs the `.ts` entry directly; the script must
 * import the config module by its `.ts` path.
 */
const SCRIPT_PATH = fileURLToPath(new URL("../../../../../scripts/check-env.ts", import.meta.url));

interface CheckResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCheckEnv(env: NodeJS.ProcessEnv): CheckResult {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("scripts/check-env.ts", () => {
  it("exits 1 and names the missing key on stderr", () => {
    const env = toProcessEnv(makeEnv());
    delete env.MONGODB_URI;

    const result = runCheckEnv(env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MONGODB_URI");
  });

  it("exits 1 and never prints a secret value", () => {
    const leaked = "leaky-boot-check-secret-value";
    const env = toProcessEnv(makeProductionEnv({ BETTER_AUTH_SECRET: leaked }));

    const result = runCheckEnv(env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BETTER_AUTH_SECRET");
    expect(result.stderr).not.toContain(leaked);
  });

  it("exits 0 on a valid environment", () => {
    const result = runCheckEnv(toProcessEnv(makeEnv()));

    expect(result.status).toBe(0);
  });
});
