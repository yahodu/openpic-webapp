import { createHash } from "node:crypto";

import type { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as getPreferences } from "@/app/api/v1/me/notification-preferences/route";
import {
  GET as previewUnsubscribe,
  POST as applyUnsubscribe,
} from "@/app/api/v1/notifications/unsubscribe/[token]/route";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { humaniseKey } from "@/server/notifications/preferences";
import { signUnsubscribeToken, type UnsubscribeScope } from "@/server/notifications/unsubscribe";
import { fixedClock } from "@/server/runtime/clock";

import {
  APP_ORIGIN,
  makeIdentity,
  startTestApp,
  type SignedInUser,
  type TestApp,
} from "../helpers/authed-app";

/**
 * Integration / contract — `GET` and `POST
 * /api/v1/notifications/unsubscribe/{token}` (OP-99, contract §7.5; design
 * §19.6; ADR-0240).
 *
 * The endpoints are **public** (auth `public`): the token is the credential and
 * the only thing it grants is muting the named scope for the token's user. `GET`
 * previews the application and writes nothing; `POST` applies it.
 *
 *   I1 `POST scope: "all"` mutes the `email` group of every opt-outable type,
 *      leaves `billing.payment.failed` on, and says so in `stillReceiving`;
 *   I2 `POST scope: "marketing"` creates a first-party
 *      `notificationSuppressions` row (`reason: "unsubscribe"`,
 *      `scope: "marketing"`) and sets `userProfiles.marketingOptIn = false`;
 *   I3 a repeat `POST` is `200` with the same body and no duplicate side effect.
 *
 * ## Contract expected of the implementation
 *
 * `@/app/api/v1/notifications/unsubscribe/[token]/route` exports `GET` and
 * `POST` on the shared pipeline. The token is the path's `{token}` segment and
 * is verified through `@/server/notifications/unsubscribe` with
 * `getConfig().transport.unsubscribeSigningSecret`.
 *
 * Both verbs answer `{ applied, scope, typeKey?, mutedTypeKeys, stillReceiving,
 * managePreferencesUrl }` where `applied` is `false` on the `GET` preview and
 * `true` on the `POST`, `mutedTypeKeys` / `stillReceiving` are sorted, and
 * `managePreferencesUrl` is `${APP_BASE_URL}/settings/notifications`.
 *
 * ## Assumptions recorded in the handoff
 *
 * - An invalid or missing token is `400 bad_request`; an expired token is
 *   `410 gone`. Neither invents a new Appendix A code.
 * - `scope: "type"` naming a transactional type is `422 opt_out_not_allowed`
 *   (the same code the preferences `PATCH` uses) and naming an unknown type is
 *   `422 unknown_type_key`; both reject **before** any write.
 * - A locked **non-transactional** type is the same `422 opt_out_not_allowed`,
 *   but its `details.reason` is `"not_opt_outable"` (the OP-98 `optOutReason`
 *   precedent), not `"transactional"` — ADR-0240's row is corrected in place.
 * - The suppression's `contactHash` is `sha256:` + the lowercase hex digest of
 *   the user's trimmed, lowercased email address (design §19.6).
 * - `scope: "all"` writes **preferences only** — it creates no suppression,
 *   because a `scope: "all"` suppression is the "never contact" list and must
 *   never be able to block a security or billing message (design §19.6).
 */

const UNSUBSCRIBE_PREFIX = "/api/v1/notifications/unsubscribe";
const PREFERENCES_PATH = "/api/v1/me/notification-preferences";
const PREFERENCES_COLLECTION = "notificationPreferences";
const PROFILES_COLLECTION = "userProfiles";
const SUPPRESSIONS_COLLECTION = "notificationSuppressions";

/** The transactional type the contract names as never muted. */
const TRANSACTIONAL_TYPE = "billing.payment.failed";

let app: TestApp;

/** The signing secret the app under test reads from its environment. */
let secret: string;

beforeAll(async () => {
  app = await startTestApp({ prefix: "op99-unsub" });
  secret = String(process.env.UNSUBSCRIBE_SIGNING_SECRET);
}, 30_000);

afterAll(async () => {
  await app.cleanup();
});

/** The unsubscribe response body (contract §7.5). */
interface UnsubscribeBody {
  readonly applied: boolean;
  readonly scope: UnsubscribeScope;
  readonly typeKey?: string;
  readonly mutedTypeKeys: string[];
  readonly stillReceiving: string[];
  readonly managePreferencesUrl: string;
}

/** The error envelope (`{ error: { code, details } }`). */
interface ErrorBody {
  readonly error: { readonly code: string; readonly details?: Record<string, unknown> };
}

