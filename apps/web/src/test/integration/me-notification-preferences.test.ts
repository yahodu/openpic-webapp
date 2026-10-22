import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GET as getPreferences,
  PATCH as patchPreferences,
} from "@/app/api/v1/me/notification-preferences/route";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";

/**
 * Integration / contract — `GET` and `PATCH /api/v1/me/notification-preferences`
 * (OP-98, contract §7.4; design §19.1, §19.3; ADR-0220).
 *
 * `GET` returns the stored overrides **merged with** the catalogue defaults, so
 * the settings screen is one read: the sparse `global` / `byType` / `byEvent` /
 * `digest` scopes, the quiet-hours window and `resolved[]`, every type grouped by
 * category with a per-channel-group `{ effective, optOutAllowed, source }`.
 *
 * `PATCH` is a **sparse patch**: only the keys present change, an explicit `null`
 * removes an override and reverts it to the next-most-general scope, and the
 * `200` body is the full merged document. A patch that tries to disable a
 * channel the catalogue does not allow opting out of is
 * `422 opt_out_not_allowed` (contract §7.4), an unrecognised `typeKey` is
 * `422 unknown_type_key`, and a malformed quiet-hours clock is
 * `422 validation_failed`.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/me/notification-preferences/route` exports both `GET` and
 * `PATCH`, guarded with the `user` label, reading and upserting the §19.3
 * `notificationPreferences` document (`{ userId }` unique) and merging it
 * through `@/server/notifications/preferences`.
 *
 * ## Assumptions recorded in the handoff
 *
 * - `opt_out_not_allowed` carries `details.{ typeKey, channelGroup, reason }`
 *   exactly as the Appendix A catalogue names it (`reason: "transactional"` for
 *   a transactional type).
 * - `unknown_type_key` carries `details.typeKey`.
 * - A rejected patch **writes nothing** on *every* rejection path, not only the
 *   transactional one: an opt-out of a locked channel, an unrecognised
 *   `typeKey` and a malformed quiet-hours clock each must leave the stored
 *   document byte-identical, with no phantom override.
 * - The surface is scoped by the caller's `userId` **only**: a patch by one
 *   identity must never read or write another identity's document, so user B's
 *   stored row and B's merged read are unchanged after user A patches.
 * - `GET` is a pure read: a caller with no stored document is served the
 *   catalogue defaults **without** the read upserting a row.
 */

const PREFERENCES_PATH = "/api/v1/me/notification-preferences";
const PREFERENCES_COLLECTION = "notificationPreferences";

/** The identifier `event.details.updated` is opt-outable for, and `billing.payment.failed` is not. */
const OPT_OUTABLE_TYPE = "event.details.updated";
const TRANSACTIONAL_TYPE = "billing.payment.failed";

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op98-prefs" });
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** One resolved channel group as the settings screen consumes it (contract §7.4). */
interface ResolvedChannel {
  readonly effective: "on" | "off";
  readonly optOutAllowed: boolean;
  readonly source: string;
}

/** One type in the resolved catalogue. */
interface ResolvedType {
  readonly typeKey: string;
  readonly label: string;
  readonly channels: Record<string, ResolvedChannel>;
  readonly transactional: boolean;
  readonly severity: string;
}

/** One category of resolved types. */
interface ResolvedCategory {
  readonly category: string;
  readonly label: string;
  readonly types: ResolvedType[];
}

/** The full merged document (both the GET and the PATCH `200` body). */
interface PreferencesBody {
  readonly global: Record<string, string>;
  readonly quietHours: Record<string, unknown>;
  readonly digest: Record<string, string>;
  readonly locale: string;
  readonly byType: Record<string, Record<string, string>>;
  readonly byEvent: Record<string, Record<string, string>>;
  readonly resolved: ResolvedCategory[];
  readonly updatedAt: string | null;
}

/** The error envelope (`{ error: { code, details } }`). */
interface ErrorBody {
  readonly error: { readonly code: string; readonly details?: Record<string, unknown> };
}

/** One field-level validation error (contract §0.6). */
interface FieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Read the resolved entry for one `(typeKey, group)`, failing loudly when absent. */
function resolvedChannel(
  body: PreferencesBody,
  typeKey: string,
  group: "in_app" | "email" | "mobile"
): ResolvedChannel {
  for (const category of body.resolved) {
    for (const type of category.types) {
      if (type.typeKey !== typeKey) continue;
      const channel = type.channels[group];
      if (channel === undefined) {
        throw new Error(`no ${group} channel resolved for ${typeKey}`);
      }
      return channel;
    }
  }
  throw new Error(`type ${typeKey} is absent from the resolved catalogue`);
}

/** A GET carrying the session cookie. */
function getRequest(session: SignedInUser): Request {
  return new Request(new URL(PREFERENCES_PATH, APP_ORIGIN), {
    method: "GET",
    headers: { cookie: session.cookie },
  });
}

