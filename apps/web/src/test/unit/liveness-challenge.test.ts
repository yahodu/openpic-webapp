import { describe, expect, it } from "vitest";

import {
  LIVENESS_GESTURES,
  LIVENESS_SEQUENCE_LENGTH,
  LIVENESS_TIMEOUT_MS,
  createLivenessChallenge,
  decideLivenessChallenge,
} from "@/server/attendee/liveness-challenge";

/**
 * Unit contract — the liveness challenge generator and its validity decision
 * (OP-132 U1 + U3, contract §6.3, schema §16.4, Appendix A row 3587).
 *
 * **Why this exists.** `POST /p/events/{slug}/liveness/challenges` hands the
 * attendee a gesture sequence to perform; the submit route must then decide
 * whether the challenge the attendee presents is still usable. Both halves are
 * pure decisions over stored facts, so they are pinned here without a database:
 * the generator must be random and shaped exactly as §6.3 documents, and the
 * decision must name **the** reason a challenge is refused — Appendix A row
 * 3587 fixes that vocabulary to exactly
 * `{ reason: "expired" | "already_used" | "mismatch" }`, and the route copies it
 * into `409 liveness_challenge_invalid`.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/liveness-challenge` must export:
 *
 * ```ts
 * const LIVENESS_GESTURES: readonly string[];       // the gesture vocabulary
 * const LIVENESS_SEQUENCE_LENGTH: number;           // 3
 * const LIVENESS_TIMEOUT_MS: number;                // 15000
 *
 * interface LivenessChallengeSpec {
 *   readonly sequence: readonly string[];           // members of LIVENESS_GESTURES
 *   readonly timeoutMs: number;
 * }
 * interface CreatedLivenessChallenge {
 *   readonly challengeKind: "gesture";
 *   readonly spec: LivenessChallengeSpec;
 *   readonly nonce: string;                         // 32 lowercase hex
 *   readonly expiresAt: Date;                       // now + 60_000
 * }
 * function createLivenessChallenge(options: {
 *   readonly now: Date;
 *   readonly random?: () => number;                 // defaults to Math.random
 * }): CreatedLivenessChallenge;
 *
 * type LivenessChallengeFailureReason = "expired" | "already_used" | "mismatch";
 * interface StoredLivenessChallenge {
 *   readonly nonce: string;
 *   readonly expiresAt: Date;
 *   readonly usedAt: Date | null;
 * }
 * type LivenessChallengeDecision =
 *   | { readonly valid: true }
 *   | { readonly valid: false; readonly reason: LivenessChallengeFailureReason };
 * function decideLivenessChallenge(input: {
 *   readonly challenge: StoredLivenessChallenge;
 *   readonly now: Date;
 *   readonly evidenceNonce: string;                 // the nonce the evidence claims
 * }): LivenessChallengeDecision;
 * ```
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **`nonce` is the evidence binding.** §6.3's `201` body gains exactly one
 *   key, `nonce`, because the only way to detect the "evidence tied to a
 *   different challenge" refusal (I12) is for the challenge to carry a value the
 *   evidence must echo back. Without it the refusal is unimplementable.
 * - **`expiresAt` is one minute after issue.** §6.3's example shows a challenge
 *   whose `expiresAt` is one minute after it was handed out while the gesture
 *   sequence itself allows 15 s; the minute is the challenge's usable life and
 *   the 15 s is the on-screen gesture budget.
 * - **The decision's precedence is `already_used` → `expired` → `mismatch`.**
 *   A challenge that was already spent is the most actionable refusal (the
 *   attendee must ask for a new one), so it outranks an expiry or a nonce
 *   mismatch that would be reported for the same request.
 * - The generator's randomness must be **injectable** and must actually consume
 *   the injected stream: two different streams have to produce different
 *   sequences, and the same stream twice must reproduce one. That is what makes
 *   the generator testable without pinning `Math.random`.
 */

/* ────────────────────────────── fixtures ─────────────────────────────────── */

/** The instant every case generates or decides against. */
const NOW = new Date("2026-11-12T09:19:00.000Z");

/** The challenge's usable life, in milliseconds (contract §6.3). */
const CHALLENGE_TTL_MS = 60_000;

/** The on-screen gesture budget, in milliseconds (contract §6.3). */
const GESTURE_TIMEOUT_MS = 15_000;

/** The challenge kind §6.3 documents. */
const CHALLENGE_KIND = "gesture";

/** The nonce shape: 16 random bytes as lowercase hex. */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** A nonce that is not the challenge's own. */
const OTHER_NONCE = "0123456789abcdef0123456789abcdef";

/** The decision input for a challenge that is fresh, unused and self-consistent. */
function freshChallenge(
  overrides: Partial<Parameters<typeof decideLivenessChallenge>[0]["challenge"]> = {}
): Parameters<typeof decideLivenessChallenge>[0] {
  return {
    challenge: {
      nonce: OTHER_NONCE,
      expiresAt: new Date(NOW.getTime() + CHALLENGE_TTL_MS),
      usedAt: null,
      ...overrides,
    },
    now: NOW,
    evidenceNonce: OTHER_NONCE,
  };
}

/* ─────────────────────────── U1: the generator ───────────────────────────── */

