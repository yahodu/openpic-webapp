import { describe, expect, it } from "vitest";

import * as publicEvent from "@/server/attendee/public-event";
import type {
  PublicEventFacts,
  PublicEventOutcome,
  PublicEventStatus,
} from "@/server/attendee/public-event";

/**
 * Unit — the public-event state → response mapping table (OP-130 U2, contract
 * §6.1 error table, schema §15.1).
 *
 * **Why this exists.** `GET /api/v1/p/events/{slug}` has exactly five
 * documented terminal states and the attendee page renders a different screen
 * for each one. Splitting the decision out of the route into a pure table is
 * what lets the whole matrix — every status × every link state — be pinned
 * without a database, a clock or an HTTP request. The route then only has to
 * *read* the facts and *project* the outcome.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/attendee/public-event` exports
 * `resolvePublicEventOutcome(facts: PublicEventFacts): PublicEventOutcome`,
 * where
 *
 * ```ts
 * interface PublicEventFacts {
 *   link: "active" | "revoked" | "unknown";   // the link the slug names
 *   status: PublicEventStatus | null;         // the event's status, null when the link is unknown
 *   now: Date;                                // the clock the gallery window is judged against
 *   retentionExpiresAt: Date | null;          // schema §15.1; null means unbounded
 * }
 * ```
 *
 * and the outcome is either a refusal carrying the **HTTP status and catalogue
 * code** the route must answer, or the resolved gallery window:
 *
 * ```ts
 * type PublicEventOutcome =
 *   | { kind: "error"; status: 404 | 410; code: "not_found" | "access_link_revoked" | "event_gone" }
 *   | { kind: "ok"; galleryOpen: boolean; galleryExpiredAt: Date | null };
 * ```
 *
 * The table, in precedence order (contract §6.1 lists the conditions in this
 * order, and each row below is one condition):
 *
 *   1. the slug names no link at all → `404 not_found`;
 *   2. the slug names a **revoked** link → `410 access_link_revoked`, whatever
 *      the event's status is (the link is the addressing surface: the QR the
 *      attendee holds is dead, and the answer carries no event data at all);
 *   3. the event is `draft` → `404 not_found` — an unpublished event must never
 *      be confirmed to exist (contract §6.1 "do not leak unpublished events");
 *   4. the event is `deleting` → `410 event_gone` (its content is going away);
 *   5. otherwise the page renders, with the gallery window resolved from
 *      `retentionExpiresAt`: **open** while `now < retentionExpiresAt`, and
 *      **closed** from `retentionExpiresAt` onward (inclusive, matching the TTL
 *      semantics the rest of the platform uses). An unbounded retention
 *      (`null`) is open forever.
 *
 * `galleryExpiredAt` is `null` while the gallery is open and the retention
 * instant once it has elapsed — the §6.1 `gallery.expiredAt` field.
 *
 * ## Assumptions (ADR-0784 §Assumptions)
 *
 * - `archived` renders. Contract §6.1's error table is a **closed** list of
 *   refusals (unknown, revoked, draft, deleting/purged) and says nothing about
 *   `archived`, so an archived event keeps its gallery until retention elapses.
 * - A row that has been **purged** is indistinguishable from a slug that never
 *   existed (nothing is left to look up), so it resolves through row 1. The
 *   contract's "`deleting` / purged → 410 event_gone" row is therefore only
 *   observable in the `deleting` state; the purged half would need a tombstone
 *   this schema does not have (handoff §Open questions).
 */
interface OutcomeCase {
  readonly name: string;
  readonly facts: PublicEventFacts;
  /** The retention instant every window row shares, for readability. */
  readonly expected: PublicEventOutcome;
}

/** A far-future retention instant, so a window row is unambiguous about "now". */
const RETENTION = new Date("2027-02-14T18:00:00.000Z");

/** The clock every row judges the window against, unless it overrides it. */
const NOW = new Date("2026-12-01T00:00:00.000Z");

/** Build the facts for one row, with the suite's defaults filled in. */
function makeFacts(overrides: Partial<PublicEventFacts>): PublicEventFacts {
  return {
    link: "active",
    status: "published",
    now: NOW,
    retentionExpiresAt: RETENTION,
    ...overrides,
  };
}

/** Every documented status, so the "renders" rows are exhaustive (schema §15.1). */
const RENDERING_STATUSES: readonly PublicEventStatus[] = ["published", "live", "ended", "archived"];

