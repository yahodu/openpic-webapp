import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as consentAcknowledgeRouteModule from "@/app/api/v1/me/consents/acknowledge/route";
import { buildConsentEvidence } from "@/server/attendee/consent-evidence";
import { currentPolicies, type PolicyPurpose } from "@/server/compliance/policies";
import { acknowledgeConsent } from "@/server/compliance/consents";
import { getRateLimitConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import {
  getPlatformSettings,
  invalidatePlatformSettings,
} from "@/server/settings/platform-settings";

import { makePlatformSettingsDocument } from "../factories/domain-event";
import { APP_ORIGIN, startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the `acknowledgeConsent` domain service (OP-138
 * lane, contract §8.2, schema §15.4; ADR-0910).
 *
 * **Why this exists.** `POST /api/v1/me/consents/acknowledge` owns its write
 * today: the route resolves the served document, refuses a retired version,
 * derives the §15.4 evidence from the request headers and inserts the
 * `consents` row. OP-140's `policy × acknowledge` notification action needs that
 * same write as a callable unit, so the write moves behind
 * `acknowledgeConsent` and the route becomes a thin delegate — **without**
 * changing one byte of what the route answers.
 *
 * ## Contract expected of the implementation
 *
 * - Module `apps/web/src/server/compliance/consents.ts` exporting
 *   `acknowledgeConsent(input): Promise<ConsentAcknowledgement>` where
 *   `input` is `{db, userId, purpose, policyVersion, now, evidence}`:
 *   `db` a `mongodb` `Db`; `userId` the principal's 24-hex id (the string
 *   `ctx.principal` carries); `purpose` a `PolicyPurpose`; `policyVersion` the
 *   version the caller acknowledges; `now` the instant the grant is recorded
 *   at; `evidence` the raw request facts `{salt, ip, userAgent,
 *   acceptLanguage}` (the same four `ConsentEvidenceInput` carries, without
 *   `method` — the in-app surface fixes that).
 * - It answers `{id, purpose, policyVersion, policyDocumentHash, grantedAt,
 *   withdrawnAt}` key-for-key as the route's `201` body, with `id` and
 *   `grantedAt` in their wire forms (24-hex string, ISO string) and
 *   `grantedAt === now.toISOString()`.
 * - It writes exactly one `consents` document, carrying the same keys and the
 *   same values the route's document carries today (`eventId: null`,
 *   `subject: {kind: "user", userId: <ObjectId>}`, `purpose`,
 *   `policyVersion`, `policyDocumentHash`, `policyUrl`, `method:
 *   "in_app_action"`, `evidence`, `grantedAt`, `withdrawnAt: null`,
 *   `createdAt`).
 * - It refuses a `policyVersion` that is not the served document's version for
 *   that `purpose` by throwing the catalogue's `policy_version_stale` (`422`)
 *   with `details: {currentPolicyVersion, policyUrl}`, and writes nothing. A
 *   version that belongs to the *other* purpose is stale for this one.
 * - It refuses a `purpose` the current list does not serve with
 *   `validation_failed` (`422`) and writes nothing.
 * - **It is not idempotent**: a repeat for the same `{userId, policyVersion}`
 *   inserts a second row with a new id. That is today's route behaviour
 *   (characterization pin `I25` of `data-subject-requests.test.ts`), and the
 *   service reproduces it rather than silently changing it.
 *
 * The two `S4`/`S5` refusals are driven at the service because the route cannot
 * reach its refusal twice for one principal; the `R1`/`R2` arms drive the real
 * route and stay green before and after the delegate lands.
 */

/* ───────────────────────────── contract constants ────────────────────────── */

/** The `consents` collection (schema §15.4). */
const CONSENTS = COLLECTIONS.consents;

/** The platform-settings singleton's collection name (schema §20.4). */
const PLATFORM_SETTINGS = "platformSettings";

/** The document purpose the acknowledgement writes (§8.2). */
const TERMS_PURPOSE = "terms_of_service";

