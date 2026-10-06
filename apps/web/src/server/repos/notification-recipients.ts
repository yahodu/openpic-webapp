import type { Db, Document } from "mongodb";
import { ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import type { RecipientRepository } from "@/server/notifications/fan-out";
import { platformRepo } from "@/server/repos";

/**
 * Mongo-backed `RecipientRepository` for the notification fan-out (OP-94 §2,
 * ADR-0090, ADR-0106).
 *
 * The fan-out resolves its audience **at send time** (audience is never stored
 * on the outbox row): the injected {@link RecipientRepository} port is the only
 * place that reads the membership/contact collections. This is the production
 * implementation of that port, resolving each audience to the user ids that
 * should receive the event:
 *
 *   - `organizer` / `co_organizer` → active `eventMembers` rows for the event,
 *     plus accepted/pending `event_co_organizer` invitations, so a co-organizer
 *     audience reaches the invitee (`collab.invite.sent`).
 *   - `attendee_identified` → `attendeeEventProfiles` whose `subject.kind` is
 *     `user` (an anonymous, cookie-bound uploader has no reachable account).
 *   - `billing_contact` → the tenant's `billingContactUserId`.
 *   - `platform_admin` → active `userProfiles` with `platformRole: "admin"`.
 *
 * Events scoped to a tenant's collections store their ids as `ObjectId`s while
 * the outbox carries hex strings, so each id filter matches *either* form. Every
 * read is a plain find; a missing collection or field yields no recipients
 * rather than a crash.
 */

/** The `tenants` collection (schema §13.3). */
const TENANTS_COLLECTION = "tenants";

/** The event membership collection (schema §15.2). */
const EVENT_MEMBERS_COLLECTION = "eventMembers";

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A 24-hex id as an `ObjectId`, or `null` when it is not one. */
function asObjectId(value: string): ObjectId | null {
  return /^[0-9a-fA-F]{24}$/.test(value) ? new ObjectId(value) : null;
}

/** A filter matching a stored id as either its `ObjectId` or its string form. */
function idMatch(hex: string): Document {
  const objectId = asObjectId(hex);
  return objectId === null ? { $in: [hex] } : { $in: [objectId, hex] };
}

/** The hex string of a stored id value (`ObjectId` or string), or `null`. */
function idHex(value: unknown): string | null {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Build a `RecipientRepository` backed by the shared MongoDB client.
 *
 * The database handle defaults to the shared client and is resolved **per
 * call**, never at module load: the production singleton below is imported by
 * route modules, and `getDb()` must only run once a request has configured the
 * process environment.
 *
 * @param db - An explicit database handle; defaults to the shared client (OP-75).
 * @returns The recipient source the fan-out reads.
 */
export function mongoRecipientRepository(db?: Db): RecipientRepository {
  const store = () => (db === undefined ? platformRepo() : platformRepo(db));

  return {
    async listEventRoleMembers({ tenantId, eventId, roles }) {
      const ids = new Set<string>();
      const repo = store();

      const members = await repo
        .collection(EVENT_MEMBERS_COLLECTION)
        .find({
          tenantId: idMatch(tenantId),
          eventId: idMatch(eventId),
          role: { $in: [...roles] },
          status: "active",
        })
        .toArray();
      for (const member of members) {
        const value: unknown = member.userId;
        const id = idHex(value);
        if (id !== null) ids.add(id);
      }

      // A co-organizer audience also reaches the invitee, who has no
      // `eventMembers` row until they accept (design §4.1 `collab.invite.sent`).
      if (roles.includes("co_organizer")) {
        const invitations = await repo
          .collection(COLLECTIONS.invitations)
          .find({
            tenantId: idMatch(tenantId),
            eventId: idMatch(eventId),
            kind: "event_co_organizer",
            status: { $in: ["pending", "accepted"] },
          })
          .toArray();
        for (const invitation of invitations) {
          const invitee: unknown = invitation.invitee;
          if (!isRecord(invitee)) continue;
          const id = idHex(invitee.userId);
          if (id !== null) ids.add(id);
        }
      }

      return [...ids];
    },

    async listIdentifiedAttendeeUserIds({ tenantId, eventId }) {
      const repo = store();
      const profiles = await repo
        .collection(COLLECTIONS.attendeeEventProfiles)
        .find({
          tenantId: idMatch(tenantId),
          eventId: idMatch(eventId),
          "subject.kind": "user",
        })
        .toArray();

      const ids: string[] = [];
      for (const profile of profiles) {
        const subject: unknown = profile.subject;
        if (!isRecord(subject)) continue;
        const id = idHex(subject.userId);
        if (id !== null) ids.push(id);
      }
      return ids;
    },

    async getBillingContactUserId({ tenantId }) {
      const tenant: unknown = await store()
        .collection(TENANTS_COLLECTION)
        .findOne({ _id: idMatch(tenantId) });
      if (!isRecord(tenant)) return null;
      return idHex(tenant.billingContactUserId);
    },

    async listPlatformAdminUserIds() {
      const repo = store();
      const profiles = await repo
        .collection(COLLECTIONS.userProfiles)
        .find({ platformRole: "admin", status: "active" })
        .toArray();

      const ids: string[] = [];
      for (const profile of profiles) {
        const value: unknown = profile.userId;
        const id = idHex(value);
        if (id !== null) ids.push(id);
      }
      return ids;
    },
  };
}

/** The production recipient source (lazily reads the shared client on first use). */
export const notificationRecipients: RecipientRepository = mongoRecipientRepository();
