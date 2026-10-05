/**
 * Client-IP trust model for the rate-limit port (OP-85 follow-up, ADR-0024).
 *
 * An IP-keyed limit is only as trustworthy as the IP it is keyed by.
 * `x-forwarded-for` is a comma-separated, **client-writable** list, so a client
 * can rotate or prepend to it to evade a limit (and poison another caller's
 * bucket). The durable fix is to derive the IP from a header the trusted
 * fronting layer *overwrites* — a value no client can forge.
 *
 * {@link resolveClientIp} therefore consults a configured trusted header first
 * (`getTrustedClientIpHeader()`, e.g. the platform's `x-real-ip` /
 * `cf-connecting-ip`). Only when that knob is unset does it fall back to the
 * historical dev/e2e behaviour: the leftmost `x-forwarded-for` hop, then
 * `x-real-ip`. The fallback assumes the local/e2e fronting layer overwrites
 * `x-forwarded-for` (see ADR-0024 for the assumption and residual risk).
 */

/**
 * Resolve the trusted client IP from a request's forwarding headers.
 *
 * Precedence:
 *   1. the configured trusted header, when one is set — the edge overwrites it,
 *      so its value is not client-controllable;
 *   2. `x-forwarded-for` leftmost hop (dev/e2e fallback, trusted only because
 *      the fronting layer overwrites the header);
 *   3. `x-real-ip`.
 *
 * When a trusted header is configured but absent, `undefined` is returned
 * rather than silently falling back to the forgeable list — a misconfigured
 * deployment loses the IP leg (fail-safe) instead of trusting a spoof.
 *
 * @param headers - The request headers.
 * @param trustedHeader - The configured trusted header name, if any.
 * @returns The client IP, or `undefined` when none can be trusted.
 */
export function resolveClientIp(headers: Headers, trustedHeader?: string): string | undefined {
  if (trustedHeader !== undefined) {
    const value = headers.get(trustedHeader);
    return value === null || value.trim() === "" ? undefined : value.trim();
  }

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first !== "") {
      return first;
    }
  }

  const real = headers.get("x-real-ip");
  return real === null || real.trim() === "" ? undefined : real.trim();
}