/** The second documented purpose, whose version must not satisfy the first. */
const BIOMETRIC_PURPOSE = "biometric_processing";

/** A policy version the platform never served, for the stale-version pin. */
const STALE_POLICY_VERSION = "tos-1999-01";

/** A `policyDocumentHash` as schema §15.4 spells it. */
const DOCUMENT_HASH = /^sha256:[0-9a-f]{64}$/;

/** A stored or answered id in its 24-hex wire form. */
const HEX_ID = /^[0-9a-f]{24}$/;

/** A distinctive terms triple, so a hard-coded document cannot satisfy a pin. */
const SEEDED_TERMS = {
  version: "tos-2031-05",
  url: "https://legal.example.test/terms/tos-2031-05",
  effectiveFrom: "2031-05-01T00:00:00.000Z",
} as const;

/** The instant the pins record an acknowledgement at, never the wall clock. */
const GRANTED_AT = new Date("2026-11-23T09:00:00.000Z");

/** The second instant, for the append-only arm. */
const SECOND_GRANTED_AT = new Date("2026-11-23T09:05:00.000Z");

/** The evidence facts the service is handed (never request headers). */
const EVIDENCE_FACTS = {
  ip: "203.0.113.99",
  userAgent: "OP-140 service probe/1.0",
  acceptLanguage: "fr-FR,fr;q=0.9",
} as const;

/* ───────────────────────────────── harness ───────────────────────────────── */

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op140-consent-service" });
  await ensureIndexes(app.db);
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await app.cleanup();
});