/** A PATCH carrying the session cookie and a JSON body. */
function patchRequest(session: SignedInUser, payload: unknown): Request {
  return new Request(new URL(PREFERENCES_PATH, APP_ORIGIN), {
    method: "PATCH",
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** A GET / PATCH with no session cookie at all. */
function anonymousRequest(method: "GET" | "PATCH", payload?: unknown): Request {
  return new Request(new URL(PREFERENCES_PATH, APP_ORIGIN), {
    method,
    headers: { "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** Write a deterministic preferences document for `userId`, replacing anything present. */
async function seedPreferences(userId: ObjectId, overrides: Record<string, unknown> = {}) {
  await app.db.collection(PREFERENCES_COLLECTION).updateOne(
    { userId },
    {
      $set: {
        userId,
        global: { in_app: "on", email: "on", mobile: "on" },
        byType: {},
        byEvent: {},
        quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
        digest: {},
        locale: "en-IN",
        updatedAt: new Date(),
        ...overrides,
      },
    },
    { upsert: true }
  );
}

/** Read the stored document back, failing when the row is missing. */
async function storedPreferences(userId: ObjectId): Promise<Record<string, unknown>> {
  const row = await app.db.collection(PREFERENCES_COLLECTION).findOne({ userId });
  if (row === null) {
    throw new Error("expected a stored notificationPreferences row");
  }
  return row;
}

describe("authorization — /api/v1/me/notification-preferences is user-scoped", () => {
  it("returns 401 for GET without a session cookie", async () => {
    const response = await getPreferences(anonymousRequest("GET"));

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("authentication_required");
  });

  it("returns 401 for PATCH without a session cookie", async () => {
    const response = await patchPreferences(
      anonymousRequest("PATCH", { global: { email: "off" } })
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe("authentication_required");
  });
});

describe("GET /api/v1/me/notification-preferences (§7.4 merged read)", () => {
  it("returns the catalogue defaults when the caller has no stored document", async () => {
    const session = await app.signIn(makeIdentity("op98-defaults"));
    await app.db.collection(PREFERENCES_COLLECTION).deleteOne({ userId: session.userId });

    const response = await getPreferences(getRequest(session));

    expect(response.status).toBe(200);
    const body = (await response.json()) as PreferencesBody;

    expect(body.global).toEqual({ in_app: "on", email: "on", mobile: "on" });
    expect(body.byType).toEqual({});
    expect(body.byEvent).toEqual({});
    expect(body.digest).toEqual({});
    expect(typeof body.locale).toBe("string");
    expect(resolvedChannel(body, OPT_OUTABLE_TYPE, "email")).toEqual({
      effective: "on",
      optOutAllowed: true,
      source: "default",
    });
  });

  it("does not create a stored document when the caller has none (read is not an upsert)", async () => {
    const session = await app.signIn(makeIdentity("op98-read-no-create"));
    await app.db.collection(PREFERENCES_COLLECTION).deleteOne({ userId: session.userId });

    const response = await getPreferences(getRequest(session));

    expect(response.status).toBe(200);
    const body = (await response.json()) as PreferencesBody;
    expect(body.byType).toEqual({});

    const count = await app.db
      .collection(PREFERENCES_COLLECTION)
      .countDocuments({ userId: session.userId });
    expect(count).toBe(0);
  });
});

describe("PATCH /api/v1/me/notification-preferences (§7.4 sparse patch)", () => {
  it("I1: applying an email opt-out for an opt-outable type resolves to off with source type", async () => {
    const session = await app.signIn(makeIdentity("op98-i1"));
    await seedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { byType: { [OPT_OUTABLE_TYPE]: { email: "off" } } })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as PreferencesBody;

    expect(body.byType[OPT_OUTABLE_TYPE]).toEqual({ email: "off" });
    expect(resolvedChannel(body, OPT_OUTABLE_TYPE, "email")).toEqual({
      effective: "off",
      optOutAllowed: true,
      source: "type",
    });
  });

  it("I1: the override it accepted is the one a follow-up GET serves", async () => {
    const session = await app.signIn(makeIdentity("op98-i1-persist"));
    await seedPreferences(session.userId);

    await patchPreferences(
      patchRequest(session, { byType: { [OPT_OUTABLE_TYPE]: { email: "off" } } })
    );

    const response = await getPreferences(getRequest(session));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PreferencesBody;

    expect(resolvedChannel(body, OPT_OUTABLE_TYPE, "email")).toEqual({
      effective: "off",
      optOutAllowed: true,
      source: "type",
    });
  });

  it("isolates a patch to the caller: another user's document and read are untouched", async () => {
    const userA = await app.signIn(makeIdentity("op98-isolation-a"));
    const userB = await app.signIn(makeIdentity("op98-isolation-b"));
    await seedPreferences(userA.userId);
    await seedPreferences(userB.userId);

    const beforeB = await storedPreferences(userB.userId);

    const patched = await patchPreferences(
      patchRequest(userA, { byType: { [OPT_OUTABLE_TYPE]: { email: "off" } } })
    );
    expect(patched.status).toBe(200);
    expect(
      resolvedChannel((await patched.json()) as PreferencesBody, OPT_OUTABLE_TYPE, "email")
    ).toEqual({ effective: "off", optOutAllowed: true, source: "type" });

    const readA = await getPreferences(getRequest(userA));
    expect(readA.status).toBe(200);
    expect(
      resolvedChannel((await readA.json()) as PreferencesBody, OPT_OUTABLE_TYPE, "email")
    ).toEqual({ effective: "off", optOutAllowed: true, source: "type" });

    const afterB = await storedPreferences(userB.userId);
    expect(afterB).toEqual(beforeB);
    expect(afterB.global).toEqual(beforeB.global);
    expect(afterB.byType).toEqual(beforeB.byType);

    const readB = await getPreferences(getRequest(userB));
    expect(readB.status).toBe(200);
    const bodyB = (await readB.json()) as PreferencesBody;
    expect(bodyB.byType).toEqual({});
    expect(resolvedChannel(bodyB, OPT_OUTABLE_TYPE, "email")).toEqual({
      effective: "on",
      optOutAllowed: true,
      source: "default",
    });
  });

  it("I2: opting out of a transactional type is rejected with 422 opt_out_not_allowed", async () => {
    const session = await app.signIn(makeIdentity("op98-i2"));
    await seedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { byType: { [TRANSACTIONAL_TYPE]: { email: "off" } } })
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("opt_out_not_allowed");
    expect(body.error.details).toMatchObject({
      typeKey: TRANSACTIONAL_TYPE,
      channelGroup: "email",
      reason: "transactional",
    });
  });

  it("I2: the rejected patch writes no phantom override", async () => {
    const session = await app.signIn(makeIdentity("op98-i2-side-effect"));
    await seedPreferences(session.userId);

    await patchPreferences(
      patchRequest(session, { byType: { [TRANSACTIONAL_TYPE]: { email: "off" } } })
    );

    const stored = await storedPreferences(session.userId);
    expect(stored.byType).toEqual({});
  });

  it("I3: null removes the byType override and reverts the channel to global", async () => {
    const session = await app.signIn(makeIdentity("op98-i3"));
    await seedPreferences(session.userId, {
      global: { in_app: "on", email: "off", mobile: "on" },
      byType: { [OPT_OUTABLE_TYPE]: { email: "off" } },
    });

    const response = await patchPreferences(
      patchRequest(session, { byType: { [OPT_OUTABLE_TYPE]: null } })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as PreferencesBody;

    expect(body.byType[OPT_OUTABLE_TYPE]).toBeUndefined();
    expect(resolvedChannel(body, OPT_OUTABLE_TYPE, "email")).toEqual({
      effective: "off",
      optOutAllowed: true,
      source: "global",
    });
  });

  it("rejects an unrecognised typeKey with 422 unknown_type_key", async () => {
    const session = await app.signIn(makeIdentity("op98-unknown-type"));
    await seedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { byType: { "not.a.real.type": { email: "off" } } })
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("unknown_type_key");
    expect(body.error.details).toMatchObject({ typeKey: "not.a.real.type" });
  });

  it("the unknown_type_key rejection writes no phantom override", async () => {
    const session = await app.signIn(makeIdentity("op98-unknown-type-side-effect"));
    await seedPreferences(session.userId);

    const before = await storedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { byType: { "not.a.real.type": { email: "off" } } })
    );

    expect(response.status).toBe(422);
    const stored = await storedPreferences(session.userId);
    expect(stored).toEqual(before);
    expect(stored.byType).toEqual({});
  });

  it("rejects a quiet-hours clock that is not HH:MM with 422 validation_failed", async () => {
    const session = await app.signIn(makeIdentity("op98-clock"));
    await seedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { quietHours: { start: "24:00" } })
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody & {
      readonly error: { readonly details?: { readonly fields?: FieldError[] } };
    };

    expect(body.error.code).toBe("validation_failed");
    const fields = body.error.details?.fields ?? [];
    expect(fields.some((field) => field.path === "quietHours.start")).toBe(true);
  });

  it("the bad-clock validation_failed rejection leaves the stored quiet hours unchanged", async () => {
    const session = await app.signIn(makeIdentity("op98-clock-side-effect"));
    await seedPreferences(session.userId);

    const before = await storedPreferences(session.userId);

    const response = await patchPreferences(
      patchRequest(session, { quietHours: { start: "24:00" } })
    );

    expect(response.status).toBe(422);
    const stored = await storedPreferences(session.userId);
    expect(stored).toEqual(before);
    expect(stored.quietHours).toEqual(before.quietHours);
  });
});
