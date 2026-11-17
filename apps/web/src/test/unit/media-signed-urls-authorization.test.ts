/**
 * Unit — the §5.6 batch signed-media-URL *decisions* (OP-128 U1/U2).
 *
 * The contract (§5.6, media doc §25) splits the endpoint into two pure
 * questions that this spec pins, one per `describe`:
 *
 * - **U1 — may this one item be signed?** The answer depends on the item's
 *   `kind`, the caller's relationship to the event and the plan's
 *   `originals.download` feature gate. Denials carry a stable code:
 *   - `not_found` — the image is not a live image of the scope event (missing,
 *     soft-deleted, another event's, or its asset row is gone). Deliberately
 *     checked **first**, so every out-of-scope reason collapses into one code
 *     and the *reason* is never disclosed. It is not an ownership oracle; it
 *     does separate "in scope" from "not in scope" (see A2).
 *   - `forbidden` — the caller has no relationship that grants this kind
 *     (`thumbnail`: event member **or** a match; `original`: the same **and**
 *     the plan's gate).
 *   - `feature_not_available` — the caller *would* be entitled, but the
 *     tenant's active plan does not enable `originals.download` (§0.14, §6.6).
 *   - `authentication_required` — no credential was resolved at all, so there
 *     is no identity to match against (see the assumption below).
 * - **U2 — does the whole batch still answer `200`?** One denied item must not
 *   fail a 200-item refresh (§5.6: "a 200-item batch must not fail because one
 *   image was hidden"), so only an **all-denied** batch escalates to `403`.
 *
 * ## The contract this spec expects the implementation to expose
 *
 * `@/server/media/signed-urls` exports
 * `authorizeSignedUrlItem(input): SignedUrlDecision` and
 * `signedUrlBatchStatus(decisions): 200 | 403`, with the input discriminated by
 * `kind` and carrying the caller class, the match fact, the plan fact and the
 * live image (or `null`). The route handler keeps the I/O; these functions keep
 * the policy, so the table is readable and the route cannot drift from it.
 *
 * ## Assumptions (ADR-0766)
 *
 * - **A1 — `authentication_required` never escalates the batch to `403`.** An
 *   anonymous caller has nothing to be authorized *for*, so every item is
 *   denied `authentication_required` and the batch still answers `200` with the
 *   `denied[]` list (OP-128 I6). Without this exemption a single anonymous
 *   `original` request would be a `403`, which the card explicitly rules out.
 * - **A2 — `not_found` is the first rule, and its code is not an ownership
 *   oracle.** The precedence is `not_found` → `authentication_required` →
 *   `feature_not_available` → `forbidden`, so an id that is not a live image of
 *   the scope event is refused before identity or plan facts are read: a
 *   missing id, a soft-deleted image, another event's image and an image whose
 *   asset row is gone all answer the **same** code, so the *reason* — and with
 *   it any ownership fact — is never disclosed.
 *
 *   What this rule does **not** hide is "in scope" versus "not in scope". An
 *   anonymous caller on a live scope event gets `authentication_required` for
 *   an existing image but `not_found` for an absent one; both rows are pinned
 *   below. That distinction is a deliberate consequence of putting `not_found`
 *   first, and it is the opposite of a claim that an anonymous request cannot
 *   tell the two apart. Making that stricter claim true would move
 *   `authentication_required` ahead of `not_found` for anonymous callers — a
 *   behaviour change that also re-pins the anonymous out-of-scope row, so it
 *   needs its own card and ADR (ADR-0771 D2 records the correction).
 * - **A3 — a hidden image denies a *matched attendee* but is not a data-scope
 *   fact.** Hiding writes only `event_images.visibility` (ADR-0762 D5/A5), so
 *   the §5.6 gate must treat `visibility: "hidden"` as "not in this attendee's
 *   gallery" — that is the bypass OP-127's RED could not reach. Whether a
 *   hidden image stays signable for an **event member** (whose own §4.4 grid
 *   lists and signs hidden images) is left to the implementation and is
 *   deliberately not pinned here (see the ADR's open items).
 */
