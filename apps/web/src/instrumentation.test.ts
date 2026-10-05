/**
 * Contract under test — `src/instrumentation.ts`.
 *
 * Next.js calls the exported `register()` once per server boot. The OP-85
 * GREEN change added a **production boot guard** inside it: when the runtime is
 * Node (`NEXT_RUNTIME === "nodejs"`) and `APP_ENV === "production"`, `register()`
 * must validate the deploy configuration by calling `getConfig()`. Because
 * `getConfig()` throws a `ConfigError` for an invalid production environment,
 * an invalid production process **refuses to start** (the acceptance criterion
 * of ADR-0024 as amended by ADR-0032/ADR-0033) instead of failing at the first
 * request.
 *
 * This spec pins the *observable* boot contract — it never asserts on internal
 * collaborators:
 *
 *   - `NEXT_RUNTIME=nodejs` + `APP_ENV=production` + invalid config
 *       -> `register()` rejects with a `ConfigError` naming the offending key.
 *   - `NEXT_RUNTIME=nodejs` + `APP_ENV=production` + valid config
 *       -> `register()` resolves.
 *   - `NEXT_RUNTIME=nodejs` + `APP_ENV` in {development, test, e2e}, even with
 *     an otherwise invalid environment
 *       -> `register()` resolves (validation is production-only, so local
 *          development/test/e2e boot is never blocked by incomplete env).
 *   - `NEXT_RUNTIME` not `nodejs` (the Edge build), even in production with an
 *     invalid config
 *       -> `register()` resolves (the whole Node branch is compiled out).
 *
 * The two Node-only side effects `register()` performs after the guard — the
 * Mongo shutdown hook and the e2e MSW server — are stubbed so this spec observes
 * only the boot guard and stays hermetic/deterministic. That is a test-side
 * seam; no production code was changed to author this spec.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv, makeProductionEnv, toProcessEnv, type EnvInput } from "./test/factories/env";

// Neutralise the Node-only side effects that run *after* the boot guard so the
// spec exercises the configuration check in isolation (the shutdown hook and
// the e2e MSW interceptor have their own coverage elsewhere).
vi.mock("./server/db/lifecycle", () => ({
  registerMongoShutdownHook: vi.fn(() => () => undefined),
}));
vi.mock("./test/mocks/e2e-server", () => ({
  startE2eMswServer: vi.fn(() => Promise.resolve()),
}));

const ORIGINAL_ENV = process.env;

/**
 * Boot the instrumentation entry with a fresh module graph and the given
 * environment, exactly as Next.js does once per process.
 *
 * `vi.resetModules()` guarantees both `instrumentation.ts` and the
 * `getConfig()` read-once cache start clean, so the environment a test sets is
 * the environment the guard actually sees.
 */
async function boot(env: EnvInput): Promise<void> {
  vi.resetModules();
  process.env = toProcessEnv(env);
  const { register } = await import("./instrumentation");
  await register();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("register — production boot guard (ADR-0032/ADR-0033)", () => {
  it("refuses to boot when the production config is invalid", async () => {
    const env = makeProductionEnv({
      NEXT_RUNTIME: "nodejs",
      TRUSTED_CLIENT_IP_HEADER: undefined,
    });

    await expect(boot(env)).rejects.toMatchObject({
      name: "ConfigError",
      message: expect.stringMatching(/TRUSTED_CLIENT_IP_HEADER/),
    });
  });

  it("names the offending key only, never its value, when refusing to boot", async () => {
    // The invalid value is distinctive so the assertion can prove the refusal
    // propagates `getConfig()`'s key-only message verbatim, without echoing it.
    const env = makeProductionEnv({
      NEXT_RUNTIME: "nodejs",
      APP_BASE_URL: "not-an-absolute-url",
    });

    const error = await boot(env).then(
      () => undefined,
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ConfigError");
    expect((error as Error).message).toMatch(/APP_BASE_URL/);
    expect((error as Error).message).not.toContain("not-an-absolute-url");
  });

  it("boots when the production config is valid", async () => {
    const env = makeProductionEnv({ NEXT_RUNTIME: "nodejs" });

    await expect(boot(env)).resolves.toBeUndefined();
  });

  it.each(["development", "test", "e2e"] as const)(
    "does not validate the config when APP_ENV=%s, even if it is incomplete",
    async (appEnv) => {
      // Missing required keys would make `getConfig()` throw; the boot guard is
      // production-only, so a non-production boot must still succeed.
      const env = makeEnv({
        APP_ENV: appEnv,
        NEXT_RUNTIME: "nodejs",
        MONGODB_URI: undefined,
        APP_BASE_URL: undefined,
      });

      await expect(boot(env)).resolves.toBeUndefined();
    }
  );

  it.each(["edge", "unknown-runtime"] as const)(
    "does not validate the config in the %s runtime, even in production",
    async (runtime) => {
      const env = makeProductionEnv({
        NEXT_RUNTIME: runtime,
        MONGODB_URI: undefined,
      });

      await expect(boot(env)).resolves.toBeUndefined();
    }
  );
});
