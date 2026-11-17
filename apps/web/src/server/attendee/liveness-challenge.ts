import { randomBytes } from "node:crypto";

/**
 * The liveness-challenge generator and its validity decision (OP-132, contract
 * §6.3, schema §16.4; ADR-0792).
 *
 * The challenge is a pure decision over stored facts, so it lives here without a
 * database: `POST /p/events/{slug}/liveness/challenges` mints one, the submit
 * route decides whether the one the attendee presents is still usable.
 *
 * Three facts define "usable": it is bound to the evidence the client sends
 * (`nonce`), it is unspent (`usedAt`), and it is unexpired (`expiresAt`, with an
 * inclusive deadline). The refusal vocabulary is exactly Appendix A row 3587 —
 * `expired` | `already_used` | `mismatch` — and the precedence is
 * `already_used` → `expired` → `mismatch`, because a spent challenge is the most
 * actionable answer: the attendee must ask for a new one whatever else is wrong.
 */

/** The gesture vocabulary a challenge may draw from (contract §6.3). */
export const LIVENESS_GESTURES = ["look_left", "look_right", "blink", "look_center"] as const;

/** How many gestures the on-screen sequence asks for (contract §6.3). */
export const LIVENESS_SEQUENCE_LENGTH = 3;

/** The on-screen gesture budget in milliseconds (contract §6.3). */
export const LIVENESS_TIMEOUT_MS = 15_000;

/** How long the challenge itself stays usable (contract §6.3's one minute). */
const LIVENESS_CHALLENGE_TTL_MS = 60_000;

/** A challenge's shape on the wire: the gesture sequence and its budget. */
export interface LivenessChallengeSpec {
  readonly sequence: readonly string[];
  readonly timeoutMs: number;
}

/** A freshly minted challenge, minus the store's own id. */
export interface CreatedLivenessChallenge {
  readonly challengeKind: "gesture";
  readonly spec: LivenessChallengeSpec;
  /** 16 random bytes as lowercase hex; the evidence must echo it. */
  readonly nonce: string;
  readonly expiresAt: Date;
}

/** Why a presented challenge is refused (Appendix A row 3587). */
export type LivenessChallengeFailureReason = "expired" | "already_used" | "mismatch";

/** The stored half of a challenge the decision reads. */
export interface StoredLivenessChallenge {
  readonly nonce: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/** The decision's two outcomes. */
export type LivenessChallengeDecision =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: LivenessChallengeFailureReason };

/** Options accepted by {@link createLivenessChallenge}. */
export interface CreateLivenessChallengeOptions {
  /** The instant of issue; `expiresAt` is one minute after it. */
  readonly now: Date;
  /** The injected draw stream; defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * Mint one gesture challenge.
 *
 * The sequence comes from the injected stream so a suite can pin it, and the
 * nonce comes from `crypto` rather than the instant so two challenges minted in
 * the same millisecond never share one — shared nonces would let evidence
 * cross-validate.
 *
 * @param options - The issue instant and an optional draw stream.
 * @returns The challenge kind, sequence, nonce and expiry.
 */
export function createLivenessChallenge(
  options: CreateLivenessChallengeOptions
): CreatedLivenessChallenge {
  const random = options.random ?? Math.random;
  const sequence = Array.from(
    { length: LIVENESS_SEQUENCE_LENGTH },
    () => LIVENESS_GESTURES[Math.floor(random() * LIVENESS_GESTURES.length)] ?? LIVENESS_GESTURES[0]
  );

  return {
    challengeKind: "gesture",
    spec: { sequence, timeoutMs: LIVENESS_TIMEOUT_MS },
    nonce: randomBytes(16).toString("hex"),
    expiresAt: new Date(options.now.getTime() + LIVENESS_CHALLENGE_TTL_MS),
  };
}

/** Options accepted by {@link decideLivenessChallenge}. */
export interface DecideLivenessChallengeInput {
  /** The stored challenge the caller presented. */
  readonly challenge: StoredLivenessChallenge;
  /** The instant of the decision. */
  readonly now: Date;
  /** The nonce the submitted evidence claims. */
  readonly evidenceNonce: string;
}

/**
 * Decide whether a presented challenge may buy one attempt.
 *
 * @param input - The stored challenge, the instant and the evidence nonce.
 * @returns `{ valid: true }`, or the single reason it is refused.
 */
export function decideLivenessChallenge(
  input: DecideLivenessChallengeInput
): LivenessChallengeDecision {
  if (input.challenge.usedAt !== null) {
    return { valid: false, reason: "already_used" };
  }
  // Inclusive deadline: a challenge is usable up to and including `expiresAt`.
  if (input.now.getTime() > input.challenge.expiresAt.getTime()) {
    return { valid: false, reason: "expired" };
  }
  // A nonce is hex; a client that uppercases it still names the same challenge.
  if (input.evidenceNonce.toLowerCase() !== input.challenge.nonce.toLowerCase()) {
    return { valid: false, reason: "mismatch" };
  }
  return { valid: true };
}