import { describe, expect, it } from "vitest";

import {
  authorizeSignedUrlItem,
  signedUrlBatchStatus,
  type SignedUrlAuthorizationInput,
  type SignedUrlDecision,
  type SignedUrlDenialCode,
} from "@/server/media/signed-urls";

/** The plan gate as the route resolves it once per request (§0.14). */
const ORIGINALS_ON = true;
const ORIGINALS_OFF = false;

/** A live, visible image inside the scope event. */
const VISIBLE = { hidden: false } as const;
/** A live image the organizer hid — out of the attendee gallery, not deleted. */
const HIDDEN = { hidden: true } as const;
/** No live image of the scope event carries the requested id. */
const ABSENT = null;

/** One table row of the U1 decision table. */
interface DecisionRow {
  /** The observable behaviour, as a sentence. */
  readonly name: string;
  /** The facts the route hands the decision. */
  readonly input: SignedUrlAuthorizationInput;
  /** The decision the contract requires. */
  readonly expected: SignedUrlDecision;
}

const ALLOWED: SignedUrlDecision = { allowed: true };
const FORBIDDEN: SignedUrlDecision = { allowed: false, code: "forbidden" };
const NOT_FOUND: SignedUrlDecision = { allowed: false, code: "not_found" };
const FEATURE_OFF: SignedUrlDecision = { allowed: false, code: "feature_not_available" };
const NEEDS_AUTH: SignedUrlDecision = { allowed: false, code: "authentication_required" };

/**
 * Build one U1 row: an event member's item.
 *
 * @param name - The behaviour the row names.
 * @param kind - The derivative requested.
 * @param image - The live image, or `null` when it is out of scope.
 * @param originalsAllowed - The plan's `originals.download` gate.
 * @param expected - The required decision.
 * @returns The table row.
 */
function memberRow(
  name: string,
  kind: "thumbnail" | "original",
  image: SignedUrlAuthorizationInput["image"],
  originalsAllowed: boolean,
  expected: SignedUrlDecision
): DecisionRow {
  return {
    name,
    input: { kind, caller: "member", matched: false, originalsAllowed, image },
    expected,
  };
}

/**
 * Build one U1 row: an attendee's item (a caller with a `faceMatches` row or
 * without one).
 *
 * @param name - The behaviour the row names.
 * @param kind - The derivative requested.
 * @param matched - Whether the caller has a `face_matches` row for the image.
 * @param image - The live image, or `null` when it is out of scope.
 * @param originalsAllowed - The plan's `originals.download` gate.
 * @param expected - The required decision.
 * @returns The table row.
 */
function attendeeRow(
  name: string,
  kind: "thumbnail" | "original",
  matched: boolean,
  image: SignedUrlAuthorizationInput["image"],
  originalsAllowed: boolean,
  expected: SignedUrlDecision
): DecisionRow {
  return { name, input: { kind, caller: "attendee", matched, originalsAllowed, image }, expected };
}

/** An event member (organizer, co-organizer or active tenant member). */
const MEMBER_ROWS: readonly DecisionRow[] = [
  memberRow("signs a thumbnail for an event member", "thumbnail", VISIBLE, ORIGINALS_OFF, ALLOWED),
  memberRow(
    "signs an original for an event member while the plan enables originals.download",
    "original",
    VISIBLE,
    ORIGINALS_ON,
    ALLOWED
  ),
  memberRow(
    "denies the original as feature_not_available when the plan disables originals.download",
    "original",
    VISIBLE,
    ORIGINALS_OFF,
    FEATURE_OFF
  ),
  memberRow(
    "still signs the thumbnail of the same image while originals are disabled",
    "thumbnail",
    VISIBLE,
    ORIGINALS_OFF,
    ALLOWED
  ),
];

