/**
 * The gate and credential guard for the `CASHFREE_LIVE_TEST=1` live sandbox
 * contract test (OP-105, ADR-0382).
 *
 * Two rules, both deliberate:
 *
 *  - **Opt in explicitly.** Only `CASHFREE_LIVE_TEST === "1"` turns the live
 *    suite on, so a stray `CASHFREE_LIVE_TEST=true` (or any truthy-looking
 *    value) can never start network traffic in CI.
 *  - **Fail closed.** When the gate is on but a credential is missing the guard
 *    throws and names every missing variable — a requested live run that
 *    silently skips is worse than no live run, because the operator believes
 *    the contract was checked.
 *
 * The guard takes the environment as an argument rather than reading
 * `process.env`, so its own contract is unit-testable on every CI run without
 * touching the real process environment.
 */

/** The env var that turns the live sandbox contract suite on. */
export const LIVE_SANDBOX_GATE = "CASHFREE_LIVE_TEST";

/**
 * The env vars a requested live run cannot start without.
 *
 * `CASHFREE_LIVE_PLAN_ID` is included because `createMandate` must address a
 * plan that actually exists in the sandbox account — a vendor-side id, so it is
 * configuration rather than fixture data.
 */
export const LIVE_SANDBOX_VARS = [
  "CASHFREE_CLIENT_ID",
  "CASHFREE_CLIENT_SECRET",
  "CASHFREE_WEBHOOK_SECRET",
  "CASHFREE_LIVE_PLAN_ID",
] as const;

/** The name of one live sandbox credential variable. */
export type LiveSandboxVar = (typeof LIVE_SANDBOX_VARS)[number];

/** The credentials a live sandbox run needs, in provider-config order. */
export interface LiveSandboxCredentials {
  /** `CASHFREE_CLIENT_ID` — sent as `x-client-id`. */
  readonly clientId: string;
  /** `CASHFREE_CLIENT_SECRET` — sent as `x-client-secret`; never logged. */
  readonly clientSecret: string;
  /** `CASHFREE_WEBHOOK_SECRET` — the HMAC key for `verifyWebhook`; never logged. */
  readonly webhookSecret: string;
  /** `CASHFREE_LIVE_PLAN_ID` — the sandbox plan the live mandate is created for. */
  readonly planRef: string;
}

/** A read-only environment, so the guard is testable without mutating `process.env`. */
export type LiveSandboxEnv = Readonly<Record<string, string | undefined>>;

/**
 * Whether the environment asks for a live sandbox run.
 *
 * @param env - The environment to read (normally `process.env`).
 * @returns `true` only for the exact value `"1"`.
 */
export function isLiveSandboxEnabled(env: LiveSandboxEnv): boolean {
  return env[LIVE_SANDBOX_GATE] === "1";
}

/**
 * Read the credentials a requested live run needs, or fail closed.
 *
 * A variable that is unset, empty or whitespace-only counts as missing.
 *
 * @param env - The environment to read (normally `process.env`).
 * @returns The resolved {@link LiveSandboxCredentials}.
 * @throws If any of {@link LIVE_SANDBOX_VARS} is missing, naming all of them.
 */
export function resolveLiveSandboxCredentials(env: LiveSandboxEnv): LiveSandboxCredentials {
  const missing = LIVE_SANDBOX_VARS.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `CASHFREE_LIVE_TEST=1 requested a live Cashfree sandbox run but ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset. Refusing to run a partial live contract test.`
    );
  }

  return {
    clientId: readVar(env, "CASHFREE_CLIENT_ID"),
    clientSecret: readVar(env, "CASHFREE_CLIENT_SECRET"),
    webhookSecret: readVar(env, "CASHFREE_WEBHOOK_SECRET"),
    planRef: readVar(env, "CASHFREE_LIVE_PLAN_ID"),
  };
}

/**
 * Read one validated variable.
 *
 * @param env - The environment to read.
 * @param name - The variable to read; already proven present by the caller.
 * @returns Its value.
 */
function readVar(env: LiveSandboxEnv, name: LiveSandboxVar): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`Missing live sandbox credential: ${name}.`);
  }
  return value;
}
