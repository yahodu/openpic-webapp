import { describe, expect, it } from "vitest";

import type { AppEnv } from "@/server/config/env";
import { isTestOtpRouteEnabled } from "@/server/auth/test-route";

/**
 * U2 — the guard for the test-only OTP route (OP-85).
 *
 * `GET /api/v1/__test__/otp` exists so the e2e suite can read an OTP that the
 * server captured in its in-memory transport (the code never crosses the wire
 * to a real user). It MUST be unreachable everywhere a real user could hit it:
 * a leaked OTP endpoint would let anyone who knows an email or phone number
 * read that contact's one-time code and sign in as them.
 *
 * The policy is therefore an allow-list of two, non-deployable environments:
 *
 *   - enabled: `test`, `e2e`
 *   - disabled (route answers 404): `development`, `staging`, `production`
 *
 * `development` is deliberately disabled too: a developer's local server is
 * reachable from the network on a shared machine/CI tunnel, and the contract
 * treats "not test, not e2e" as untrusted.
 *
 * Contract expected of the implementation (`@/server/auth/test-route`):
 *
 *   isTestOtpRouteEnabled(env: AppEnv): boolean
 */

const DISABLED_ENVS: readonly AppEnv[] = ["development", "staging", "production"];
const ENABLED_ENVS: readonly AppEnv[] = ["test", "e2e"];

describe("isTestOtpRouteEnabled — the test-only route guard", () => {
  it.each(DISABLED_ENVS)("U2: is disabled when APP_ENV=%s", (env) => {
    expect(isTestOtpRouteEnabled(env)).toBe(false);
  });

  it.each(ENABLED_ENVS)("U2: is enabled when APP_ENV=%s", (env) => {
    expect(isTestOtpRouteEnabled(env)).toBe(true);
  });
});
