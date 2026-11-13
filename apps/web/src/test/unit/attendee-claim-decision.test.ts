import { describe, expect, it } from "vitest";

import * as decision from "@/server/attendee/claim-decision";

/**
 * Unit contract — the claim decision table (OP-134 U2, contract §6.7, schema
 * §15.3 "The claim operation"; ADR-0813).
 *
 * **Why this exists.** A claim has to answer one question per event the
 * anonymous session touched: *does this caller already own a profile here?*
 *
 * - **No** → schema §15.3's atomic re-point is safe: the row keeps its `_id`,
 *   its matches and its selfie, and only `subject` changes. "She doesn't have to
 *   re-visit and re-upload."
 * - **Yes** → the re-point is impossible. The unique partial index
 *   `{eventId:1, "subject.userId":1}` on `subject.kind:"user"` forbids a second
 *   user profile per event, so the claim must **skip** the row
 *   (`skipped[].reason: "already_claimed_by_this_user"`, contract §6.7) and
 *   decide, separately, which of the two active selfies survives.
 *
 * That second half is where the damage lives: an attendee who already had a
 * profile and then uploaded anonymously on a second device must not end up
 * matched against the *older* face photo. The documented rule is "keep the newest
 * active selfie" — one comparison, one boolean, and it belongs in a pure
 * function so the rule is readable without a database.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/claim-decision` must export:
 *
 * ```ts
 * export type ClaimSkipReason = "already_claimed_by_this_user";
 *
 * export interface ClaimDecisionInput {
 *   readonly hasExistingUserProfile: boolean;
 *   // The anonymous profile's `activeSelfieId` row's `createdAt`, when it has one.
 *   readonly anonymousSelfieCreatedAt: Date | null;
 *   // The existing user profile's `activeSelfieId` row's `createdAt`, when it has one.
 *   readonly existingSelfieCreatedAt: Date | null;
 * }
 *
 * export type ClaimDecision =
 *   | { readonly action: "repoint" }
 *   | {
 *       readonly action: "merge";
 *       readonly skipReason: ClaimSkipReason;
 *       readonly adoptAnonymousSelfie: boolean;
 *     };
 *
 * export function decideClaim(input: ClaimDecisionInput): ClaimDecision;
 * ```
 *
 * ## The decision table (documented in ADR-0813)
 *
 * | existing profile | anonymous selfie | existing selfie | action   | adopt |
 * | ---------------- | ---------------- | --------------- | -------- | ----- |
 * | no               | any              | any             | `repoint`| —     |
 * | yes              | present          | absent          | `merge`  | true  |
 * | yes              | absent           | present         | `merge`  | false |
 * | yes              | present, newer   | present         | `merge`  | true  |
 * | yes              | present, older   | present         | `merge`  | false |
 * | yes              | present, equal   | present         | `merge`  | false |
 * | yes              | absent           | absent          | `merge`  | false |
 *
 * The tie arm is a **choice**: two selfies with the same `createdAt` cannot be
 * ordered, so the existing profile keeps its own (`adoptAnonymousSelfie: false`)
 * — the row that already owns the matches is not rewritten for a coin flip.
 * ADR-0813 §Assumptions records it.
 */

/** An arbitrary but fixed instant; the table only compares instants to each other. */
const OLDER = new Date("2027-01-01T09:00:00.000Z");

/** One day after {@link OLDER}. */
const NEWER = new Date("2027-01-02T09:00:00.000Z");

/** One case of the decision table. */
interface DecisionCase {
  readonly name: string;
  readonly input: decision.ClaimDecisionInput;
  readonly expected: decision.ClaimDecision;
}

const MERGE_SKIP: decision.ClaimDecision = {
  action: "merge",
  skipReason: "already_claimed_by_this_user",
  adoptAnonymousSelfie: false,
};

const MERGE_ADOPT: decision.ClaimDecision = {
  action: "merge",
  skipReason: "already_claimed_by_this_user",
  adoptAnonymousSelfie: true,
};

const REPOINT: decision.ClaimDecision = { action: "repoint" };

const DECISION_CASES: readonly DecisionCase[] = [
  {
    name: "no existing profile re-points the anonymous row",
    input: {
      hasExistingUserProfile: false,
      anonymousSelfieCreatedAt: NEWER,
      existingSelfieCreatedAt: null,
    },
    expected: REPOINT,
  },
  {
    name: "no existing profile re-points even when the caller has an older selfie elsewhere",
    input: {
      hasExistingUserProfile: false,
      anonymousSelfieCreatedAt: OLDER,
      existingSelfieCreatedAt: NEWER,
    },
    expected: REPOINT,
  },
  {
    name: "the newer anonymous selfie is adopted",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: NEWER,
      existingSelfieCreatedAt: OLDER,
    },
    expected: MERGE_ADOPT,
  },
  {
    name: "an older anonymous selfie is not adopted",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: OLDER,
      existingSelfieCreatedAt: NEWER,
    },
    expected: MERGE_SKIP,
  },
  {
    name: "a tie keeps the existing profile's selfie",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: NEWER,
      existingSelfieCreatedAt: NEWER,
    },
    expected: MERGE_SKIP,
  },
  {
    name: "an anonymous selfie is adopted when the existing profile has none",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: NEWER,
      existingSelfieCreatedAt: null,
    },
    expected: MERGE_ADOPT,
  },
  {
    name: "an anonymous selfie is not adopted when only the existing profile has one",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: null,
      existingSelfieCreatedAt: NEWER,
    },
    expected: MERGE_SKIP,
  },
  {
    name: "two profiles without a selfie merge without adopting anything",
    input: {
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: null,
      existingSelfieCreatedAt: null,
    },
    expected: MERGE_SKIP,
  },
];

describe("decideClaim — the claim decision table (contract §6.7, schema §15.3)", () => {
  it.each(DECISION_CASES)("$name", (testCase) => {
    // Act
    const result = decision.decideClaim(testCase.input);

    // Assert
    expect(result).toEqual(testCase.expected);
  });

  it("the skip reason is the contract's own literal", () => {
    // Contract §6.7 spells `skipped[].reason` as an enum-shaped string; the
    // client branches on it, so a paraphrase breaks the client, not the server.
    const merged = decision.decideClaim({
      hasExistingUserProfile: true,
      anonymousSelfieCreatedAt: null,
      existingSelfieCreatedAt: null,
    });

    expect(merged).toMatchObject({ skipReason: "already_claimed_by_this_user" });
  });
});
