import { describe, expect, it } from "vitest";

import {
  applyUnsubscribeScope,
  signUnsubscribeToken,
  UNSUBSCRIBE_TOKEN_TTL_DAYS,
  verifyUnsubscribeToken,
} from "@/server/notifications/unsubscribe";
import {
  DEFAULT_PREFERENCES,
  humaniseKey,
  type StoredPreferences,
} from "@/server/notifications/preferences";
import { fixedClock } from "@/server/runtime/clock";

import { makeChannelGroups, makeNotificationType } from "../../test/factories/notification";

/**
 * Unit — the one-click unsubscribe token and the scope reducer (OP-99, contract
 * §7.5; design §19.6; ADR-0240).
 *
 * Two pure behaviours own the correctness of the public unsubscribe surface, so
 * they live in `@/server/notifications/unsubscribe` rather than in the route:
 *
 *   U1 {@link signUnsubscribeToken} mints an HMAC token over
 *      `{ userId, scope, typeKey? }` with a 90-day expiry, and
 *      {@link verifyUnsubscribeToken} returns that exact payload back for an
 *      untampered token inside the window;
 *   U2 any single-character change to the token — in the payload segment or in
 *      the signature — is rejected as `{ valid: false, reason: "invalid" }`;
 *   U3 a token at or past its 90-day expiry is rejected as
 *      `{ valid: false, reason: "expired" }`, measured against an injected
 *      `Clock` (`fixedClock`), never the wall clock;
 *   U4 {@link applyUnsubscribeScope} is the scope reducer: the `"all"` sweep
 *      mutes the `email` channel group of every opt-outable type and **never**
 *      writes a transactional type; the reducer is pure.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/notifications/unsubscribe` exports:
 *
 *   - `signUnsubscribeToken(payload, { secret, now? })` → an opaque token;
 *   - `verifyUnsubscribeToken(token, { secret, now? })` →
 *     `{ valid: true, payload }` or `{ valid: false, reason: "invalid" | "expired" }`;
 *   - `applyUnsubscribeScope({ preferences, catalogue, scope, typeKey? })` →
 *     `{ preferences, mutedTypeKeys, stillReceiving }`;
 *   - `UNSUBSCRIBE_TOKEN_TTL_DAYS` (90) and the `UnsubscribeScope` /
 *     `UnsubscribeTokenPayload` types.
 *
 * The verified `payload` is the **signed payload exactly** — `userId`, `scope`
 * and (only for `scope: "type"`) `typeKey`. The expiry is token metadata and is
 * not echoed.
 *
 * ## Assumptions recorded in the handoff
 *
 * - The unsubscribe surface is **email-driven** (`List-Unsubscribe` and the
 *   email footer), so a scope application only ever writes the `email` channel
 *   group. `mobile` and `in_app` are never touched, whatever the token says.
 * - `stillReceiving` names the transactional types that remain deliverable
 *   (their display labels, sorted); it is how the `200` body says explicitly
 *   that critical mail is unaffected (contract §7.5).
 * - `mutedTypeKeys` and `stillReceiving` are sorted so two identical applications
 *   are byte-identical (I3 idempotency).
 */

/** A deterministic secret; never a real credential. */
const SECRET = "unit-unsubscribe-signing-secret-0123456789ab";

/** The fixed instant every token in this suite is minted at. */
const T0 = "2026-10-22T09:00:00.000Z";

/** A signed-in user id, shaped like a Better Auth ObjectId hex string. */
const USER_ID = "6702ff2c5d1f4a0012ab34cd";

/** The opt-outable type the seed offers for email (design §4). */
const OPT_OUTABLE_TYPE = "event.details.updated";

/** The transactional type that must never be muted (contract §7.5). */
const TRANSACTIONAL_TYPE = "billing.payment.failed";

/** Epoch millis for `T0`. */
const T0_MS = Date.parse(T0);

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fresh no-override baseline, cloned so a reducer can never share it. */
function baseline(): StoredPreferences {
  return structuredClone(DEFAULT_PREFERENCES);
}

