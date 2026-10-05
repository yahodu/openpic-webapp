import { ObjectId } from "mongodb";
import { z } from "zod";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { USER_PROFILES_COLLECTION } from "@/server/auth/identity-hooks";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";

/**
 * `GET /api/v1/me` — the caller's own account (contract §1.2).
 *
 * OP-86 guards the route with the `user` auth label so the deployed HTTP
 * surface exercises the shared guard (E1, ADR-0025 §6). This card (OP-89)
 * delivers only the minimal read slice its e2e pins: the profile-default fields
 * written by the user-created hook. The full §1.2 projection (id, email, phone,
 * displayName, avatarUrl, tenants, capabilities, unread counts) and `PATCH /me`
 * are owned by OP-90 and are written against this slice.
 */

/** The stored `userProfiles` document fields this slice reads (schema §13.2). */
interface UserProfileDocument {
  readonly locale?: unknown;
  readonly platformRole?: unknown;
  readonly status?: unknown;
  readonly marketingOptIn?: unknown;
  readonly accountCompletedAt?: unknown;
  readonly contactCapabilities?: unknown;
}

/** The default `contactCapabilities` for a user who has never been probed. */
const NEVER_PROBED_CONTACT_CAPABILITIES = {
  whatsappCapable: null,
  whatsappCheckedAt: null,
} as const;

/** The OP-89 `/me` read slice (contract §1.2 profile defaults). */
const MeResponseSchema = z.object({
  locale: z.string(),
  platformRole: z.string(),
  status: z.string(),
  marketingOptIn: z.boolean(),
  accountCompletedAt: z.string().nullable(),
  contactCapabilities: z.object({
    whatsappCapable: z.boolean().nullable(),
    whatsappCheckedAt: z.string().nullable(),
  }),
});

/** Read a stored value as a string, or fall back. */
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Read a stored `accountCompletedAt` as an ISO string, or `null`. */
function asIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** The never-probed contact capabilities, defaulted for a missing profile. */
function asContactCapabilities(value: unknown): {
  whatsappCapable: boolean | null;
  whatsappCheckedAt: string | null;
} {
  if (typeof value !== "object" || value === null) {
    return { ...NEVER_PROBED_CONTACT_CAPABILITIES };
  }
  const record = value as Record<string, unknown>;
  return {
    whatsappCapable: typeof record.whatsappCapable === "boolean" ? record.whatsappCapable : null,
    whatsappCheckedAt: asIsoString(record.whatsappCheckedAt),
  };
}

/** Build the response body from the stored profile (or its documented defaults). */
function toMeBody(profile: UserProfileDocument | null): z.infer<typeof MeResponseSchema> {
  return {
    locale: asString(profile?.locale, "en-IN"),
    platformRole: asString(profile?.platformRole, "client"),
    status: asString(profile?.status, "active"),
    marketingOptIn: profile?.marketingOptIn === true,
    accountCompletedAt: asIsoString(profile?.accountCompletedAt),
    contactCapabilities: asContactCapabilities(profile?.contactCapabilities),
  };
}

/** Return the caller's own profile-default slice behind the `user` guard. */
export const GET = defineRoute({
  route: "/api/v1/me",
  response: MeResponseSchema,
  // Built per request: `getAuth()`/`getDb()` read validated configuration, so
  // evaluating them at module scope would fail `next build`'s page-data
  // collection (which runs without a configured environment).
  //
  // `allowBanned` because `GET /me` is on the contract §0.3 ban-exemption list
  // (`GET /me`, `POST /me/data-requests`): a banned user may read the route
  // that tells them why they are banned.
  auth: (ctx, request) =>
    requireAuth("user", { auth: getAuth(), database: getDb(), allowBanned: true })(ctx, request),
  handler: async (ctx) => {
    const userId = ctx.principal;
    if (userId === undefined) {
      return { body: toMeBody(null) };
    }

    const database = getDb();
    const profile = ObjectId.isValid(userId)
      ? await database
          .collection<UserProfileDocument>(USER_PROFILES_COLLECTION)
          .findOne({ userId: new ObjectId(userId) } as never)
      : null;

    return { body: toMeBody(profile) };
  },
});