const ERROR_CASES: readonly OutcomeCase[] = [
  {
    name: "answers 404 not_found for a slug that names no link at all",
    facts: makeFacts({ link: "unknown", status: null }),
    expected: { kind: "error", status: 404, code: "not_found" },
  },
  {
    name: "answers 404 not_found for a draft event, so an unpublished event never leaks",
    facts: makeFacts({ link: "active", status: "draft" }),
    expected: { kind: "error", status: 404, code: "not_found" },
  },
  {
    name: "answers 410 access_link_revoked for a rotated-away slug",
    facts: makeFacts({ link: "revoked", status: "published" }),
    expected: { kind: "error", status: 410, code: "access_link_revoked" },
  },
  {
    name: "answers 410 access_link_revoked for a revoked slug of a live event",
    facts: makeFacts({ link: "revoked", status: "live" }),
    expected: { kind: "error", status: 410, code: "access_link_revoked" },
  },
  {
    name: "prefers access_link_revoked over not_found when a revoked slug points at a draft",
    facts: makeFacts({ link: "revoked", status: "draft" }),
    expected: { kind: "error", status: 410, code: "access_link_revoked" },
  },
  {
    name: "answers 410 event_gone for an event whose purge has started",
    facts: makeFacts({ link: "active", status: "deleting" }),
    expected: { kind: "error", status: 410, code: "event_gone" },
  },
  {
    name: "prefers access_link_revoked over event_gone when the slug was rotated first",
    facts: makeFacts({ link: "revoked", status: "deleting" }),
    expected: { kind: "error", status: 410, code: "access_link_revoked" },
  },
];

const RENDERING_CASES: readonly OutcomeCase[] = [
  ...RENDERING_STATUSES.map((status): OutcomeCase => ({
    name: `renders an open gallery for a ${String(status)} event inside its retention window`,
    facts: makeFacts({ status }),
    expected: { kind: "ok", galleryOpen: true, galleryExpiredAt: null },
  })),
  {
    name: "keeps the gallery open one millisecond before the retention instant",
    facts: makeFacts({ now: new Date("2027-02-14T17:59:59.999Z") }),
    expected: { kind: "ok", galleryOpen: true, galleryExpiredAt: null },
  },
  {
    name: "closes the gallery at the retention instant itself (inclusive expiry)",
    facts: makeFacts({ now: RETENTION }),
    expected: {
      kind: "ok",
      galleryOpen: false,
      galleryExpiredAt: RETENTION,
    },
  },
  {
    name: "closes the gallery for a clock well past the retention instant",
    facts: makeFacts({ now: new Date("2027-06-01T00:00:00.000Z") }),
    expected: {
      kind: "ok",
      galleryOpen: false,
      galleryExpiredAt: RETENTION,
    },
  },
  {
    name: "keeps an unbounded-retention gallery open forever",
    facts: makeFacts({ retentionExpiresAt: null, now: new Date("2031-01-01T00:00:00.000Z") }),
    expected: { kind: "ok", galleryOpen: true, galleryExpiredAt: null },
  },
];

/**
 * Read the resolver off the module namespace, failing with a message that names
 * the missing export.
 *
 * @returns The resolver under test.
 */
function requireResolve(): (facts: PublicEventFacts) => PublicEventOutcome {
  const exported = (publicEvent as unknown as { resolvePublicEventOutcome?: unknown })
    .resolvePublicEventOutcome;
  if (typeof exported !== "function") {
    throw new Error(
      "@/server/attendee/public-event must export resolvePublicEventOutcome(facts: PublicEventFacts): PublicEventOutcome"
    );
  }
  return exported as (facts: PublicEventFacts) => PublicEventOutcome;
}

describe("resolvePublicEventOutcome — the refusal rows (contract §6.1)", () => {
  it.each(ERROR_CASES)("$name", ({ facts, expected }) => {
    const resolvePublicEventOutcome = requireResolve();

    // `toEqual` on the whole outcome, so an extra field (a leaked gallery
    // window on a refusal, or a status/code pair that drifts apart) fails.
    expect(resolvePublicEventOutcome(facts)).toEqual(expected);
  });
});

describe("resolvePublicEventOutcome — the gallery-window rows (contract §6.1)", () => {
  it.each(RENDERING_CASES)("$name", ({ facts, expected }) => {
    const resolvePublicEventOutcome = requireResolve();

    expect(resolvePublicEventOutcome(facts)).toEqual(expected);
  });
});

describe("resolvePublicEventOutcome — purity", () => {
  it("reads no clock of its own: the same facts resolve identically twice", () => {
    const resolvePublicEventOutcome = requireResolve();
    const facts = makeFacts({ now: new Date("2027-03-01T00:00:00.000Z") });

    const first = resolvePublicEventOutcome(facts);
    const second = resolvePublicEventOutcome(facts);

    expect(second).toEqual(first);
    // The elapsed row depends on `facts.now` alone. If the resolver read
    // `Date.now()` instead, the suite's fixed instant and the wall clock would
    // have to agree for this to hold — they do not (RETENTION is in the past
    // relative to 2027-03-01 and in the future relative to today).
    expect(first).toEqual({
      kind: "ok",
      galleryOpen: false,
      galleryExpiredAt: RETENTION,
    });
  });

  it("does not mutate the facts it is given", () => {
    const resolvePublicEventOutcome = requireResolve();
    const facts = makeFacts({ link: "revoked" });
    const snapshot = { ...facts };

    resolvePublicEventOutcome(facts);

    expect(facts).toEqual(snapshot);
  });
});