/** A caller whose only claim is a `face_matches` row (an attendee). */
const ATTENDEE_ROWS: readonly DecisionRow[] = [
  attendeeRow(
    "signs a thumbnail for a matched attendee",
    "thumbnail",
    true,
    VISIBLE,
    ORIGINALS_OFF,
    ALLOWED
  ),
  attendeeRow(
    "denies a thumbnail to an attendee with no match for that image",
    "thumbnail",
    false,
    VISIBLE,
    ORIGINALS_ON,
    FORBIDDEN
  ),
  attendeeRow(
    "signs an original for a matched attendee while the plan enables originals.download",
    "original",
    true,
    VISIBLE,
    ORIGINALS_ON,
    ALLOWED
  ),
  attendeeRow(
    "denies the matched attendee's original as feature_not_available when the plan disables it",
    "original",
    true,
    VISIBLE,
    ORIGINALS_OFF,
    FEATURE_OFF
  ),
  attendeeRow(
    "denies an original to an attendee with no match even while the plan enables originals",
    "original",
    false,
    VISIBLE,
    ORIGINALS_ON,
    FORBIDDEN
  ),
  attendeeRow(
    "denies a thumbnail of an organizer-hidden image to an attendee who has a match for it",
    "thumbnail",
    true,
    HIDDEN,
    ORIGINALS_ON,
    FORBIDDEN
  ),
  attendeeRow(
    "denies an original of an organizer-hidden image to an attendee who has a match for it",
    "original",
    true,
    HIDDEN,
    ORIGINALS_ON,
    FORBIDDEN
  ),
];

/** A request that resolved no principal at all. */
const ANONYMOUS_ROWS: readonly DecisionRow[] = [
  {
    name: "denies an anonymous caller's thumbnail as authentication_required",
    input: {
      kind: "thumbnail",
      caller: "anonymous",
      matched: false,
      originalsAllowed: ORIGINALS_ON,
      image: VISIBLE,
    },
    expected: NEEDS_AUTH,
  },
  {
    name: "denies an anonymous caller's original as authentication_required",
    input: {
      kind: "original",
      caller: "anonymous",
      matched: false,
      originalsAllowed: ORIGINALS_ON,
      image: VISIBLE,
    },
    expected: NEEDS_AUTH,
  },
];

/** Ids that are not a live image of the scope event, for every caller class. */
const OUT_OF_SCOPE_ROWS: readonly DecisionRow[] = [
  memberRow(
    "refuses a member's thumbnail as not_found when the image is not in the scope event",
    "thumbnail",
    ABSENT,
    ORIGINALS_ON,
    NOT_FOUND
  ),
  memberRow(
    "refuses a member's original as not_found when the image was soft-deleted",
    "original",
    ABSENT,
    ORIGINALS_ON,
    NOT_FOUND
  ),
  attendeeRow(
    "refuses a matched attendee's thumbnail as not_found for a foreign-event image",
    "thumbnail",
    true,
    ABSENT,
    ORIGINALS_ON,
    NOT_FOUND
  ),
  {
    name: "refuses an anonymous caller's item as not_found before identity is considered",
    input: {
      kind: "original",
      caller: "anonymous",
      matched: false,
      originalsAllowed: ORIGINALS_ON,
      image: ABSENT,
    },
    expected: NOT_FOUND,
  },
];

/**
 * The denial code one decision carries, or `undefined` when the item is allowed.
 *
 * Nothing here reads `.code` on an allowed decision: the `decision.allowed`
 * check narrows a discriminated union to `{ allowed: false; code }`, so
 * `SignedUrlDecision` may tighten from `code?: …` to
 * `{ allowed: true } | { allowed: false; code }` without this pin failing to
 * compile (ADR-0771 D3). A denied decision that carries no code still fails,
 * because the expected side is read through the same helper.
 *
 * @param decision - One decision from the table.
 * @returns The denial code, or `undefined` for an allowed item.
 */
