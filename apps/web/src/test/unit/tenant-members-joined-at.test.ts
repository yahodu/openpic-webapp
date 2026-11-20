import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { isoDateTimeSchema } from "@openpic/contracts";

import { projectMember, type MembershipDocument } from "@/server/tenancy/members";

/**
 * Unit / contract — the `joinedAt` projection of a workspace member (OP-101
 * follow-up, contract §2.2, ADR-0282).
 *
 * `projectMember()` is the single place a stored `tenantMembers` row becomes the
 * §2.2 `Member` DTO. It used to normalise the join instant with a bare
 * `new Date(value).toISOString()`, which throws `RangeError: Invalid time value`
 * for an absent, `null`, `NaN` or unparseable `joinedAt` — one corrupt row and
 * the whole workspace listing is a 5xx for every caller.
 *
 * The pins below fix both halves of the behaviour:
 *
 *   - **the valid path is unchanged** — a real `Date`, an RFC 3339 UTC string
 *     and epoch milliseconds each project to exactly the same ISO string the
 *     documented behaviour already produces;
 *   - **an unusable instant degrades, it never throws** — the row keeps its
 *     place in the listing and `joinedAt` carries the epoch sentinel
 *     `1970-01-01T00:00:00.000Z`.
 *
 * ## Why the epoch sentinel and not `null` (ADR-0282 §D2)
 *
 * Contract §2.2 shows `joinedAt` as a string instant and
 * `@/server/tenancy/member-schema` types it as `isoDateTimeSchema` — nullable is
 * not on the wire, a `null` would fail `serializeResponse` (and so still be a
 * 5xx), and the listing's own `joinedAt` sort would break on a `null`. The epoch
 * is a real, schema-valid, totally ordered instant that cannot be mistaken for a
 * real join time.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/members` must keep exporting
 * `projectMember(membership, user, profile): Member` and must treat the stored
 * `joinedAt` as `unknown`: whatever the value, the call returns a §2.2 member
 * whose `joinedAt` is a valid `isoDateTimeSchema` string — the exact instant when
 * the value names one, the epoch sentinel otherwise. How the reading is factored
 * (an inline guard, a local helper, or a shared reader) is not pinned.
 */

/** The instant every green control round-trips to, and its numeric form. */
const JOINED_AT_ISO = "2026-03-04T05:06:07.890Z";
const JOINED_AT_MILLIS = 1772600767890;

/** The instant an undatable `joinedAt` degrades to (ADR-0282 §D2). */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** The member id the projector stringifies; shape is all that matters here. */
const MEMBER_USER_ID = new ObjectId("6703bb00000000000000c001");
const WORKSPACE_ID = new ObjectId("6703bb00000000000000c0de");

/** The §2.2 member keys — a corrupt instant may not drop or add one. */
const MEMBER_DTO_KEYS = [
  "avatarUrl",
  "displayName",
  "emailMasked",
  "invitedByUserId",
  "joinedAt",
  "role",
  "status",
  "userId",
];

/**
 * A stored `tenantMembers` row (schema §13.4).
 *
 * `fields` is spread last, so a spec can override `joinedAt` — including with a
 * value the collection's own validator would never store — or omit it entirely.
 *
 * @param fields - Field overrides merged over an otherwise valid active row.
 * @returns The stored row shape the projector reads.
 */
function membership(fields: Record<string, unknown> = {}): MembershipDocument {
  return {
    tenantId: WORKSPACE_ID,
    userId: MEMBER_USER_ID,
    role: "member",
    status: "active",
    ...fields,
  };
}

describe("projectMember — `joinedAt` keeps the documented valid path", () => {
  it.each([
    ["a stored Date", new Date(JOINED_AT_ISO)],
    ["an RFC 3339 UTC string", JOINED_AT_ISO],
    ["epoch milliseconds as a number", JOINED_AT_MILLIS],
  ])("projects %s to the same documented ISO instant", (_label, stored) => {
    const projected = projectMember(membership({ joinedAt: stored }), undefined, undefined);

    expect(projected.joinedAt).toBe(JOINED_AT_ISO);
  });
});