/** Every `typeKey` whose email group can be muted (contract §7.5). */
function optOutableEmailTypeKeys(): string[] {
  return SEED_NOTIFICATION_TYPES.filter((type) => type.enabled && !type.transactional)
    .filter((type) => {
      const email = type.channelGroups.find((group) => group.group === "email");
      return email !== undefined && email.enabled && email.optOutAllowed;
    })
    .map((type) => type.typeKey)
    .sort();
}

/**
 * Every `typeKey` that is enabled and **non-transactional** but whose `email`
 * group is **locked** (`enabled: true, optOutAllowed: false`).
 *
 * ADR-0240's rejection table calls these "otherwise locked": they are reachable
 * (`scope: "type"` tokens naming them are well-formed) yet may not be muted, so
 * they are answered `422 opt_out_not_allowed` — with `reason: "not_opt_outable"`,
 * the OP-98 `optOutReason` precedent, **not** `"transactional"`. A concrete
 * member of the set in the current seed is `account.welcome`.
 */
function lockedNonTransactionalEmailTypeKeys(): string[] {
  return SEED_NOTIFICATION_TYPES.filter((type) => type.enabled && !type.transactional)
    .filter((type) => {
      const email = type.channelGroups.find((group) => group.group === "email");
      return email !== undefined && email.enabled && !email.optOutAllowed;
    })
    .map((type) => type.typeKey)
    .sort();
}

/** The label of the transactional type that keeps receiving mail. */
const TRANSACTIONAL_LABEL = humaniseKey(TRANSACTIONAL_TYPE);

