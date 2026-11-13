import { describe, expect, it } from "vitest";

import { selfieAttemptBudget } from "@/server/attendee/selfie-attempts";
import { COLLECTIONS } from "@/server/db/collections";
import { INDEX_SPECS, type IndexSpec } from "@/server/db/indexes";

/**
 * Unit contract — the selfie attempt budget
 * (OP-132 U2, contract §6.3 `attemptsUsed`/`attemptsRemaining`, §6.4, §14.1).
 *
 * **Why this exists.** §6.3 answers every submit with `attemptsUsed` and
 * `attemptsRemaining`, §6.4 repeats them on the polling endpoint, and the
 * `selfies.per_attendee` entitlement (a **hard** limit, scope `attendee`) is
 * what turns the fourth attempt into `403 plan_limit_exceeded`. The arithmetic
 * behind those three numbers is one pure function so the submit route, the
 * confirm route and the polling projection cannot disagree about it — and so a
 * budget can never report a negative remainder or an unspent remaining attempt.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/selfie-attempts` must export:
 *
 * ```ts
 * interface SelfieAttemptBudget {
 *   readonly attemptsUsed: number;       // the stored count, never rewritten
 *   readonly attemptsRemaining: number;  // 0 once spent, never negative
 *   readonly exhausted: boolean;         // true once used >= allowed
 * }
 * function selfieAttemptBudget(input: {
 *   readonly used: number;               // selfies this profile has submitted
 *   readonly allowed: number;            // entitlement limit, else settings.selfie
 * }): SelfieAttemptBudget;
 * ```
 *
 * ## Assumptions (recorded in the lane ADR)
 *
 * - **An attempt is a stored selfie row.** Schema §15.3 has no attempt counter,
 *   so `used` is the number of `selfies` rows the profile holds; the two-step
 *   submission (preprocess + confirm) is therefore **one** attempt, because the
 *   confirm activates the row the preprocess created instead of inserting a
 *   second one (I10).
 * - **`allowed` is always a number** at this seam: the route resolves the
 *   tenant's `selfies.per_attendee` entitlement and falls back to
 *   `platformSettings.selfie.attemptsAllowed` (the same fallback §6.1's
 *   `attemptsAllowed` advertises), so the function never has to reason about an
 *   unlimited plan.
 * - `attemptsUsed` echoes `used` verbatim even when it exceeds `allowed`: the
 *   contract reports what happened, and a client that burned attempts on a
 *   downgraded plan must not be told it used fewer than it did.
 */

/** The default budget a tenant with no gating plan gets (§6.1 fallback). */
const DEFAULT_ALLOWED = 3;