describe("createLivenessChallenge — the §6.3 challenge shape", () => {
  it("builds a gesture challenge with a three-step sequence from the gesture vocabulary", () => {
    const challenge = createLivenessChallenge({ now: NOW });

    expect(challenge.challengeKind).toBe(CHALLENGE_KIND);
    expect(challenge.spec.sequence).toHaveLength(LIVENESS_SEQUENCE_LENGTH);
    expect(LIVENESS_SEQUENCE_LENGTH).toBe(3);
    for (const gesture of challenge.spec.sequence) {
      expect(LIVENESS_GESTURES).toContain(gesture);
    }
  });

  it("carries the 15-second gesture budget §6.3 documents", () => {
    const challenge = createLivenessChallenge({ now: NOW });

    expect(challenge.spec.timeoutMs).toBe(GESTURE_TIMEOUT_MS);
    expect(LIVENESS_TIMEOUT_MS).toBe(GESTURE_TIMEOUT_MS);
  });

  it("expires exactly one minute after it is issued", () => {
    const challenge = createLivenessChallenge({ now: NOW });

    expect(challenge.expiresAt.getTime() - NOW.getTime()).toBe(CHALLENGE_TTL_MS);
  });

  it("carries a 32-character lowercase hex nonce that binds the evidence to it", () => {
    const challenge = createLivenessChallenge({ now: NOW });

    expect(challenge.nonce).toMatch(NONCE_PATTERN);
    // Never derived from the instant: two challenges minted in the same
    // millisecond must not share a nonce, or evidence would cross-validate.
    const second = createLivenessChallenge({ now: NOW });
    expect(second.nonce).not.toBe(challenge.nonce);
  });

  it("mints a distinct nonce on every one of forty draws", () => {
    const nonces = new Set(
      Array.from({ length: 40 }, () => createLivenessChallenge({ now: NOW }).nonce)
    );

    expect(nonces.size).toBe(40);
  });

  it("varies the sequence across draws instead of always serving one fixed sequence", () => {
    const sequences = new Set(
      Array.from({ length: 40 }, () =>
        createLivenessChallenge({ now: NOW }).spec.sequence.join(",")
      )
    );

    expect(sequences.size).toBeGreaterThan(1);
  });

  it("reproduces the same sequence twice when the injected stream is the same", () => {
    const stream = (): number => 0.5;

    const first = createLivenessChallenge({ now: NOW, random: stream });
    const second = createLivenessChallenge({ now: NOW, random: stream });

    expect(first.spec.sequence).toEqual(second.spec.sequence);
  });

  it("produces different sequences for two different injected streams", () => {
    const low = createLivenessChallenge({ now: NOW, random: () => 0 });
    const high = createLivenessChallenge({ now: NOW, random: () => 0.999 });

    expect(low.spec.sequence).not.toEqual(high.spec.sequence);
  });
});

/* ──────────────────────── U3: the validity decision ──────────────────────── */

describe("decideLivenessChallenge — usable only once, unexpired, and bound to its evidence", () => {
  it("accepts a fresh challenge whose evidence echoes its nonce", () => {
    expect(decideLivenessChallenge(freshChallenge())).toEqual({ valid: true });
  });

  it("accepts a challenge that expires at this exact instant (the deadline is inclusive)", () => {
    const input = freshChallenge({ expiresAt: new Date(NOW.getTime()) });

    expect(decideLivenessChallenge(input)).toEqual({ valid: true });
  });

  it("refuses a challenge one millisecond past its expiry as expired", () => {
    const input = freshChallenge({ expiresAt: new Date(NOW.getTime() - 1) });

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "expired" });
  });

  it("refuses a challenge it already spent as already_used", () => {
    const input = freshChallenge({ usedAt: new Date(NOW.getTime() - 1_000) });

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "already_used" });
  });

  it("reports already_used, not expired, for a spent challenge that has also expired", () => {
    const input = freshChallenge({
      usedAt: new Date(NOW.getTime() - 5_000),
      expiresAt: new Date(NOW.getTime() - 1),
    });

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "already_used" });
  });

  it("reports already_used, not mismatch, for a spent challenge whose evidence names another nonce", () => {
    const input = {
      ...freshChallenge({ usedAt: new Date(NOW.getTime() - 1_000) }),
      evidenceNonce: "f".repeat(32),
    };

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "already_used" });
  });

  it("refuses evidence bound to a different challenge as mismatch", () => {
    const input = { ...freshChallenge(), evidenceNonce: "f".repeat(32) };

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "mismatch" });
  });

  it("reports expired, not mismatch, when a mismatched challenge has also expired", () => {
    const input = {
      ...freshChallenge({ expiresAt: new Date(NOW.getTime() - 1) }),
      evidenceNonce: "f".repeat(32),
    };

    expect(decideLivenessChallenge(input)).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts a challenge whose evidence echoes the nonce in a different case", () => {
    // A nonce is hex; a client that uppercases it must not be told its evidence
    // belongs to a different challenge.
    const input = { ...freshChallenge(), evidenceNonce: OTHER_NONCE.toUpperCase() };

    expect(decideLivenessChallenge(input)).toEqual({ valid: true });
  });
});
