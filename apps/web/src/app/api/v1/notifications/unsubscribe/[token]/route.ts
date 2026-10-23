import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { z } from "zod";

import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { listEnabledNotificationTypes } from "@/server/notifications/notification-types-read";
import { toStoredPreferences, type StoredPreferences } from "@/server/notifications/preferences";
import {
  applyUnsubscribeScope,
  verifyUnsubscribeToken,
  type UnsubscribeTokenPayload,
} from "@/server/notifications/unsubscribe";
import { platformRepo } from "@/server/repos";

/**
 * `GET` / `POST /api/v1/notifications/unsubscribe/{token}` (contract §7.5;
 * design §19.6; ADR-0240, ADR-0241).
 *
 * Both verbs are **public** — the HMAC token is the credential and the only
 * thing it grants is muting the named scope for the token's user. `GET`
 * previews what would be muted and writes nothing; `POST` applies it.
 *
 * The token is verified with `getConfig().transport.unsubscribeSigningSecret`
 * before anything else, so an unverifiable request never reaches the catalogue
 * or the database. Every rejection — an invalid/tampered/absent token
 * (`400 bad_request`), an expired token (`410 gone`), a `scope: "type"` naming
 * an unknown `typeKey` (`422 unknown_type_key`) or a type that may not be muted
 * (`422 opt_out_not_allowed`) — happens **before** any write, so a rejected
 * unsubscribe can never leave a phantom override behind.
 *
 * `POST` for `scope: "marketing"` clears `userProfiles.marketingOptIn` and
 * upserts the first-party `notificationSuppressions` row keyed
 * `{ channel: "email", contactHash }`; `scope: "all"` writes preferences only —
 * a `scope: "all"` suppression is the "never contact" list and must never be
 * able to block a security or billing message (design §19.6).
 *
 * The raw token and the recipient's email address are never logged; the one log
 * line this route emits carries the user id and the scope only.
 */

/** The path prefix the `{token}` segment is read from. */
const UNSUBSCRIBE_PREFIX = "/api/v1/notifications/unsubscribe/";

/** The Better Auth user collection (schema §13.1) — a literal, not `COLLECTIONS.users`. */
const BETTER_AUTH_USER = "user";

/** The one channel group an unsubscribe may ever write (design §19.6). */
const EMAIL_GROUP = "email";

/** The unsubscribe response body (contract §7.5; ADR-0240). */
const unsubscribeResponseSchema = z.object({
  applied: z.boolean(),
  scope: z.enum(["type", "marketing", "all"]),
  typeKey: z.string().optional(),
  mutedTypeKeys: z.array(z.string()),
  stillReceiving: z.array(z.string()),
  managePreferencesUrl: z.string(),
});

/**
 * Read the `{token}` path segment from the request URL.
 *
 * @param request - The inbound request.
 * @returns The raw token, or an empty string when the path does not carry one.
 */
function tokenFromRequest(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(UNSUBSCRIBE_PREFIX) ? pathname.slice(UNSUBSCRIBE_PREFIX.length) : "";
}

/**
 * Verify the request's token or throw the pinned rejection.
 *
 * @param request - The inbound request.
 * @returns The verified signed payload.
 * @throws {AppError} `bad_request` for an invalid/tampered/absent token and
 *   `gone` for an expired one (ADR-0240 assumption #4).
 */
function verifiedPayload(request: Request): UnsubscribeTokenPayload {
  const verdict = verifyUnsubscribeToken(tokenFromRequest(request), {
    secret: getConfig().transport.unsubscribeSigningSecret,
  });

  if (!verdict.valid) {
    throw appError(verdict.reason === "expired" ? "gone" : "bad_request");
  }
  if (!ObjectId.isValid(verdict.payload.userId)) {
    throw appError("bad_request");
  }

  return verdict.payload;
}

/** `sha256:` + the lowercase hex digest of a trimmed, lowercased contact (§19.6). */
function contactHashOf(contact: string): string {
  return `sha256:${createHash("sha256").update(contact.trim().toLowerCase()).digest("hex")}`;
}

/**
 * Read the recipient's email from the Better Auth `user` document.
 *
 * The row is untested driver data, so the field is narrowed rather than trusted
 * (the same shape `fan-out.ts` reads).
 *
 * @param db - The database handle.
 * @param userId - The token's user id.
 * @returns The stored email, or `null` when the row or the field is absent.
 */
async function userEmail(db: ReturnType<typeof getDb>, userId: ObjectId): Promise<string | null> {
  const row: unknown = await platformRepo(db).collection(BETTER_AUTH_USER).findOne({ _id: userId });

  if (typeof row !== "object" || row === null) {
    return null;
  }
  const email = (row as { readonly email?: unknown }).email;
  return typeof email === "string" ? email : null;
}