beforeEach(async () => {
  for (const name of [COLLECTIONS.events, COLLECTIONS.users, PLATFORM_SETTINGS, CONSENTS]) {
    await app.db.collection(name).deleteMany({});
  }
  // The read cache is per process, so a dropped singleton must be re-read.
  await app.db
    .collection(PLATFORM_SETTINGS)
    .insertOne(makePlatformSettingsDocument({ compliance: { slaDays: { gdpr: 30, dpdpa: 90 } } }));
  invalidatePlatformSettings();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const acknowledgeRouteHandler = requireRouteHandler();

/** Read the `POST` export off the acknowledge route, failing with its path. */
function requireRouteHandler(): (request: Request) => Promise<Response> {
  const handler: unknown = Reflect.get(consentAcknowledgeRouteModule, "POST");
  if (typeof handler !== "function") {
    throw new Error("expected /api/v1/me/consents/acknowledge to export a POST handler");
  }
  return handler as (request: Request) => Promise<Response>;
}

/** A monotonically-increasing client address, so no two cases share a bucket. */
let ipSeq = 0;

/**
 * A client address no other case has used.
 *
 * @returns A fresh RFC 5737 TEST-NET-3 address.
 */
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${String(ipSeq)}`;
}

/** The hex form of a stored id (`ObjectId` or string). */
function asId(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return String(value);
}

/** Every stored `consents` row. */
async function consentRows(): Promise<Record<string, unknown>[]> {
  const rows = await app.db.collection(CONSENTS).find().toArray();
  return rows;
}

/** The row whose `_id` matches an answered id. */
async function storedConsent(id: string): Promise<Record<string, unknown>> {
  const row = (await app.db
    .collection(CONSENTS)
    .findOne({ _id: new ObjectId(id) })) as unknown as Record<string, unknown> | null;
  if (row === null) {
    throw new Error(`expected a consents row with _id ${id}`);
  }
  return row;
}

/** The current document for one purpose, or a loud failure. */
async function currentPolicy(purpose: PolicyPurpose): Promise<{
  readonly version: string;
  readonly url: string;
  readonly documentHash: string;
}> {
  const settings = await getPlatformSettings({ db: app.db });
  const document = currentPolicies(settings).find((entry) => entry.purpose === purpose);
  if (document === undefined) {
    throw new Error(`currentPolicies served no ${purpose} document`);
  }
  return document;
}

/** Replace the settings singleton with a distinctive terms triple. */
async function seedDistinctiveTerms(): Promise<void> {
  const shipped = await getPlatformSettings({ db: app.db });
  await app.db.collection(PLATFORM_SETTINGS).deleteMany({});
  await app.db.collection(PLATFORM_SETTINGS).insertOne(
    makePlatformSettingsDocument({
      compliance: { slaDays: { gdpr: 30, dpdpa: 90 } },
      legal: {
        ...shipped.legal,
        termsPolicyVersion: SEEDED_TERMS.version,
        termsPolicyUrl: SEEDED_TERMS.url,
        effectiveFrom: SEEDED_TERMS.effectiveFrom,
      },
    })
  );
  invalidatePlatformSettings();
}

/** Build a `POST /me/consents/acknowledge` request for a signed-in caller. */
function acknowledgeRequest(
  cookie: string,
  purpose: PolicyPurpose,
  policyVersion: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(new URL("/api/v1/me/consents/acknowledge", APP_ORIGIN), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      cookie,
      ...headers,
    },
    body: JSON.stringify({ purpose, policyVersion }),
  });
}

/** The JSON body of a `201`, failing loudly on any other status. */
async function createdBody(response: Response, label: string): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status !== 201) {
    throw new Error(`expected 201 from ${label}, received ${String(response.status)}`);
  }
  return parsed;
}

/** The `error` block of a refusal body. */
async function errorBody(
  response: Response
): Promise<{ code: string; details?: Record<string, unknown> }> {
  const parsed = (await response.json()) as Record<string, unknown>;
  const envelope = parsed.error;
  if (envelope === null || typeof envelope !== "object") {
    throw new Error("expected the refusal body to carry an `error` object");
  }
  return envelope as { code: string; details?: Record<string, unknown> };
}

/** The stored-document fields that name the write's identity, not its shape. */
const IDENTITY_FIELDS: ReadonlySet<string> = new Set(["_id", "grantedAt", "createdAt"]);

/**
 * The stored document without its identity fields, so two writes of the same
 * acknowledgement can be compared field-for-field.
 *
 * @param row - A stored `consents` document.
 * @returns The document's non-identity fields.
 */
function shapeOf(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !IDENTITY_FIELDS.has(key)));
}

/** The evidence facts with the deployment salt, as the service is handed them. */
function evidenceFacts(): {
  readonly salt: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly acceptLanguage: string;
} {
  return { salt: getRateLimitConfig().salt, ...EVIDENCE_FACTS };
}

/* ─────────────────────── S1: the receipt the route answers ───────────────── */

describe("S1 — the service answers the route's 201 receipt (§8.2)", () => {
  it("S1: answers the six documented keys, with the ids in their wire forms", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);

    const routeBody = await createdBody(
      await acknowledgeRouteHandler(acknowledgeRequest(user.cookie, TERMS_PURPOSE, terms.version)),
      "POST /me/consents/acknowledge"
    );
    const receipt = await acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: terms.version,
      now: GRANTED_AT,
      evidence: evidenceFacts(),
    });

    // The route becomes a thin delegate, so the two answers must be the same
    // receipt — a key added on one side only is a wire change.
    expect(Object.keys(receipt).sort()).toEqual(Object.keys(routeBody).sort());
    expect({
      purpose: receipt.purpose,
      policyVersion: receipt.policyVersion,
      policyDocumentHash: receipt.policyDocumentHash,
      withdrawnAt: receipt.withdrawnAt,
    }).toEqual({
      purpose: routeBody.purpose,
      policyVersion: routeBody.policyVersion,
      policyDocumentHash: routeBody.policyDocumentHash,
      withdrawnAt: routeBody.withdrawnAt,
    });

    expect(receipt.id).toMatch(HEX_ID);
    expect(receipt.policyDocumentHash).toMatch(DOCUMENT_HASH);
    expect(receipt.policyVersion).toBe(terms.version);
    expect(receipt.withdrawnAt).toBeNull();
    // `now` is the recorded instant; a service that reads the wall clock
    // instead would make the row unverifiable against its own receipt.
    expect(receipt.grantedAt).toBe(GRANTED_AT.toISOString());
    expect((await storedConsent(receipt.id)).grantedAt).toEqual(GRANTED_AT);
  });
});

/* ────────────────────── S2: the document the route writes ────────────────── */

describe("S2 — the service writes the route's consents document (§15.4)", () => {
  it("S2: stores the same keys and values the route's own write stores", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);
    const facts = evidenceFacts();

    const routeBody = await createdBody(
      await acknowledgeRouteHandler(
        acknowledgeRequest(user.cookie, TERMS_PURPOSE, terms.version, {
          "user-agent": facts.userAgent,
          "accept-language": facts.acceptLanguage,
          "x-forwarded-for": facts.ip,
        })
      ),
      "POST /me/consents/acknowledge"
    );
    const receipt = await acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: terms.version,
      now: GRANTED_AT,
      evidence: facts,
    });

    const routeRow = await storedConsent(String(routeBody.id));
    const serviceRow = await storedConsent(receipt.id);

    // Same key set first: a field the service drops (or invents) is a schema
    // change the route would have made silently.
    expect(Object.keys(serviceRow).sort()).toEqual(Object.keys(routeRow).sort());
    expect(shapeOf(serviceRow)).toEqual(shapeOf(routeRow));

    // The two scope facts §15.4 turns into a subject.
    expect(serviceRow.eventId).toBeNull();
    const subject = serviceRow.subject as { readonly kind?: unknown; readonly userId?: unknown };
    expect(subject.kind).toBe("user");
    expect(asId(subject.userId)).toBe(user.userId.toHexString());
    expect(serviceRow.policyUrl).toBe(terms.url);
    expect(serviceRow.withdrawnAt).toBeNull();
    expect(serviceRow.createdAt).toEqual(GRANTED_AT);
  });
});

/* ──────────────────── S3: the evidence the route derives ─────────────────── */

describe("S3 — the service derives the §15.4 evidence it is handed", () => {
  it("S3: stores the salted digests with the in-app method and a served locale", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);
    const facts = evidenceFacts();

    const receipt = await acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: terms.version,
      now: GRANTED_AT,
      evidence: facts,
    });

    const row = await storedConsent(receipt.id);
    const expected = buildConsentEvidence({ ...facts, method: "in_app_action" });

    // §15.4's evidence, derived by the shipped builder — never re-hashed here.
    expect(row.evidence).toEqual(expected);
    expect(row.method).toBe("in_app_action");
    expect((row.evidence as { readonly locale?: unknown }).locale).toBe("en-IN");
    // §0.15: the raw request facts are never stored.
    expect(JSON.stringify(row)).not.toContain(facts.ip);
    expect(JSON.stringify(row)).not.toContain(facts.userAgent);
  });
});

/* ─────────────────────────── S4: the stale refusal ───────────────────────── */

describe("S4 — a version the platform does not serve is refused (§8.2)", () => {
  it("S4: throws policy_version_stale with the current version and URL, and writes nothing", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);

    const refusal = acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: STALE_POLICY_VERSION,
      now: GRANTED_AT,
      evidence: evidenceFacts(),
    });

    await expect(refusal).rejects.toMatchObject({
      code: "policy_version_stale",
      status: 422,
      details: { currentPolicyVersion: terms.version, policyUrl: terms.url },
    });
    // The evidence the record exists to provide is worthless if a stale grant
    // is recorded anyway.
    expect(await consentRows()).toHaveLength(0);
  });
});

/* ─────────────── S5: the other purpose's version is stale for this one ───── */

describe("S5 — a version is resolved for its purpose, never globally (§8.2)", () => {
  it("S5: the biometric version used for terms_of_service is refused as stale", async () => {
    await seedDistinctiveTerms();
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);
    const biometric = await currentPolicy(BIOMETRIC_PURPOSE);

    // The control: if the two versions were the same string this case would
    // pass on a service that matched any served version.
    expect(biometric.version).not.toBe(terms.version);

    const refusal = acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: biometric.version,
      now: GRANTED_AT,
      evidence: evidenceFacts(),
    });

    await expect(refusal).rejects.toMatchObject({
      code: "policy_version_stale",
      status: 422,
      details: { currentPolicyVersion: terms.version, policyUrl: terms.url },
    });
    expect(await consentRows()).toHaveLength(0);
  });
});

/* ───────────────────────── S6: the unknown-purpose arm ───────────────────── */

describe("S6 — a purpose the current list does not serve is refused (§8.2)", () => {
  it("S6: throws validation_failed and writes nothing", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);

    // The route's body schema refuses this at the wire; the service keeps the
    // same guard for a caller that is not the route.
    const unknownPurpose = "marketing_emails" as PolicyPurpose;
    const refusal = acknowledgeConsent({
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: unknownPurpose,
      policyVersion: terms.version,
      now: GRANTED_AT,
      evidence: evidenceFacts(),
    });

    await expect(refusal).rejects.toMatchObject({ code: "validation_failed", status: 422 });
    expect(await consentRows()).toHaveLength(0);
  });
});

/* ───────────────── S7: append-only, exactly as the route is ──────────────── */

describe("S7 — a repeat acknowledgement appends history, as the route does (§8.2)", () => {
  it("S7: the second call answers a new id and stores a second row", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);
    const input = {
      db: app.db,
      userId: user.userId.toHexString(),
      purpose: TERMS_PURPOSE,
      policyVersion: terms.version,
      evidence: evidenceFacts(),
    } as const;

    const first = await acknowledgeConsent({ ...input, now: GRANTED_AT });
    const second = await acknowledgeConsent({ ...input, now: SECOND_GRANTED_AT });

    // Consent records are an append-only record of what was acknowledged when.
    // The route answers the same way (characterization pin `I25`); a service
    // that deduplicated would change that behaviour silently.
    expect(second.id).not.toBe(first.id);
    const rows = await consentRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.policyVersion)).toEqual([terms.version, terms.version]);
    expect(rows.map((row) => row.grantedAt)).toEqual([GRANTED_AT, SECOND_GRANTED_AT]);
  });
});

/* ─────────────── R1/R2: the route's wire answer does not move ────────────── */

describe("R1 — the route still answers 201 and writes one row (§8.2)", () => {
  it("R1: a served version answers the six documented keys and one consents row", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);

    const response = await acknowledgeRouteHandler(
      acknowledgeRequest(user.cookie, TERMS_PURPOSE, terms.version)
    );
    const body = await createdBody(response, "POST /me/consents/acknowledge");

    expect(Object.keys(body).sort()).toEqual([
      "grantedAt",
      "id",
      "policyDocumentHash",
      "policyVersion",
      "purpose",
      "withdrawnAt",
    ]);
    expect(body.id).toMatch(HEX_ID);
    expect(body.policyDocumentHash).toBe(terms.documentHash);
    const rows = await consentRows();
    expect(rows).toHaveLength(1);
    expect(asId(rows[0]?._id)).toBe(String(body.id));
  });
});

describe("R2 — the route still refuses a stale version (§8.2)", () => {
  it("R2: a retired version answers 422 policy_version_stale and writes no row", async () => {
    const user = await app.signIn();
    const terms = await currentPolicy(TERMS_PURPOSE);

    const response = await acknowledgeRouteHandler(
      acknowledgeRequest(user.cookie, TERMS_PURPOSE, STALE_POLICY_VERSION)
    );
    const refusal = await errorBody(response);

    expect(response.status).toBe(422);
    expect(refusal.code).toBe("policy_version_stale");
    expect(refusal.details?.currentPolicyVersion).toBe(terms.version);
    expect(refusal.details?.policyUrl).toBe(terms.url);
    expect(await consentRows()).toHaveLength(0);
  });
});
