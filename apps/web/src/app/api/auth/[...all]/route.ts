import { auth } from "@/server/auth";

/**
 * The Better Auth HTTP surface (OP-85, contract §1.1).
 *
 * Better Auth owns these routes: this file only forwards `/api/auth/**` to the
 * configured instance's handler. Keeping it a thin adapter means every
 * auth-relevant policy lives in `@/server/auth` (cookies, origins, rate limits,
 * phone/2FA rules) rather than in a hand-rolled route.
 */

/** Node runtime: the MongoDB adapter and Node crypto are not Edge-safe. */
export const runtime = "nodejs";

/**
 * Handle a GET auth request (e.g. session lookups).
 *
 * @param request - The inbound request.
 * @returns Better Auth's response.
 */
export function GET(request: Request): Promise<Response> {
  return auth.handler(request);
}

/**
 * Handle a POST auth request (sign-in, OTP send/verify, 2FA).
 *
 * @param request - The inbound request.
 * @returns Better Auth's response.
 */
export function POST(request: Request): Promise<Response> {
  return auth.handler(request);
}
