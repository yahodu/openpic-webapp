/**
 * The complementary per-user cap on session-authenticated OTP verifies
 * (ADR-0021 §1, ADR-0023 §4).
 *
 * `auth.verify` deliberately does not count a session-authenticated verify, so
 * the `before` hook bounds those with this budget instead: one shared counter
 * per user (the salted-hash key under the `user` scope), spent on both
 * `/phone-number/verify` and `/two-factor/verify-otp`. The value lives here —
 * not in the frozen `RATE_LIMIT_CLASSES` table — so it is unit-testable on its
 * own and the class table stays untouched.
 */
export const AUTHENTICATED_VERIFY_CAP = {
  /** Maximum session-authenticated verifies per user within the window. */
  limit: 10,
  /** The rolling window length, in seconds. */
  windowSeconds: 600,
} as const;
