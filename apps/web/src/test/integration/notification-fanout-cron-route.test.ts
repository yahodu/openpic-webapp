import { createHmac, randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/v1/internal/cron/notification-fanout/route";
import { COLLECTIONS } from "@/server/db/collections";
import { ensureIndexes } from "@/server/db/indexes";
import { closeMongoClient, getDb } from "@/server/db/mongo";
import { cronResultSchema } from "@/server/jobs/cron-job";
import { invalidateNotificationTypeCache } from "@/server/notifications/notification-type-cache";

import { makeEnv, toProcessEnv } from "../factories/env";
import { MONGO_READY_HOOK_TIMEOUT_MS, requireMongoTestUri, waitForMongoReady } from "../helpers/db";

/**
 * Integration / contract — the AUTHENTICATED surface of the notification fan-out
 * cron route (OP-94 §1 follow-up, contract §10.2, ADR-0028, ADR-0095).
 *
 * OP-94 shipped the fan-out consumer (`@/server/notifications/fan-out`) but
 * de-scoped its two triggers (ADR-0090/0092/0093). This route is the scheduled
 * half: `GET`/`POST /api/v1/internal/cron/notification-fanout`, guarded by the
 * internal HMAC stage exactly like `sample/route.ts`, running a
 * `defineCronJob({ name: "notification-fanout", defaultLimit: 500,
 * maxLimit: 2000 })` job that drains up to `?limit=` pending outbox rows and
 * returns the §10.2 `CronResult`.
 *
 * The specs import the route's exported `GET`/`POST` handlers directly and drive
 * them in-process against a real replica set, so every assertion is on the
 * observable HTTP status, the §10.2 body, or the persisted outbox — never on an
 * internal helper. Credentials are read back from the same validated
 * configuration the route reads (`getConfig()`), so a route wired to the wrong
 * secret cannot pass.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * // @/app/api/v1/internal/cron/notification-fanout/route
 * export function GET(request: Request): Promise<Response>;
 * export function POST(request: Request): Promise<Response>;
 * ```
 *
 * - `GET` accepts the `CRON_SECRET` bearer (Vercel Cron, unsigned body); `POST`
 *   accepts the signed HMAC (`X-Signature` / `X-Timestamp`) with the
 *   `INTERNAL_API_SECRET` bearer. Any denial is the catalogue `401` with
 *   `internal_auth_failed` / `invalid_signature` / `stale_signature`, and the
 *   handler must not have touched the outbox.
 * - A successful run returns the §10.2 `CronResult` with `job` =
 *   `"notification-fanout"` and the fan-out summary projected onto it:
 *   `scanned = claimed`, `affected = processed`, `errors = failed`,
 *   `hasMore = claimed === resolvedLimit`. `?limit=` is resolved per request and
 *   clamped to `maxLimit`; an absent/malformed/`<= 0` value falls back to the
 *   500 default.
 *
 * The outbox is seeded with `notifications: "pending"` rows and no catalogue
 * type, so the fan-out consumes each claim with no recipients — the assertion
 * is that the route claims, processes and reports them, not that it delivers
 * (delivery is pinned by `notification-fan-out.test.ts`).
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/internal/cron/notification-fanout";

/** A valid `INTERNAL_API_SECRET` (>= 32 chars) the signed POSTs are built from. */
const INTERNAL_SECRET = "test-internal-api-secret-0000000000000000";
/** A valid `CRON_SECRET` (>= 32 chars) Vercel Cron presents as a bearer. */
const CRON_SECRET = "test-cron-secret-0000000000000000000000";

/** The stored outbox collection (schema §18.3). */
const DOMAIN_EVENTS = COLLECTIONS.domainEvents;

/** The error envelope a pipeline denial is projected onto. */
interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

/**
 * Append a database name to a replica-set URI so this suite's data is isolated
 * from every other integration worker sharing the one `globalSetup` server.
 *
 * @param uri - The published `MONGO_TEST_URI` (no database path).
 * @param dbName - The database name to select.
 * @returns The URI with `dbName` between the authority and the query string.
 */
function withDatabase(uri: string, dbName: string): string {
  const queryIndex = uri.indexOf("?");
  const withoutQuery = queryIndex === -1 ? uri : uri.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : uri.slice(queryIndex);
  return `${withoutQuery.replace(/\/+$/, "")}/${dbName}${query}`;
}

beforeAll(async () => {
  const dbName = `openpic_fanout_cron_${String(process.pid)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  // `setupMongoTestEnv` seeds the environment then waits for an elected primary;
  // the database is unique per run so a sibling suite dropping the default
  // database cannot disturb the outbox these pins read.
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: withDatabase(requireMongoTestUri(), dbName),
        RATE_LIMIT_PROVIDER: "memory",
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        CRON_SECRET,
      })
    )
  );
  await waitForMongoReady();
  await ensureIndexes(getDb());
}, MONGO_READY_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await getDb().dropDatabase();
  await closeMongoClient();
});

beforeEach(async () => {
  invalidateNotificationTypeCache();
  const database = getDb();
  await database.collection(DOMAIN_EVENTS).deleteMany({});
  await database.collection(COLLECTIONS.notifications).deleteMany({});
  await database.collection(COLLECTIONS.dispatches).deleteMany({});
});

/** The epoch-seconds header value for an instant. */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** A `sha256=<hex>` signature header for a raw body. */
function signatureHeader(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** A `GET` to the route with the given bearer, optionally `?limit=`. */
function cronGet(authorization: string, limit?: string): Request {
  const url = new URL(ROUTE, APP_ORIGIN);
  if (limit !== undefined) {
    url.searchParams.set("limit", limit);
  }
  return new Request(url, { method: "GET", headers: { authorization } });
}

/** A `POST` to the route carrying a signed raw body at `signedAt`. */
function signedPost(body: string, secret: string, signedAt: Date): Request {
  return new Request(new URL(ROUTE, APP_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-signature": signatureHeader(secret, body),
      "x-timestamp": timestampHeader(signedAt),
    },
    body,
  });
}

/** Insert a `notifications: "pending"` outbox row and return its id. */
async function insertPendingEvent(tenantId: string): Promise<ObjectId> {
  const now = new Date("2026-03-01T00:00:00.000Z");
  const result = await getDb()
    .collection(DOMAIN_EVENTS)
    .insertOne({
      eventKey: "collab.invite.accepted",
      tenantId,
      actorRef: { kind: "user", id: new ObjectId().toHexString() },
      subjectRef: { kind: "invitation", id: new ObjectId().toHexString() },
      payload: { inviteId: new ObjectId().toHexString() },
      occurredAt: now,
      expireAt: new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000),
      dispatch: { notifications: "pending", analytics: "not_applicable", queue: "not_applicable" },
    });
  return result.insertedId;
}

/** How many outbox rows for one consumer status remain stored. */
async function countByNotifications(status: string): Promise<number> {
  return getDb().collection(DOMAIN_EVENTS).countDocuments({ "dispatch.notifications": status });
}

describe("the authenticated notification-fanout cron route (§10.2)", () => {
  it("I1: GET with the real CRON_SECRET bearer drains the pending outbox into a valid CronResult", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);
    await insertPendingEvent(tenantId);

    const response = await GET(cronGet(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    const result = cronResultSchema.parse(await response.json());
    expect(result.job).toBe("notification-fanout");
    expect(result.scanned).toBe(2);
    expect(result.affected).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(await countByNotifications("done")).toBe(2);
    expect(await countByNotifications("pending")).toBe(0);
  });

  it("I2: GET ?limit=1 honours the per-request batch and reports hasMore", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);
    await insertPendingEvent(tenantId);

    const response = await GET(cronGet(`Bearer ${CRON_SECRET}`, "1"));

    expect(response.status).toBe(200);
    const result = cronResultSchema.parse(await response.json());
    expect(result.scanned).toBe(1);
    expect(result.affected).toBe(1);
    expect(result.hasMore).toBe(true);

    expect(await countByNotifications("done")).toBe(1);
    expect(await countByNotifications("pending")).toBe(1);
  });

  it.each(["", "abc", "0", "-5", "not-a-number"])(
    "I3: GET ?limit=%s falls back to the 500 default and drains the outbox",
    async (limit) => {
      const tenantId = new ObjectId().toHexString();
      await insertPendingEvent(tenantId);
      await insertPendingEvent(tenantId);

      const response = await GET(cronGet(`Bearer ${CRON_SECRET}`, limit));

      expect(response.status).toBe(200);
      const result = cronResultSchema.parse(await response.json());
      expect(result.scanned).toBe(2);
      expect(result.affected).toBe(2);
      expect(result.hasMore).toBe(false);
    }
  );

  it("I4: a signed POST with the internal secret is 200 and a valid CronResult", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const body = JSON.stringify({ source: "manual" });
    const response = await POST(signedPost(body, INTERNAL_SECRET, new Date()));

    expect(response.status).toBe(200);
    const result = cronResultSchema.parse(await response.json());
    expect(result.job).toBe("notification-fanout");
    expect(result.affected).toBe(1);
  });

  it("I5: GET with a wrong bearer is 401 internal_auth_failed and writes nothing", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const response = await GET(cronGet(`Bearer ${INTERNAL_SECRET}`));

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("internal_auth_failed");

    expect(await countByNotifications("pending")).toBe(1);
    expect(await getDb().collection(COLLECTIONS.notifications).countDocuments({})).toBe(0);
    expect(await getDb().collection(COLLECTIONS.dispatches).countDocuments({})).toBe(0);
  });

  it("I6: a GET with no authorization is 401 internal_auth_failed and writes nothing", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const response = await GET(
      new Request(new URL(ROUTE, APP_ORIGIN), { method: "GET", headers: {} })
    );

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("internal_auth_failed");
    expect(await countByNotifications("pending")).toBe(1);
  });

  it("I7: a signed POST with a tampered body is 401 invalid_signature and writes nothing", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const body = JSON.stringify({ source: "manual" });
    const signed = signedPost(body, INTERNAL_SECRET, new Date());
    const tampered = new Request(signed, { body: JSON.stringify({ source: "attacker" }) });

    const response = await POST(tampered);

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("invalid_signature");

    expect(await countByNotifications("pending")).toBe(1);
    expect(await getDb().collection(COLLECTIONS.notifications).countDocuments({})).toBe(0);
  });

  it("I8: a signed POST with a stale timestamp is 401 stale_signature and writes nothing", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    const body = JSON.stringify({ source: "manual" });
    const response = await POST(signedPost(body, INTERNAL_SECRET, staleAt));

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("stale_signature");

    expect(await countByNotifications("pending")).toBe(1);
  });

  it("I9: a CRON_SECRET bearer on POST is 401 internal_auth_failed (the cron exception is GET-only)", async () => {
    const tenantId = new ObjectId().toHexString();
    await insertPendingEvent(tenantId);

    const body = JSON.stringify({ source: "manual" });
    const response = await POST(
      new Request(new URL(ROUTE, APP_ORIGIN), {
        method: "POST",
        headers: {
          authorization: `Bearer ${CRON_SECRET}`,
          "content-type": "application/json",
          "x-signature": signatureHeader(CRON_SECRET, body),
          "x-timestamp": timestampHeader(new Date()),
        },
        body,
      })
    );

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("internal_auth_failed");
    expect(await countByNotifications("pending")).toBe(1);
  });
});
