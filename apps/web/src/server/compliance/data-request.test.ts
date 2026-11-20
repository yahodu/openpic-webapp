import { describe, expect, it } from "vitest";

import { isAppError } from "@/server/http/errors";

import {
  DSR_REGULATIONS,
  DSR_REQUEST_TYPES,
  computeSlaDueAt,
  resolveAttendeeScope,
  resolveRegulation,
} from "./data-request";

/**
 * Unit — the data-subject-request rules (OP-138 U1–U3, contract §8.1/§8.2,
 * schema §20.3; ADR-0897).
 *
 * `POST /api/v1/me/data-requests` has to answer three questions before it may
 * write a row, and none of them needs a database, a clock or a request:
 *
 *   - **which regulation applies** (`regulation` is optional in the body and
 *     defaults from the tenant's `dataRegion`, then the caller's country);
 *   - **when the request falls due** (`slaDueAt` comes from the runtime
 *     setting `platformSettings.compliance.slaDays`, never a hard-coded
 *     constant — CONVENTIONS §6);
 *   - **what an anonymous attendee may even ask about** (their session's own
 *     `eventIds`, never another event).
 *
 * ## Contract expected of the implementation
 *
 * `@/server/compliance/data-request` exports:
 *
 * ```ts
 * export const DSR_REGULATIONS: readonly ["gdpr", "dpdpa"];
 * export type DsrRegulation = "gdpr" | "dpdpa";
 * export const DSR_REQUEST_TYPES: readonly [
 *   "access", "erasure", "rectification", "portability", "consent_withdrawal",
 *   "correction", "restriction", "objection", "nomination", "grievance",
 * ];
 * export type DsrRequestType = (typeof DSR_REQUEST_TYPES)[number];
 *
 * resolveRegulation(input: {
 *   requested?: DsrRegulation;
 *   tenantDataRegion?: "in" | "eu" | null;
 *   callerCountry?: string | null;   // ISO 3166-1 alpha-2, any case
 * }): DsrRegulation;
 *
 * computeSlaDueAt(
 *   now: Date,
 *   regulation: DsrRegulation,
 *   settings: { compliance: { slaDays: Record<DsrRegulation, number> } },
 * ): Date;
 *
 * resolveAttendeeScope(
 *   requested: readonly string[] | undefined,
 *   sessionEventIds: readonly string[],
 * ): readonly string[];
 * ```
 *
 * ## Assumptions (ADR-0897 §Assumptions)
 *
 * - **Precedence is body → tenant → geo → platform default.** An explicit
 *   `regulation` always wins; then the tenant's `dataRegion` (`eu` → `gdpr`,
 *   `in` → `dpdpa`); then the caller's country (an EU member state → `gdpr`,
 *   `IN` → `dpdpa`); otherwise the platform default `dpdpa`, because the
 *   platform's own default data region is `in` (`tenancy/projection.ts`) and a
 *   caller the platform cannot attribute is served the home jurisdiction's law.
 * - **`slaDays` is milliseconds-exact.** The due instant is `now + slaDays`
 *   calendar days added as 24-hour days in UTC, never rounded to midnight:
 *   §8.1 fixes the *acknowledgement sentence* ("by 25 October 2026"), which the
 *   route renders from this instant, and a rounding rule would make the stored
 *   deadline disagree with the promise for any request filed after 00:00 UTC.
 * - **The attendee scope is the session's `eventIds`.** A session bound to one
 *   event may request that event and no other: an attendee asking about an
 *   event the session never touched is a `422 invalid_scope` naming the
 *   offending ids. An **omitted** scope means the session's events (an
 *   anonymous session has no data anywhere else); an **empty** `eventIds` array
 *   is a request about nothing and is refused the same way.
 */

/** Milliseconds in one calendar day, used only to state expected instants. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The reference instant every case derives from. */
const NOW = new Date("2026-09-25T00:00:00.000Z");

/** The settings slice the due-date arithmetic reads (`compliance.slaDays`). */
interface SlaSettings {
  readonly compliance: { readonly slaDays: Readonly<Record<"gdpr" | "dpdpa", number>> };
}

/** Settings whose per-regulation windows deliberately differ. */
const SLA_SETTINGS: SlaSettings = { compliance: { slaDays: { gdpr: 30, dpdpa: 90 } } };

/** Await a thunk that must throw an `AppError`, and return it. */
function refusalOf(thunk: () => unknown): { code: string; status: number; details?: unknown } {
  let caught: unknown;
  try {
    thunk();
  } catch (error) {
    caught = error;
  }
  if (!isAppError(caught)) {
    throw new Error(`expected an AppError, received ${String(caught)}`);
  }
  return {
    code: caught.code,
    status: caught.status,
    ...(caught.details === undefined ? {} : { details: caught.details }),
  };
}

