import type { AppEnv } from "@/server/config/env";

/**
 * The guard for the test-only OTP read-back route (OP-85).
 *
 * `GET /api/v1/__test__/otp` lets the e2e suite read an OTP the server captured
 * in its in-memory transport. Because anything that can read an OTP is a
 * sign-in-as-anyone primitive, the route is reachable only from the two
 * non-deployable environments:
 *
 *   - enabled: `test`, `e2e`
 *   - disabled (the route answers `404`): `development`, `staging`, `production`
 *
 * `development` is deliberately excluded too: a developer's local server is
 * often reachable from a shared network or CI tunnel, so the contract treats
 * "not test, not e2e" as untrusted.
 */

/** The environments where the read-back route may answer. */
const ENABLED_ENVS: ReadonlySet<AppEnv> = new Set<AppEnv>(["test", "e2e"]);

/**
 * Whether the test-only OTP route is reachable in an environment.
 *
 * @param env - The validated deploy environment.
 * @returns `true` only for `test` and `e2e`.
 */
export function isTestOtpRouteEnabled(env: AppEnv): boolean {
  return ENABLED_ENVS.has(env);
}