/**
 * Persist one applied scope (contract §7.5; ADR-0240).
 *
 * `type` / `all` upsert the preferences document, preserving every scope the
 * unsubscribe does not own. `marketing` clears `marketingOptIn` and upserts the
 * suppression, whose key makes a repeat `POST` idempotent.
 *
 * @param db - The database handle.
 * @param payload - The verified token payload.
 * @param preferences - The reducer's next preferences document.
 * @returns A promise that resolves once every write has landed.
 */
async function persistApplication(
  db: ReturnType<typeof getDb>,
  payload: UnsubscribeTokenPayload,
  preferences: StoredPreferences
): Promise<void> {
  const userId = new ObjectId(payload.userId);
  const updatedAt = new Date();
  const repo = platformRepo(db);

  if (payload.scope !== "marketing") {
    await repo
      .collection(COLLECTIONS.notificationPreferences)
      .updateOne({ userId }, { $set: { userId, ...preferences, updatedAt } }, { upsert: true });
    return;
  }

  // The suppression is keyed by the contact hash, so the email must be read
  // before either write: a missing address is a data-integrity failure and must
  // not leave a half-applied unsubscribe behind.
  const email = await userEmail(db, userId);
  if (email === null) {
    throw appError("internal_error");
  }

  await repo
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId },
      { $set: { userId, marketingOptIn: false, updatedAt } },
      { upsert: true }
    );

  const contactHash = contactHashOf(email);
  await repo.collection(COLLECTIONS.notificationSuppressions).updateOne(
    { channel: EMAIL_GROUP, contactHash },
    {
      $set: {
        channel: EMAIL_GROUP,
        contactHash,
        reason: "unsubscribe",
        scope: "marketing",
        expiresAt: null,
      },
      $setOnInsert: { createdAt: updatedAt },
    },
    { upsert: true }
  );
}

/**
 * Build the unsubscribe `200` body for a preview or an application.
 *
 * @param request - The inbound request.
 * @param applied - Whether the scope was applied (`POST`) or only previewed (`GET`).
 * @returns The response body (contract §7.5).
 */
async function unsubscribeBody(
  request: Request,
  applied: boolean
): Promise<z.infer<typeof unsubscribeResponseSchema>> {
  const payload = verifiedPayload(request);
  const db = getDb();
  const catalogue = await listEnabledNotificationTypes({ db });

  const stored = toStoredPreferences(
    await platformRepo(db)
      .collection(COLLECTIONS.notificationPreferences)
      .findOne({
        userId: new ObjectId(payload.userId),
      })
  );

  const application = applyUnsubscribeScope({
    preferences: stored,
    catalogue,
    scope: payload.scope,
    ...(payload.typeKey === undefined ? {} : { typeKey: payload.typeKey }),
  });

  // A `scope: "type"` token must name a type the surface may mute; both
  // rejections are raised before any write (contract §7.5, ADR-0240).
  if (payload.scope === "type") {
    const typeKey = payload.typeKey ?? "";
    if (!catalogue.some((type) => type.typeKey === typeKey)) {
      throw appError("unknown_type_key", { details: { typeKey } });
    }
    if (application.mutedTypeKeys.length === 0) {
      const type = catalogue.find((candidate) => candidate.typeKey === typeKey);
      throw appError("opt_out_not_allowed", {
        details: {
          typeKey,
          channelGroup: EMAIL_GROUP,
          reason: type?.transactional === true ? "transactional" : "not_opt_outable",
        },
      });
    }
  }

  if (applied) {
    await persistApplication(db, payload, application.preferences);
    getLogger().info("unsubscribe applied", {
      event: "notification.unsubscribe.applied",
      userId: payload.userId,
      scope: payload.scope,
    });
  }

  return {
    applied,
    scope: payload.scope,
    ...(payload.scope === "type" ? { typeKey: payload.typeKey ?? "" } : {}),
    mutedTypeKeys: application.mutedTypeKeys,
    stillReceiving: application.stillReceiving,
    managePreferencesUrl: `${getConfig().app.baseUrl}/settings/notifications`,
  };
}

export const GET = defineRoute({
  route: "/api/v1/notifications/unsubscribe/:token",
  response: unsubscribeResponseSchema,
  handler: (ctx) => unsubscribeBody(ctx.request, false).then((body) => ({ body })),
});

export const POST = defineRoute({
  route: "/api/v1/notifications/unsubscribe/:token",
  response: unsubscribeResponseSchema,
  handler: (ctx) => unsubscribeBody(ctx.request, true).then((body) => ({ body })),
});