describe("U1 — the regulation default resolution ladder (§8.1)", () => {
  it("U1: an explicit request regulation wins over the tenant's own region", () => {
    expect(resolveRegulation({ requested: "gdpr", tenantDataRegion: "in" })).toBe("gdpr");
    expect(resolveRegulation({ requested: "dpdpa", tenantDataRegion: "eu" })).toBe("dpdpa");
  });

  it("U1: an EU tenant resolves to gdpr when the body names no regulation", () => {
    expect(resolveRegulation({ tenantDataRegion: "eu" })).toBe("gdpr");
  });

  it("U1: an India tenant resolves to dpdpa when the body names no regulation", () => {
    expect(resolveRegulation({ tenantDataRegion: "in" })).toBe("dpdpa");
  });

  it("U1: a caller in an EU member state resolves to gdpr when no tenant speaks", () => {
    expect(resolveRegulation({ tenantDataRegion: null, callerCountry: "DE" })).toBe("gdpr");
    expect(resolveRegulation({ callerCountry: "fr" })).toBe("gdpr");
  });

  it("U1: a caller in India resolves to dpdpa when no tenant speaks", () => {
    expect(resolveRegulation({ callerCountry: "IN" })).toBe("dpdpa");
  });

  it("U1: the tenant outranks the caller's country", () => {
    // A German traveller filing against an Indian tenant is served DPDPA: the
    // tenant's obligations are the platform's, the caller's location is a hint.
    expect(resolveRegulation({ tenantDataRegion: "in", callerCountry: "DE" })).toBe("dpdpa");
  });

  it("U1: an unattributable caller falls back to the platform default dpdpa", () => {
    expect(resolveRegulation({ callerCountry: "US" })).toBe("dpdpa");
    expect(resolveRegulation({})).toBe("dpdpa");
  });

  it("U1: the regulation enumeration is exactly the two the contract names", () => {
    expect([...DSR_REGULATIONS]).toEqual(["gdpr", "dpdpa"]);
  });
});

describe("U2 — the SLA due date comes from settings, per regulation (§8.1)", () => {
  it("U2: a gdpr request falls due after the gdpr window", () => {
    expect(computeSlaDueAt(NOW, "gdpr", SLA_SETTINGS).toISOString()).toBe(
      new Date(NOW.getTime() + 30 * DAY_MS).toISOString()
    );
  });

  it("U2: a dpdpa request falls due after the dpdpa window", () => {
    expect(computeSlaDueAt(NOW, "dpdpa", SLA_SETTINGS).toISOString()).toBe(
      new Date(NOW.getTime() + 90 * DAY_MS).toISOString()
    );
  });

  it("U2: the same regulation honours any configured window, not a constant", () => {
    const settings: SlaSettings = { compliance: { slaDays: { gdpr: 45, dpdpa: 60 } } };
    expect(computeSlaDueAt(NOW, "gdpr", settings).toISOString()).toBe(
      new Date(NOW.getTime() + 45 * DAY_MS).toISOString()
    );
    expect(computeSlaDueAt(NOW, "dpdpa", settings).toISOString()).toBe(
      new Date(NOW.getTime() + 60 * DAY_MS).toISOString()
    );
  });

  it("U2: returns a new Date and never mutates now", () => {
    const now = new Date(NOW.getTime());
    const before = now.getTime();
    const due = computeSlaDueAt(now, "dpdpa", SLA_SETTINGS);
    expect(due).not.toBe(now);
    expect(now.getTime()).toBe(before);
    expect(due.getTime() - now.getTime()).toBe(90 * DAY_MS);
  });
});

describe("U3 — an anonymous session may only scope its own events (§8.1)", () => {
  /** The single event one attendee session is bound to. */
  const SESSION = ["6702ff00000000000000aaa1"];

  it("U3: an omitted scope resolves to the session's events", () => {
    expect(resolveAttendeeScope(undefined, SESSION)).toEqual(SESSION);
  });

  it("U3: a scope inside the session is preserved in request order", () => {
    const session = ["ev-a", "ev-b"];
    expect(resolveAttendeeScope(["ev-b", "ev-a"], session)).toEqual(["ev-b", "ev-a"]);
  });

  it("U3: repeated event ids collapse to one", () => {
    const session = ["ev-a", "ev-b"];
    expect(resolveAttendeeScope(["ev-b", "ev-a", "ev-b"], session)).toEqual(["ev-b", "ev-a"]);
  });

  it("U3: an event outside the session is a 422 naming the offending ids", () => {
    const refusal = refusalOf(() => resolveAttendeeScope(["ev-a", "ev-z"], ["ev-a", "ev-b"]));
    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe("invalid_scope");
    expect(refusal.details).toEqual({ eventIds: ["ev-z"] });
  });

  it("U3: an empty scope array is a request about nothing and is refused", () => {
    const refusal = refusalOf(() => resolveAttendeeScope([], SESSION));
    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe("invalid_scope");
  });

  it("U3: a session bound to no event may scope nothing but may omit the scope", () => {
    expect(resolveAttendeeScope(undefined, [])).toEqual([]);
    expect(refusalOf(() => resolveAttendeeScope(["ev-a"], [])).code).toBe("invalid_scope");
  });
});

describe("U0 — the request-type enumeration covers the contract and both laws", () => {
  it("U0: the ten documented request types are registered in one list", () => {
    expect([...DSR_REQUEST_TYPES]).toEqual([
      "access",
      "erasure",
      "rectification",
      "portability",
      "consent_withdrawal",
      "correction",
      "restriction",
      "objection",
      "nomination",
      "grievance",
    ]);
  });
});