describe("projectMember — an unusable `joinedAt` degrades instead of throwing", () => {
  it.each([
    ["an absent", {}],
    ["a null", { joinedAt: null }],
    ["a NaN", { joinedAt: Number.NaN }],
    ["an unparseable string", { joinedAt: "not-a-date" }],
    ["an invalid Date instance", { joinedAt: new Date("nope") }],
    ["an empty string", { joinedAt: "" }],
    ["a boolean", { joinedAt: true }],
    ["an object", { joinedAt: {} }],
  ])("degrades %s `joinedAt` to the epoch sentinel", (_label, fields) => {
    // A throw here is the defect the pins exist for: the RangeError escapes the
    // projector and the route answers 5xx for the whole listing.
    const projected = projectMember(membership(fields), undefined, undefined);

    expect(projected.joinedAt).toBe(EPOCH_ISO);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });

  it("still projects every §2.2 field of a row whose `joinedAt` is unusable", () => {
    const projected = projectMember(membership(), undefined, undefined);

    expect(Object.keys(projected).sort()).toEqual(MEMBER_DTO_KEYS);
    expect(projected).toMatchObject({
      userId: MEMBER_USER_ID.toHexString(),
      displayName: "",
      emailMasked: "•••",
      role: "member",
      status: "active",
      joinedAt: EPOCH_ISO,
      invitedByUserId: null,
      avatarUrl: null,
    });
  });
});

/**
 * Unit / contract — a numeric `joinedAt` whose instant lies outside the RFC 3339
 * four-digit-year range (OP-101 follow-up on the merged defensive restore,
 * contract §2.2, ADR-0282, ADR-0284).
 *
 * `projectMember()` reads the stored `joinedAt` as `unknown` and degrades every
 * value that cannot name an instant to the epoch sentinel. A **finite number**
 * is accepted as an instant, but `Date.prototype.toISOString()` leaves the
 * four-digit-year form once `|millis|` reaches the boundary:
 *
 * ```
 * new Date(253402300800000).toISOString()  -> "+010000-01-01T00:00:00.000Z"
 * new Date(8.64e15).toISOString()          -> "+275760-09-13T00:00:00.000Z"
 * new Date(-8.64e15).toISOString()         -> "-271821-04-20T00:00:00.000Z"
 * new Date(-62167219200001).toISOString()  -> "-000001-12-31T23:59:59.999Z"
 * ```
 *
 * `@openpic/contracts` `isoDateTimeSchema` rejects all four, so the projected
 * member is not a §2.2 member: the route's `serializeResponse` fails the strict
 * parse (it throws outside production) and the whole listing is a `5xx` for
 * every caller — the same "one corrupt row denies the listing" defect ADR-0282
 * removes, reached through the numeric branch it left open (`tenantMembers`
 * carries no MongoDB validator, so an older write, a migration or a manual
 * repair can store such a number; the write path cannot).
 *
 * The pins below fix the contract, not a mechanism:
 *
 *   - **an instant outside the four-digit-year window degrades** exactly like
 *     any other undatable value — the row stays listed and `joinedAt` carries
 *     the epoch sentinel `1970-01-01T00:00:00.000Z`;
 *   - **the window's own edges are still served as themselves** — one
 *     millisecond inside either end round-trips to its ISO string, so a clamp
 *     may not be tighter than the wire format.
 *
 * ## Why the epoch sentinel (ADR-0284, following ADR-0282 §D2)
 *
 * The sentinel decision is ADR-0282 §D2's and does not change here: contract
 * §2.2 and `member-schema` require a non-nullable `isoDateTimeSchema` string, a
 * `null` would fail `serializeResponse` (still a `5xx`) and break the listing's
 * `localeCompare` sort, and the epoch is a real, totally ordered instant that
 * cannot be mistaken for a join time. What ADR-0284 adds is the *bound*: "names
 * an instant" means "names an instant the wire can carry", so the projection's
 * accept-set is the closed interval `-62167219200000 … 253402300799999` and
 * everything outside it is undatable for this purpose.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/members` must keep exporting
 * `projectMember(membership, user, profile): Member`, and whatever the stored
 * `joinedAt` — including any finite number — the call must return a §2.2 member
 * whose `joinedAt` is an `isoDateTimeSchema`-valid string: the exact instant
 * when the value names one inside `-62167219200000 … 253402300799999`, the
 * epoch sentinel otherwise. How the bound is enforced (a range check in the
 * reader, a clamp on the millis, a guard around `toISOString()`) is not pinned.
 */