/** `sha256:` + the lowercase hex digest of a trimmed, lowercased contact. */
function contactHash(email: string): string {
  return `sha256:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

/** Mint a token at the current instant, as the transport adapter would. */
function tokenFor(
  session: SignedInUser,
  scope: UnsubscribeScope,
  typeKey?: string,
  now: Date = new Date()
): string {
  return signUnsubscribeToken(
    { userId: session.userId.toHexString(), scope, ...(typeKey === undefined ? {} : { typeKey }) },
    { secret, now: fixedClock(now) }
  );
}

/** A `GET` preview for `token` (public — no cookie). */
function previewRequest(token: string): Request {
  return new Request(new URL(`${UNSUBSCRIBE_PREFIX}/${token}`, APP_ORIGIN), { method: "GET" });
}

/** A `POST` apply for `token` (public — no cookie, as a mail client sends it). */
function applyRequest(token: string): Request {
  return new Request(new URL(`${UNSUBSCRIBE_PREFIX}/${token}`, APP_ORIGIN), { method: "POST" });
}

/** A preferences `GET` carrying the session cookie. */
function preferencesRequest(session: SignedInUser): Request {
  return new Request(new URL(PREFERENCES_PATH, APP_ORIGIN), {
    method: "GET",
    headers: { cookie: session.cookie },
  });
}

/** Read the stored preferences row, or `null` when absent. */
async function storedPreferences(userId: ObjectId): Promise<Record<string, unknown> | null> {
  return app.db.collection(PREFERENCES_COLLECTION).findOne({ userId });
}

/** Read the stored profile row, or `null` when absent. */
async function storedProfile(userId: ObjectId): Promise<Record<string, unknown> | null> {
  return app.db.collection(PROFILES_COLLECTION).findOne({ userId });
}

/** Every suppression row for one contact hash. */
async function suppressionsFor(hash: string): Promise<Record<string, unknown>[]> {
  return app.db.collection(SUPPRESSIONS_COLLECTION).find({ contactHash: hash }).toArray();
}

/** The email entry of one resolved type in the OP-98 merged document. */
function resolvedEmail(
  body: {
    readonly resolved: {
      readonly types: {
        readonly typeKey: string;
        readonly channels: Record<string, { effective: string; source: string }>;
      }[];
    }[];
  },
  typeKey: string
): { effective: string; source: string } {
  for (const category of body.resolved) {
    for (const type of category.types) {
      if (type.typeKey !== typeKey) continue;
      const email = type.channels.email;
      if (email === undefined) {
        throw new Error(`no email channel resolved for ${typeKey}`);
      }
      return email;
    }
  }
  throw new Error(`type ${typeKey} is absent from the resolved catalogue`);
}

describe("token handling — the unsubscribe token is the credential", () => {
  it("rejects a tampered token with 400 bad_request on the preview", async () => {
    const session = await app.signIn(makeIdentity("op99-tamper"));
    const token = tokenFor(session, "all");
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const response = await previewUnsubscribe(previewRequest(tampered));

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe("bad_request");
  });

  it("rejects an expired token with 410 gone on the apply", async () => {
    const session = await app.signIn(makeIdentity("op99-expired"));
    const elevenWeeksAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const token = tokenFor(session, "all", undefined, elevenWeeksAgo);

    const response = await applyUnsubscribe(applyRequest(token));

    expect(response.status).toBe(410);
    expect(((await response.json()) as ErrorBody).error.code).toBe("gone");
  });

  it("does not write anything for a preview of a tampered token", async () => {
    const session = await app.signIn(makeIdentity("op99-tamper-nowrite"));
    const token = tokenFor(session, "all");
    const before = await storedPreferences(session.userId);

    await previewUnsubscribe(previewRequest(`${token.slice(0, -1)}x`));

    expect(await storedPreferences(session.userId)).toEqual(before);
    expect(await suppressionsFor(contactHash(session.identity.email))).toEqual([]);
  });
});

describe("GET preview — what would be muted, without writing", () => {
  it("previews scope all with applied false and every opt-outable type muted", async () => {
    const session = await app.signIn(makeIdentity("op99-preview-all"));

    const response = await previewUnsubscribe(previewRequest(tokenFor(session, "all")));

    expect(response.status).toBe(200);
    const body = (await response.json()) as UnsubscribeBody;

    expect(body.applied).toBe(false);
    expect(body.scope).toBe("all");
    expect(body.mutedTypeKeys).toEqual(optOutableEmailTypeKeys());
    expect(body.stillReceiving).toContain(TRANSACTIONAL_LABEL);
    expect(body.managePreferencesUrl).toBe(`${APP_ORIGIN}/settings/notifications`);
  });

  it("writes no preferences and no suppression for a preview", async () => {
    const session = await app.signIn(makeIdentity("op99-preview-nowrite"));
    const before = await storedPreferences(session.userId);

    await previewUnsubscribe(previewRequest(tokenFor(session, "all")));

    expect(await storedPreferences(session.userId)).toEqual(before);
    expect(await suppressionsFor(contactHash(session.identity.email))).toEqual([]);
  });

  it("previews a type scope with only that type muted", async () => {
    const session = await app.signIn(makeIdentity("op99-preview-type"));
    const typeKey = optOutableEmailTypeKeys()[0] ?? "";

    const response = await previewUnsubscribe(previewRequest(tokenFor(session, "type", typeKey)));

    expect(response.status).toBe(200);
    const body = (await response.json()) as UnsubscribeBody;

    expect(body.applied).toBe(false);
    expect(body.scope).toBe("type");
    expect(body.typeKey).toBe(typeKey);
    expect(body.mutedTypeKeys).toEqual([typeKey]);
  });
});

describe("POST apply (§7.5)", () => {
  it("I1: scope all mutes every opt-outable email type and leaves billing.payment.failed on", async () => {
    const session = await app.signIn(makeIdentity("op99-i1"));
    const expected = optOutableEmailTypeKeys();

    const response = await applyUnsubscribe(applyRequest(tokenFor(session, "all")));

    expect(response.status).toBe(200);
    const body = (await response.json()) as UnsubscribeBody;

    expect(body.applied).toBe(true);
    expect(body.scope).toBe("all");
    expect(body.mutedTypeKeys).toEqual(expected);
    expect(body.mutedTypeKeys).not.toContain(TRANSACTIONAL_TYPE);
    expect(body.stillReceiving).toContain(TRANSACTIONAL_LABEL);

    const stored = await storedPreferences(session.userId);
    const byType = (stored?.byType ?? {}) as Record<string, Record<string, string>>;

    expect(Object.keys(byType).sort()).toEqual(expected);
    expect(byType[TRANSACTIONAL_TYPE]).toBeUndefined();
    for (const typeKey of expected) {
      expect(byType[typeKey]).toEqual({ email: "off" });
    }
  });

  it("I1: the applied mute is what the settings screen resolves as source type", async () => {
    const session = await app.signIn(makeIdentity("op99-i1-read"));
    const typeKey = optOutableEmailTypeKeys()[0] ?? "";

    await applyUnsubscribe(applyRequest(tokenFor(session, "all")));

    const response = await getPreferences(preferencesRequest(session));
    expect(response.status).toBe(200);

    const body = (await response.json()) as Parameters<typeof resolvedEmail>[0];
    expect(resolvedEmail(body, typeKey)).toEqual({ effective: "off", source: "type" });
  });

  it("I2: scope marketing creates the suppression and clears marketingOptIn", async () => {
    const session = await app.signIn(makeIdentity("op99-i2"));
    await app.db
      .collection(PROFILES_COLLECTION)
      .updateOne({ userId: session.userId }, { $set: { marketingOptIn: true } });

    const response = await applyUnsubscribe(applyRequest(tokenFor(session, "marketing")));

    expect(response.status).toBe(200);
    const body = (await response.json()) as UnsubscribeBody;

    expect(body.applied).toBe(true);
    expect(body.scope).toBe("marketing");
    expect(body.mutedTypeKeys).toEqual([]);
    expect(body.stillReceiving).toContain(TRANSACTIONAL_LABEL);

    const rows = await suppressionsFor(contactHash(session.identity.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "email",
      contactHash: contactHash(session.identity.email),
      reason: "unsubscribe",
      scope: "marketing",
      expiresAt: null,
    });

    const profile = await storedProfile(session.userId);
    expect(profile?.marketingOptIn).toBe(false);
  });

  it("I2: scope marketing writes no byType override", async () => {
    const session = await app.signIn(makeIdentity("op99-i2-nodefault"));
    const before = await storedPreferences(session.userId);

    await applyUnsubscribe(applyRequest(tokenFor(session, "marketing")));

    const after = await storedPreferences(session.userId);
    expect((after?.byType ?? {}) as Record<string, unknown>).toEqual(
      (before?.byType ?? {}) as Record<string, unknown>
    );
  });

  it("I3: a repeat apply of scope all is 200 with the identical body", async () => {
    const session = await app.signIn(makeIdentity("op99-i3-all"));
    const token = tokenFor(session, "all");

    const first = await applyUnsubscribe(applyRequest(token));
    const second = await applyUnsubscribe(applyRequest(token));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    const stored = await storedPreferences(session.userId);
    expect(Object.keys((stored?.byType ?? {}) as Record<string, unknown>).sort()).toEqual(
      optOutableEmailTypeKeys()
    );
  });

  it("I3: a repeat apply of scope marketing keeps exactly one suppression", async () => {
    const session = await app.signIn(makeIdentity("op99-i3-marketing"));
    const token = tokenFor(session, "marketing");
    const hash = contactHash(session.identity.email);

    const first = await applyUnsubscribe(applyRequest(token));
    const second = await applyUnsubscribe(applyRequest(token));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await suppressionsFor(hash)).toHaveLength(1);
  });

  it("rejects a type-scoped apply naming a transactional type with 422 opt_out_not_allowed", async () => {
    const session = await app.signIn(makeIdentity("op99-locked-type"));
    const before = await storedPreferences(session.userId);

    const response = await applyUnsubscribe(
      applyRequest(tokenFor(session, "type", TRANSACTIONAL_TYPE))
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("opt_out_not_allowed");
    expect(body.error.details).toMatchObject({
      typeKey: TRANSACTIONAL_TYPE,
      channelGroup: "email",
      reason: "transactional",
    });
    expect(await storedPreferences(session.userId)).toEqual(before);
  });

  it("rejects a type-scoped apply naming an unknown type with 422 unknown_type_key", async () => {
    const session = await app.signIn(makeIdentity("op99-unknown-type"));
    const before = await storedPreferences(session.userId);

    const response = await applyUnsubscribe(
      applyRequest(tokenFor(session, "type", "not.a.real.type"))
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("unknown_type_key");
    expect(body.error.details).toMatchObject({ typeKey: "not.a.real.type" });
    expect(await storedPreferences(session.userId)).toEqual(before);
  });
});

describe("locked non-transactional type — 422 opt_out_not_allowed", () => {
  it("rejects a type-scoped apply naming a locked non-transactional type before writing", async () => {
    const session = await app.signIn(makeIdentity("op99-locked-nontransactional"));
    // A concrete member of the 23: `account.welcome` is enabled,
    // non-transactional, and its email group is enabled but locked
    // (`optOutAllowed: false`), so it is opt-out-denied though not transactional.
    const locked = lockedNonTransactionalEmailTypeKeys();
    expect(locked).toContain("account.welcome");
    const typeKey = locked[0] ?? "";
    const before = await storedPreferences(session.userId);

    const response = await applyUnsubscribe(applyRequest(tokenFor(session, "type", typeKey)));

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("opt_out_not_allowed");
    expect(body.error.details).toEqual({
      typeKey,
      channelGroup: "email",
      reason: "not_opt_outable",
    });
    expect(await storedPreferences(session.userId)).toEqual(before);
  });

  it("rejects a type-scoped preview naming a locked non-transactional type before writing", async () => {
    const session = await app.signIn(makeIdentity("op99-locked-nontransactional-preview"));
    const locked = lockedNonTransactionalEmailTypeKeys();
    expect(locked).toContain("account.welcome");
    const typeKey = locked[0] ?? "";
    const before = await storedPreferences(session.userId);

    const response = await previewUnsubscribe(previewRequest(tokenFor(session, "type", typeKey)));

    expect(response.status).toBe(422);
    const body = (await response.json()) as ErrorBody;

    expect(body.error.code).toBe("opt_out_not_allowed");
    expect(body.error.details).toEqual({
      typeKey,
      channelGroup: "email",
      reason: "not_opt_outable",
    });
    expect(await storedPreferences(session.userId)).toEqual(before);
  });
});