function codeOf(decision: SignedUrlDecision): SignedUrlDenialCode | undefined {
  return decision.allowed ? undefined : decision.code;
}

describe("U1: the per-item authorization decision", () => {
  describe("when the caller is an event member", () => {
    it.each(MEMBER_ROWS)("$name", ({ input, expected }) => {
      // Act
      const decision = authorizeSignedUrlItem(input);

      // Assert
      expect(decision).toEqual(expected);
    });
  });

  describe("when the caller is an attendee", () => {
    it.each(ATTENDEE_ROWS)("$name", ({ input, expected }) => {
      // Act
      const decision = authorizeSignedUrlItem(input);

      // Assert
      expect(decision).toEqual(expected);
    });
  });

  describe("when the caller presented no credential", () => {
    it.each(ANONYMOUS_ROWS)("$name", ({ input, expected }) => {
      // Act
      const decision = authorizeSignedUrlItem(input);

      // Assert
      expect(decision).toEqual(expected);
    });
  });

  describe("when the requested image is not a live image of the scope event", () => {
    it.each(OUT_OF_SCOPE_ROWS)("$name", ({ input, expected }) => {
      // Act
      const decision = authorizeSignedUrlItem(input);

      // Assert
      expect(decision).toEqual(expected);
    });
  });

  it("never allows an item without a code when it denies one", () => {
    // Arrange — every row of the table is a decision, not a shape variant.
    const rows = [...MEMBER_ROWS, ...ATTENDEE_ROWS, ...ANONYMOUS_ROWS, ...OUT_OF_SCOPE_ROWS];

    // Act
    const shapes = rows.map((row) => {
      const decision = authorizeSignedUrlItem(row.input);
      return { allowed: decision.allowed, code: codeOf(decision) };
    });

    // Assert — an allowed decision carries no code; a denied one always does,
    // and it is the code the row expects.
    expect(shapes).toEqual(
      rows.map((row) => ({ allowed: row.expected.allowed, code: codeOf(row.expected) }))
    );
  });
});

describe("U2: the all-denied -> 403 rule", () => {
  it("escalates a batch whose every item was denied to 403", () => {
    // Act
    const status = signedUrlBatchStatus([FORBIDDEN, NOT_FOUND]);

    // Assert
    expect(status).toBe(403);
  });

  it("keeps a batch at 200 when one item of two hundred was allowed", () => {
    // Arrange — 199 denials and one URL is the documented partial-refresh case.
    const decisions = [ALLOWED, ...Array.from({ length: 199 }, () => FORBIDDEN)];

    // Act
    const status = signedUrlBatchStatus(decisions);

    // Assert
    expect(status).toBe(200);
  });

  it("keeps a batch at 200 when every denial is authentication_required", () => {
    // Arrange — an anonymous caller learns per item that it must sign in.
    const decisions = [NEEDS_AUTH, NEEDS_AUTH];

    // Act
    const status = signedUrlBatchStatus(decisions);

    // Assert
    expect(status).toBe(200);
  });

  it("does not escalate a mixed denial batch that includes authentication_required", () => {
    // Arrange — a caller credentialed for one item and anonymous for another.
    const decisions = [NEEDS_AUTH, FORBIDDEN];

    // Act
    const status = signedUrlBatchStatus(decisions);

    // Assert
    expect(status).toBe(200);
  });

  it("escalates a feature_not_available-only batch to 403", () => {
    // Act
    const status = signedUrlBatchStatus([FEATURE_OFF, FEATURE_OFF]);

    // Assert
    expect(status).toBe(403);
  });

  it("answers 200 for an empty batch, which the wire validation refuses before it", () => {
    // Act
    const status = signedUrlBatchStatus([]);

    // Assert
    expect(status).toBe(200);
  });
});