describe("projectMember — a `joinedAt` instant outside the four-digit-year range", () => {
  /** One millisecond past `9999-12-31T23:59:59.999Z` — the first expanded year. */
  const FIRST_EXPANDED_YEAR_MILLIS = 253402300800000;

  /** The last instant the four-digit-year form can carry. */
  const LAST_FOUR_DIGIT_YEAR_MILLIS = 253402300799999;
  const LAST_FOUR_DIGIT_YEAR_ISO = "9999-12-31T23:59:59.999Z";

  /** The first instant of year 0000, the lower edge of the wire's window. */
  const FIRST_YEAR_ZERO_MILLIS = -62167219200000;
  const FIRST_YEAR_ZERO_ISO = "0000-01-01T00:00:00.000Z";

  /** One millisecond below that edge — the first expanded year on the low side. */
  const LAST_EXPANDED_YEAR_MINUS_ONE_MILLIS = -62167219200001;

  it.each([
    ["the first instant past the four-digit-year ceiling", FIRST_EXPANDED_YEAR_MILLIS],
    ["the Date maximum", 8.64e15],
    ["the Date minimum", -8.64e15],
    ["one millisecond below the year-0000 floor", LAST_EXPANDED_YEAR_MINUS_ONE_MILLIS],
  ])("degrades %s to the epoch sentinel", (_label, joinedAt) => {
    // The defect is silent: no throw, an expanded-year string that the §2.2
    // schema rejects, and only then a 5xx at the route.
    const projected = projectMember(membership({ joinedAt }), undefined, undefined);

    expect(projected.joinedAt).toBe(EPOCH_ISO);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });

  it.each([
    [
      "the last instant the four-digit-year form carries",
      LAST_FOUR_DIGIT_YEAR_MILLIS,
      LAST_FOUR_DIGIT_YEAR_ISO,
    ],
    ["the year-0000 floor", FIRST_YEAR_ZERO_MILLIS, FIRST_YEAR_ZERO_ISO],
  ])("still serves %s as its own instant", (_label, joinedAt, expected) => {
    // Controls: these are green before the fix and must stay green, so a clamp
    // tighter than the wire format is a regression, not a fix.
    const projected = projectMember(membership({ joinedAt }), undefined, undefined);

    expect(projected.joinedAt).toBe(expected);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });
});