describe("selfieAttemptBudget — the numbers §6.3 and §6.4 report", () => {
  it("reports the full budget before the first attempt", () => {
    expect(selfieAttemptBudget({ used: 0, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 0,
      attemptsRemaining: DEFAULT_ALLOWED,
      exhausted: false,
    });
  });

  it("reports one spent attempt after the first submit", () => {
    expect(selfieAttemptBudget({ used: 1, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 1,
      attemptsRemaining: 2,
      exhausted: false,
    });
  });

  it("reports the last attempt as available but not yet exhausted", () => {
    expect(selfieAttemptBudget({ used: 2, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 2,
      attemptsRemaining: 1,
      exhausted: false,
    });
  });

  it("reports the budget as exhausted once the last attempt is spent", () => {
    expect(selfieAttemptBudget({ used: 3, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 3,
      attemptsRemaining: 0,
      exhausted: true,
    });
  });

  it("never reports a negative remainder when more attempts were stored than allowed", () => {
    expect(selfieAttemptBudget({ used: 4, allowed: DEFAULT_ALLOWED })).toEqual({
      attemptsUsed: 4,
      attemptsRemaining: 0,
      exhausted: true,
    });
  });

  it.each([
    { used: 0, allowed: 1, remaining: 1, exhausted: false },
    { used: 1, allowed: 1, remaining: 0, exhausted: true },
    { used: 7, allowed: 10, remaining: 3, exhausted: false },
    { used: 9, allowed: 10, remaining: 1, exhausted: false },
    { used: 10, allowed: 10, remaining: 0, exhausted: true },
  ])(
    "reports $remaining remaining of $allowed after $used used",
    ({ used, allowed, remaining, exhausted }) => {
      expect(selfieAttemptBudget({ used, allowed })).toEqual({
        attemptsUsed: used,
        attemptsRemaining: remaining,
        exhausted,
      });
    }
  );
});

/* ─────────────── the index set the selfie lane depends on ────────────────── */

/**
 * Unit contract — the §16.4 / §16.1 / §22 index set the selfie lane depends on
 * (OP-132 findings F-A3 and F-A4; registry `@/server/db/indexes`).
 *
 * **Why this exists.** The OP-132 F1 GREEN made two facts true that the
 * database does not enforce. It stamps a retention deadline (`expireAt`) on
 * every queued `selfies` row and writes the first `kind: "selfie"` row into
 * `media_assets` — a row that deliberately carries **no** `storage` descriptor,
 * because the selfie's bytes are the attendee's and are addressed by their own
 * content hash. Neither fact has an index behind it today:
 *
 *   1. `INDEX_SPECS` declares **no** `selfies` index set at all, so schema
 *      §16.4's `{expireAt: 1}` TTL (`expireAfterSeconds: 0`, §22's
 *      biometric-minimisation row) does not exist in any environment. The field
 *      the submit route writes is a deadline nothing enforces: a biometric row
 *      would live forever.
 *   2. The tenant-wide dedupe key is `[tenantId, contentHash]` with no `kind`,
 *      so a selfie hash and an organizer upload of the same bytes are forced to
 *      share one asset row. The organizer path then reads the selfie row's
 *      `storage` descriptor, which does not exist
 *      (`@/server/uploads/complete-upload`), and registers an `eventImages` row
 *      against an asset it cannot describe.
 *
 * ## The two invariants pinned here
 *
 * 1. **The retention field is enforced.** Exactly one TTL index on `selfies`,
 *    keyed `[["expireAt", 1]]` with `expireAfterSeconds: 0` — the same shape
 *    §22's other TTL collections use, and the shape the registry's own U2 lint
 *    (`@/server/db/indexes.test.ts`) requires of every TTL index.
 * 2. **Asset identity distinguishes kinds.** No unique index on `media_assets`
 *    may be kind-blind: two rows that differ **only** by `kind` must not be
 *    forced to share one asset. Accepted encodings are (a) `kind` as a key of
 *    the unique dedupe index — the encoding asserted here and the one the lane
 *    accepted — and (b) a partial unique index whose
 *    `partialFilterExpression` fixes `kind`. The integration pin
 *    `selfie-upload-collision.test.ts` I4 asserts the invariant itself (two
 *    rows differing only by `kind` coexist), so either encoding satisfies it.
 *
 * Both cases assert the **declared** registry, so they are cheap: no database,
 * no route, no fixture. The behaviour they imply is pinned where it is
 * observable, in `apps/web/src/test/integration/selfie-upload-collision.test.ts`.
 *
 * See `docs/adr/ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md`.
 */

/** True when a unique spec's key tuple or its partial filter fixes `kind`. */
function distinguishesKind(spec: IndexSpec): boolean {
  if (spec.keys.some(([field]) => field === "kind")) {
    return true;
  }
  const filter = spec.partialFilterExpression;
  return filter !== undefined && "kind" in filter;
}

describe("the index set — the selfies retention TTL (F-A3, schema §16.4 / §22)", () => {
  it("declares an {expireAt: 1} TTL index on selfies that expires immediately", () => {
    const ttlSpecs = INDEX_SPECS.filter(
      (spec) => spec.collection === COLLECTIONS.selfies && spec.expireAfterSeconds !== undefined
    );
    const [spec] = ttlSpecs;
    if (spec === undefined || ttlSpecs.length !== 1) {
      throw new Error(
        `expected INDEX_SPECS to declare exactly one '${COLLECTIONS.selfies}' TTL index ` +
          `(schema §16.4's {expireAt: 1}, §22's biometric retention), found ${String(ttlSpecs.length)}`
      );
    }

    expect(spec.keys, "a TTL index must key on expireAt alone").toEqual([["expireAt", 1]]);
    expect(spec.expireAfterSeconds, "the TTL monitor must expire at the deadline").toBe(0);
  });
});

describe("the index set — asset identity distinguishes kinds (F-A4, schema §16.1)", () => {
  it("keys every unique mediaAssets index on the kind, not on the hash alone", () => {
    const uniqueSpecs = INDEX_SPECS.filter(
      (spec) => spec.collection === COLLECTIONS.mediaAssets && spec.unique === true
    );
    expect(uniqueSpecs.length, "expected at least one unique mediaAssets index").toBeGreaterThan(0);

    const blind = uniqueSpecs.filter((spec) => !distinguishesKind(spec)).map((spec) => spec.name);

    expect(
      blind,
      "a unique media_assets index keyed on (tenantId, contentHash) alone forces a selfie and an " +
        "organizer upload of the same bytes onto one asset row; add `kind` to the key (or make the " +
        "index partial on it)"
    ).toEqual([]);
  });
});