/**
 * Flip the last character of a token (the signature segment) to another
 * character of the same alphabet, so only its bytes change.
 *
 * @param token - A token produced by {@link signUnsubscribeToken}.
 * @returns The same token with one signature character altered.
 */
function tamperSignature(token: string): string {
  const last = token.slice(-1);
  const replacement = last === "a" ? "b" : "a";
  return `${token.slice(0, -1)}${replacement}`;
}

/**
 * Flip the first character of the payload segment, keeping the dot structure.
 *
 * @param token - A token produced by {@link signUnsubscribeToken}.
 * @returns The same token with one payload character altered.
 */
function tamperPayload(token: string): string {
  const [payload = "", signature = ""] = token.split(".");
  const first = payload.slice(0, 1);
  const replacement = first === "e" ? "f" : "e";
  return `${replacement}${payload.slice(1)}.${signature}`;
}

/** The fixture catalogue: one opt-outable, one transactional, two locked types. */
function makeCatalogue() {
  return [
    makeNotificationType({
      typeKey: OPT_OUTABLE_TYPE,
      category: "event",
      channelGroups: makeChannelGroups({ email: { optOutAllowed: true } }),
    }),
    makeNotificationType({
      typeKey: TRANSACTIONAL_TYPE,
      category: "billing",
      transactional: true,
      severity: "critical",
      channelGroups: makeChannelGroups({ email: { optOutAllowed: false } }),
    }),
    makeNotificationType({
      typeKey: "account.email.locked",
      category: "account",
      channelGroups: makeChannelGroups({ email: { optOutAllowed: false } }),
    }),
    makeNotificationType({
      typeKey: "pipeline.internal.noise",
      category: "pipeline",
      channelGroups: makeChannelGroups({ email: { enabled: false, optOutAllowed: true } }),
    }),
  ];
}

describe("U1 — signUnsubscribeToken / verifyUnsubscribeToken round-trip", () => {
  it("round-trips a type-scoped token to the exact signed payload", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "type", typeKey: OPT_OUTABLE_TYPE },
      { secret: SECRET, now: fixedClock(T0) }
    );

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: true,
      payload: { userId: USER_ID, scope: "type", typeKey: OPT_OUTABLE_TYPE },
    });
  });

  it("round-trips an all-scope token without inventing a typeKey", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "all" },
      { secret: SECRET, now: fixedClock(T0) }
    );

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: true,
      payload: { userId: USER_ID, scope: "all" },
    });
  });

  it("round-trips a marketing-scope token", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "marketing" },
      { secret: SECRET, now: fixedClock(T0) }
    );

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: true,
      payload: { userId: USER_ID, scope: "marketing" },
    });
  });

  it("declares the contract's 90-day token lifetime", () => {
    expect(UNSUBSCRIBE_TOKEN_TTL_DAYS).toBe(90);
  });
});

describe("U2 — a tampered token is invalid", () => {
  /** A valid token minted at `T0`, verified in every case below. */
  function validToken(): string {
    return signUnsubscribeToken(
      { userId: USER_ID, scope: "type", typeKey: OPT_OUTABLE_TYPE },
      { secret: SECRET, now: fixedClock(T0) }
    );
  }

  it("rejects a token whose signature differs by one character", () => {
    const token = tamperSignature(validToken());

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("rejects a token whose payload differs by one character", () => {
    const token = tamperPayload(validToken());

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "all" },
      { secret: `${SECRET}-other`, now: fixedClock(T0) }
    );

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("rejects a token with no signature segment", () => {
    const payloadOnly = validToken().split(".")[0] ?? "";

    expect(verifyUnsubscribeToken(payloadOnly, { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });

  it("rejects an empty token", () => {
    expect(verifyUnsubscribeToken("", { secret: SECRET, now: fixedClock(T0) })).toEqual({
      valid: false,
      reason: "invalid",
    });
  });
});

describe("U3 — a token at or past its 90-day expiry is invalid", () => {
  it("still verifies one second before the 90-day expiry", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "all" },
      { secret: SECRET, now: fixedClock(T0) }
    );
    const almostExpired = new Date(T0_MS + UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_MS - 1_000);

    expect(
      verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(almostExpired) })
    ).toEqual({ valid: true, payload: { userId: USER_ID, scope: "all" } });
  });

  it("rejects the token exactly at the 90-day expiry as expired", () => {
    const token = signUnsubscribeToken(
      { userId: USER_ID, scope: "all" },
      { secret: SECRET, now: fixedClock(T0) }
    );
    const atExpiry = new Date(T0_MS + UNSUBSCRIBE_TOKEN_TTL_DAYS * DAY_MS);

    expect(verifyUnsubscribeToken(token, { secret: SECRET, now: fixedClock(atExpiry) })).toEqual({
      valid: false,
      reason: "expired",
    });
  });
});