/**
 * Unit / contract — a **string** `joinedAt` that names an instant outside the
 * RFC 3339 four-digit-year range (OP-101 follow-up on the bounded `joinedAt`
 * reader, contract §2.2, ADR-0282, ADR-0284 §D1).
 *
 * ADR-0284 §D1 fixes the contract for **whatever** the stored `joinedAt` is,
 * not for the numeric arm alone. A string is parsed through the same
 * `new Date(value).getTime()` a number is, so a string that names an instant
 * the wire cannot carry reaches the identical failure class:
 *
 * ```
 * new Date("+010000-01-01T00:00:00.000Z").getTime()  -> 253402300800000
 * new Date("+275760-09-13T00:00:00.000Z").getTime()  -> 8640000000000000
 * new Date("-000001-12-31T23:59:59.999Z").getTime()  -> -62167219200001
 * ```
 *
 * `@openpic/contracts` `isoDateTimeSchema` rejects the `toISOString()` shapes
 * those instants produce (`+010000-…`, `+275760-…`, `-000001-…`), so a member
 * projected from one is not a §2.2 member: the route's `serializeResponse`
 * fails the strict parse and the whole listing is a `5xx` for every caller —
 * ADR-0282's "one corrupt row denies the listing", reached through a corrupt
 * *string* on a collection that carries no validator. A bound placed on the
 * numeric arm only leaves this path open, which is why the string arm is
 * pinned in its own right.
 *
 * The pins below fix the contract, not a mechanism:
 *
 *   - **a string naming an instant outside the window is undatable for this
 *     purpose** and degrades exactly like any other undatable value — the row
 *     stays listed and `joinedAt` carries the epoch sentinel
 *     `1970-01-01T00:00:00.000Z`;
 *   - **the window's own edges are still served as themselves** — a string
 *     naming the last or the first instant the four-digit-year form carries
 *     round-trips unchanged, so a bound may not be tighter than the wire format.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/members` must keep exporting
 * `projectMember(membership, user, profile): Member`, and whatever the stored
 * `joinedAt` — including any string — the call must return a §2.2 member whose
 * `joinedAt` is an `isoDateTimeSchema`-valid string: the exact instant when the
 * value names one inside `-62167219200000 … 253402300799999`, the epoch
 * sentinel otherwise. How the reading is factored (an inline guard, a local
 * helper, or a shared reader) is not pinned.
 */
describe("projectMember — a `joinedAt` string naming an instant outside the four-digit-year range", () => {
  /** The last instant the four-digit-year form can carry, as a stored string. */
  const LAST_FOUR_DIGIT_YEAR_ISO = "9999-12-31T23:59:59.999Z";

  /** The first instant of year 0000, the lower edge of the wire's window. */
  const FIRST_YEAR_ZERO_ISO = "0000-01-01T00:00:00.000Z";

  it.each([
    ["the first instant past the four-digit-year ceiling", "+010000-01-01T00:00:00.000Z"],
    ["the Date maximum", "+275760-09-13T00:00:00.000Z"],
    ["the Date minimum", "-271821-04-20T00:00:00.000Z"],
    ["one millisecond below the year-0000 floor", "-000001-12-31T23:59:59.999Z"],
  ])("degrades a string naming %s to the epoch sentinel", (_label, joinedAt) => {
    // Silent like the numeric arm: a schema-invalid string leaves the
    // projector, and only the route's strict parse turns it into a 5xx.
    const projected = projectMember(membership({ joinedAt }), undefined, undefined);

    expect(projected.joinedAt).toBe(EPOCH_ISO);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });

  it.each([
    ["the last instant the four-digit-year form carries", LAST_FOUR_DIGIT_YEAR_ISO],
    ["the year-0000 floor", FIRST_YEAR_ZERO_ISO],
  ])("still serves a string naming %s as its own instant", (_label, joinedAt) => {
    // Controls: a bound tighter than the wire format is a regression, not a fix.
    const projected = projectMember(membership({ joinedAt }), undefined, undefined);

    expect(projected.joinedAt).toBe(joinedAt);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });
});

