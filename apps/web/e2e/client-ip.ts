import { createHash } from "node:crypto";

/**
 * The per-spec client identity the e2e suite announces on `x-forwarded-for`
 * (OP-117, ADR-0601 §D2).
 *
 * `auth.otp` is limited by **contact** (5 / hour) *and* by **client IP**
 * (15 / hour) (`@/server/rate-limit/classes`), and `createRateLimitHook` applies
 * both legs to every path in `OTP_SEND_PATHS`. Playwright's `request` fixture
 * sends no forwarding header, so the Next standalone server stamps the socket
 * address and every spec shares one IP bucket: once the suite as a whole sends
 * its 16th OTP, the next spec gets `429 too_many_requests` — a harness budget
 * problem, not a product defect.
 *
 * `resolveClientIp` trusts `x-forwarded-for` in the e2e configuration (ADR-0024),
 * so a spec that announces its own address keeps its own bucket. The address is
 * derived from the spec's **own file name**: two specs cannot collide by
 * copy-paste, and a re-run of one spec reuses the same identity.
 *
 * @param specFile - The spec's file name, e.g. `"auth.spec.ts"`.
 * @returns A private (RFC 1918, `10/8`) IPv4 address unique to that spec file.
 */
export function clientIpFor(specFile: string): string {
  const octets = createHash("sha256").update(specFile).digest().readUInt32BE(0);
  // 10/8 is private; `% 254 + 1` keeps the host octet in 1..254 (no network or
  // broadcast address) so the value always reads as a real client address.
  return `10.${String((octets >>> 16) & 0xff)}.${String((octets >>> 8) & 0xff)}.${String(((octets & 0xff) % 254) + 1)}`;
}
