import { getAppEnv } from "@/server/config/env";
import { otpInbox, type OtpChannel } from "@/server/auth/otp-inbox";
import { isTestOtpRouteEnabled } from "@/server/auth/test-route";

/**
 * Test-only OTP read-back route (OP-85, §6).
 *
 * The e2e suite runs in a separate process from the Next server, so it cannot
 * read the server's in-memory OTP capture directly. This route exposes the most
 * recently captured code for a `contact`+`channel`. It is reachable **only**
 * when {@link isTestOtpRouteEnabled} allows the deploy env (`test`/`e2e`) and
 * answers `404` everywhere else — a leaked reader would be a sign-in-as-anyone
 * primitive. The code is peeked, not consumed, so a re-read is harmless.
 *
 * The contract path `/api/v1/__test__/otp` cannot host a route file directly
 * (Next.js treats `__test__` as a private folder); a rewrite in `next.config.ts`
 * maps that path onto this handler.
 */

/** Node runtime so the route shares the auth process's global inbox. */
export const runtime = "nodejs";

/** Parse the `channel` query value into the two valid channels. */
function parseChannel(value: string | null): OtpChannel | undefined {
  return value === "email" || value === "sms" ? value : undefined;
}

/**
 * Read back a captured OTP.
 *
 * @param request - The inbound request (`?contact=&channel=`).
 * @returns `404` outside the allow-listed environments, otherwise `200` with
 *   `{ code }` (`null` when nothing is pending for the contact).
 */
export function GET(request: Request): Response {
  if (!isTestOtpRouteEnabled(getAppEnv())) {
    return new Response(null, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const contact = params.get("contact");
  const channel = parseChannel(params.get("channel"));

  const captured =
    contact === null || channel === undefined
      ? undefined
      : [...otpInbox.list()]
          .reverse()
          .find((entry) => entry.channel === channel && entry.to === contact);

  return Response.json({ code: captured?.code ?? null }, { status: 200 });
}