/**
 * Unit / contract — a stored **`Date`** `joinedAt` whose instant lies outside the
 * RFC 3339 four-digit-year range (OP-101 follow-up on the bounded `joinedAt`
 * reader, contract §2.2, ADR-0282, ADR-0284 §D1, ADR-0285).
 *
 * ADR-0284 §D1 fixes the contract for **whatever** the stored `joinedAt` is, and
 * the reader behind it accepts three kinds — a `Date`, a string and a number.
 * The two blocks above pin the string and the numeric arm; the "Date maximum"
 * and "Date minimum" rows in them are the *numbers* `8.64e15` and `-8.64e15`,
 * never a `Date` instance, so the third arm is unpinned. It reaches the identical
 * failure class: a `Date` outside the window is read as its own `getTime()`, and
 * `Date.prototype.toISOString()` leaves the four-digit-year form there:
 *
 * ```
 * new Date(253402300800000).toISOString()  -> "+010000-01-01T00:00:00.000Z"
 * new Date(8.64e15).toISOString()          -> "+275760-09-13T00:00:00.000Z"
 * new Date(-8.64e15).toISOString()         -> "-271821-04-20T00:00:00.000Z"
 * new Date(-62167219200001).toISOString()  -> "-000001-12-31T23:59:59.999Z"
 * ```
 *
 * `@openpic/contracts` `isoDateTimeSchema` rejects all four, so the projected
 * member is not a §2.2 member: the route's `serializeResponse` fails the strict
 * parse and the whole listing is a `5xx` for every caller — ADR-0282's "one
 * corrupt row denies the listing", reached through a stored `Date` on a
 * collection that carries no validator (BSON stores a `Date` as int64
 * milliseconds, so `new Date(8.64e15)` is storable).
 *
 * The pins below fix the contract, not a mechanism:
 *
 *   - **a `Date` whose instant lies outside the window is undatable for this
 *     purpose** and degrades exactly like any other undatable value — the row
 *     stays listed and `joinedAt` carries the epoch sentinel
 *     `1970-01-01T00:00:00.000Z`;
 *   - **the window's own edges are still served as themselves** — a `Date` one
 *     millisecond inside either end round-trips to its ISO string, so a clamp
 *     may not be tighter than the wire format.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/tenancy/members` must keep exporting
 * `projectMember(membership, user, profile): Member`, and whatever the stored
 * `joinedAt` — including any `Date` — the call must return a §2.2 member whose
 * `joinedAt` is an `isoDateTimeSchema`-valid string: the exact instant when the
 * value names one inside `-62167219200000 … 253402300799999`, the epoch
 * sentinel otherwise. Whether the `Date` arm is bounded before or after the
 * read, or by the same check as the string and numeric arms, is not pinned.
 */
describe("projectMember — a `joinedAt` Date instance outside the four-digit-year range", () => {
  /** The last instant the four-digit-year form can carry. */
  const LAST_FOUR_DIGIT_YEAR_MILLIS = 253402300799999;
  const LAST_FOUR_DIGIT_YEAR_ISO = "9999-12-31T23:59:59.999Z";

  /** The first instant of year 0000, the lower edge of the wire's window. */
  const FIRST_YEAR_ZERO_MILLIS = -62167219200000;
  const FIRST_YEAR_ZERO_ISO = "0000-01-01T00:00:00.000Z";

  it.each([
    ["the first instant past the four-digit-year ceiling", 253402300800000],
    ["the Date maximum", 8.64e15],
    ["the Date minimum", -8.64e15],
    ["one millisecond below the year-0000 floor", -62167219200001],
  ])("degrades a `Date` at %s to the epoch sentinel", (_label, millis) => {
    // The defect is silent, exactly as on the other two arms: no throw, an
    // expanded-year string that the §2.2 schema rejects, and only then a 5xx.
    const projected = projectMember(
      membership({ joinedAt: new Date(millis) }),
      undefined,
      undefined
    );

    expect(projected.joinedAt).toBe(EPOCH_ISO);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });

  it.each([
    [
      "the last instant the four-digit-year form carries",
      LAST_FOUR_DIGIT_YEAR_MILLIS,
      LAST_FOUR_DIGIT_YEAR_ISO,
    ],
    ["the year-0000 floor", FIRST_YEAR_ZERO_MILLIS, FIRST_YEAR_ZERO_ISO],
  ])("still serves a `Date` at %s as its own instant", (_label, millis, expected) => {
    // Controls: a bound tighter than the wire format is a regression, not a fix.
    const projected = projectMember(
      membership({ joinedAt: new Date(millis) }),
      undefined,
      undefined
    );

    expect(projected.joinedAt).toBe(expected);
    expect(isoDateTimeSchema.safeParse(projected.joinedAt).success).toBe(true);
  });
});