describe("U4 — applyUnsubscribeScope never touches transactional types", () => {
  it("mutes the email group of every opt-outable type on scope all", () => {
    const application = applyUnsubscribeScope({
      preferences: baseline(),
      catalogue: makeCatalogue(),
      scope: "all",
    });

    expect(application.mutedTypeKeys).toEqual([OPT_OUTABLE_TYPE]);
    expect(application.preferences.byType).toEqual({ [OPT_OUTABLE_TYPE]: { email: "off" } });
  });

  it("leaves every transactional type out of the byType document on scope all", () => {
    const application = applyUnsubscribeScope({
      preferences: baseline(),
      catalogue: makeCatalogue(),
      scope: "all",
    });

    expect(application.preferences.byType[TRANSACTIONAL_TYPE]).toBeUndefined();
    expect(application.mutedTypeKeys).not.toContain(TRANSACTIONAL_TYPE);
  });

  it("reports the transactional labels that keep receiving mail", () => {
    const application = applyUnsubscribeScope({
      preferences: baseline(),
      catalogue: makeCatalogue(),
      scope: "all",
    });

    expect(application.stillReceiving).toEqual([humaniseKey(TRANSACTIONAL_TYPE)]);
  });

  it("preserves an existing non-email override while adding the email mute", () => {
    const stored = baseline();
    const preferences: StoredPreferences = {
      ...stored,
      byType: { [OPT_OUTABLE_TYPE]: { mobile: "off" } },
    };

    const application = applyUnsubscribeScope({
      preferences,
      catalogue: makeCatalogue(),
      scope: "all",
    });

    expect(application.preferences.byType).toEqual({
      [OPT_OUTABLE_TYPE]: { mobile: "off", email: "off" },
    });
  });

  it("does not mutate the document handed to it", () => {
    const stored = baseline();
    const snapshot = structuredClone(stored);

    applyUnsubscribeScope({ preferences: stored, catalogue: makeCatalogue(), scope: "all" });

    expect(stored).toEqual(snapshot);
  });

  it("mutes only the named type on scope type", () => {
    const application = applyUnsubscribeScope({
      preferences: baseline(),
      catalogue: makeCatalogue(),
      scope: "type",
      typeKey: OPT_OUTABLE_TYPE,
    });

    expect(application.mutedTypeKeys).toEqual([OPT_OUTABLE_TYPE]);
    expect(application.preferences.byType).toEqual({ [OPT_OUTABLE_TYPE]: { email: "off" } });
  });

  it("refuses to write a transactional type named by scope type", () => {
    const stored = baseline();

    const application = applyUnsubscribeScope({
      preferences: stored,
      catalogue: makeCatalogue(),
      scope: "type",
      typeKey: TRANSACTIONAL_TYPE,
    });

    expect(application.mutedTypeKeys).toEqual([]);
    expect(application.preferences).toEqual(stored);
  });

  it("writes no byType override on scope marketing", () => {
    const stored = baseline();

    const application = applyUnsubscribeScope({
      preferences: stored,
      catalogue: makeCatalogue(),
      scope: "marketing",
    });

    expect(application.mutedTypeKeys).toEqual([]);
    expect(application.preferences).toEqual(stored);
  });
});
