import type { CreateIndexesOptions, Db, IndexDirection } from "mongodb";

import { getLogger } from "../logging";
import { COLLECTIONS, type CollectionName } from "./collections";

/**
 * Declarative index specification and idempotent bootstrap (OP-76, schema §21).
 *
 * `INDEX_SPECS` is the single source of truth for every index the database must
 * carry: it is consumed by the one-off bootstrap (`ensureIndexes`, run through
 * `scripts/db/ensure-indexes.ts`) and by the lint specs in `indexes.test.ts`, so
 * a mistake in the schema is caught in CI rather than only in production.
 *
 * Two invariants are enforced by the specs (schema §21, conventions §8):
 *
 *   1. every compound index on a tenant-scoped collection leads with
 *      `tenantId`, so a tenant-scoped query is always index-supported (the one
 *      documented exception — `event_images { eventId, assetId }` — is asserted
 *      by the unit lint);
 *   2. every TTL index expires on the `expireAt` field with
 *      `expireAfterSeconds: 0` (schema §22).
 *
 * The Atlas vector-search index is deliberately NOT part of this registry: it is
 * a deployment-specific, opt-in index created by the bootstrap script, not a
 * database invariant every environment must seed.
 */

/** One key of an index: `[field, direction]` where direction is 1 or -1. */
export type IndexKey = readonly [field: string, direction: 1 | -1];

/** Declarative description of one database index. */
export interface IndexSpec {
  /** The collection the index is created on. */
  readonly collection: CollectionName;
  /** The explicit index name (stable across environments). */
  readonly name: string;
  /** The keys in index order; the first entry is the leading key. */
  readonly keys: readonly IndexKey[];
  /** When true the index rejects duplicate key tuples. */
  readonly unique?: boolean;
  /**
   * Restricts the index to documents matching the filter — used for the
   * "active-only" uniqueness invariants (e.g. only non-revoked rows compete).
   */
  readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
  /** TTL expiry in seconds; `0` expires the moment the key timestamp passes. */
  readonly expireAfterSeconds?: number;
}

/**
 * Collections whose documents are scoped to a tenant (schema §12, §21 P3).
 *
 * A compound index on one of these must lead with `tenantId` so cross-tenant
 * queries can never scan one tenant's rows while filtering for another.
 *
 * Note: `faceMatches` is deliberately NOT listed here. Its uniqueness index
 * keys on `{ profileId, imageId, faceIndex }`, and the unit lint's exhaustive
 * exception list (owned by the spec) permits `tenantId` to be absent from only
 * the `event_images` pair index — so this registry treats face matches as
 * subject-scoped, matching the spec's model.
 */
export const TENANT_SCOPED_COLLECTIONS: ReadonlySet<string> = new Set([
  COLLECTIONS.events,
  COLLECTIONS.eventOrganizers,
  COLLECTIONS.subscriptions,
  COLLECTIONS.dispatches,
  COLLECTIONS.eventImages,
  COLLECTIONS.accessLinks,
  COLLECTIONS.mediaAssets,
]);

/**
 * Every index the database must carry (schema §21, §22).
 *
 * Order is irrelevant to the bootstrap; the report is compared as a sorted set.
 */
export const INDEX_SPECS: readonly IndexSpec[] = [
  // notifications — the unread badge query reads only unread rows (§21).
  {
    collection: COLLECTIONS.notifications,
    name: "idx_user_unread",
    keys: [
      ["userId", 1],
      ["createdAt", -1],
    ],
    partialFilterExpression: { readAt: null },
  },
  // notifications — 90-day retention via the TTL monitor (§22).
  {
    collection: COLLECTIONS.notifications,
    name: "notifications_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // invitations — expire automatically once their window passes (§22).
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },
  // invitations — "my pending invitations": the caller's pending count on the
  // `GET /me` bootstrap and the §1.2 feed read `{ "invitee.userId", status }`
  // newest-first, so the compound index must carry all three keys in this
  // order (§13.6; ADR-0060).
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_invitee_user_status_created",
    keys: [
      ["invitee.userId", 1],
      ["status", 1],
      ["createdAt", -1],
    ],
  },

  // audit_logs — 400-day retention, swept by the TTL monitor (§22).
  {
    collection: COLLECTIONS.auditLogs,
    name: "audit_logs_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // event_organizers — one active organizer per event (revoked rows excluded).
  {
    collection: COLLECTIONS.eventOrganizers,
    name: "event_organizers_active_event_unique",
    keys: [
      ["tenantId", 1],
      ["eventId", 1],
    ],
    unique: true,
    partialFilterExpression: { revokedAt: null },
  },

  // notification_dispatches — one dispatch per dedupeKey (null keys excluded).
  {
    collection: COLLECTIONS.dispatches,
    name: "dispatches_tenant_dedupe_unique",
    keys: [
      ["tenantId", 1],
      ["dedupeKey", 1],
    ],
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
  // notification_dispatches — 180-day retention (§22).
  {
    collection: COLLECTIONS.dispatches,
    name: "dispatches_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // subscriptions — one live subscription per tenant (cancelled rows excluded).
  {
    collection: COLLECTIONS.subscriptions,
    name: "subscriptions_active_tenant_unique",
    keys: [["tenantId", 1]],
    unique: true,
    partialFilterExpression: { cancelledAt: null },
  },

  // event_images — one copy of an asset per event. The pair is globally
  // unambiguous because eventId already identifies the event across tenants;
  // this is the ONE documented tenant-scope prefix exception.
  {
    collection: COLLECTIONS.eventImages,
    name: "event_images_event_asset_unique",
    keys: [
      ["eventId", 1],
      ["assetId", 1],
    ],
    unique: true,
  },

  // access_links — one active link per slug (revoked rows excluded).
  {
    collection: COLLECTIONS.accessLinks,
    name: "access_links_active_slug_unique",
    keys: [
      ["tenantId", 1],
      ["slug", 1],
    ],
    unique: true,
    partialFilterExpression: { revokedAt: null },
  },

  // media_assets — content-addressed dedupe within a tenant (§16.1).
  {
    collection: COLLECTIONS.mediaAssets,
    name: "media_assets_tenant_content_hash_unique",
    keys: [
      ["tenantId", 1],
      ["contentHash", 1],
    ],
    unique: true,
  },

  // face_matches — one match row per (profile, image, face); makes the
  // incremental re-match idempotent (§17.4).
  {
    collection: COLLECTIONS.faceMatches,
    name: "face_matches_profile_image_face_unique",
    keys: [
      ["profileId", 1],
      ["imageId", 1],
      ["faceIndex", 1],
    ],
    unique: true,
  },

  // provider_webhook_events — webhook replay protection (§21).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_provider_event_unique",
    keys: [
      ["provider", 1],
      ["providerEventId", 1],
    ],
    unique: true,
  },
  // provider_webhook_events — 90-day retention (§22).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // idempotency_keys — one claim per (key, scope, principal); the unique index
  // is what makes the idempotency stage's claim atomic (§0.9).
  {
    collection: COLLECTIONS.idempotencyKeys,
    name: "idempotency_keys_key_scope_principal_unique",
    keys: [
      ["key", 1],
      ["scope", 1],
      ["principalId", 1],
    ],
    unique: true,
  },
  // idempotency_keys — 24-hour retention via the TTL monitor (§0.9/§22).
  {
    collection: COLLECTIONS.idempotencyKeys,
    name: "idempotency_keys_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // domain_events — the outbox's optional dedupeKey is what makes a repeated
  // emit collapse to one document; the unique partial index is the mechanism,
  // not an application-level check (ADR-0029 §7).
  {
    collection: COLLECTIONS.domainEvents,
    name: "domain_events_dedupe_unique",
    keys: [["dedupeKey", 1]],
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
  // domain_events — retention via the TTL monitor, window derived from
  // platformSettings.retention.domainEventDays (schema §22).
  {
    collection: COLLECTIONS.domainEvents,
    name: "domain_events_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // plans — one document per plan key (§14.1). This is the database backstop
  // that makes the seed's upsert safe under concurrent deploy instances: even a
  // racing insert cannot persist a second document for the same key (OP-83).
  {
    collection: COLLECTIONS.plans,
    name: "plans_key_unique",
    keys: [["key", 1]],
    unique: true,
  },

  // user_profiles — 1:1 with Better Auth `user`. The unique index is what makes
  // the `autoProvisioned` precedence rule a safe tie-break rather than a
  // correctness crutch (schema §13.2; ADR-0041 §4, corrected by ADR-0043).
  {
    collection: COLLECTIONS.userProfiles,
    name: "user_profiles_user_id_unique",
    keys: [["userId", 1]],
    unique: true,
  },
  // user_profiles — the admin fan-out lists admins by role and status (§13.2).
  {
    collection: COLLECTIONS.userProfiles,
    name: "user_profiles_platform_role_status",
    keys: [
      ["platformRole", 1],
      ["status", 1],
    ],
  },
  // user_profiles — the DSR purge job scans only rows awaiting deletion (§13.2).
  {
    collection: COLLECTIONS.userProfiles,
    name: "user_profiles_deletion_pending",
    keys: [
      ["status", 1],
      ["deletionScheduledAt", 1],
    ],
    partialFilterExpression: { status: "deletion_pending" },
  },
  // user_profiles — resolve a user's default workspace (§13.2).
  {
    collection: COLLECTIONS.userProfiles,
    name: "user_profiles_primary_tenant",
    keys: [["primaryTenantId", 1]],
  },

  // session_devices — the new-device decision reads one user's recent sightings
  // newest-first; the compound index makes that a bounded, indexed scan (§13.5;
  // ADR-0041 §2).
  {
    collection: COLLECTIONS.sessionDevices,
    name: "session_devices_user_created",
    keys: [
      ["userId", 1],
      ["createdAt", -1],
    ],
  },
  // session_devices — a sighting only matters inside the 24-hour new-device
  // window, so the TTL monitor reaps the rest and the collection stays bounded
  // (§13.5; ADR-0043).
  {
    collection: COLLECTIONS.sessionDevices,
    name: "session_devices_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // contact_change_fanouts — holds the raw previous/current contacts until the
  // fan-out reads them. The TTL index is what makes ADR-0040 §2's "short-lived,
  // TTL-bound" privacy justification actually hold (ADR-0043).
  {
    collection: COLLECTIONS.contactChangeFanouts,
    name: "contact_change_fanouts_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },
  // tenant_members — one membership per (tenant, user); the schema §13.4
  // composite identity, and the index behind `GET /tenants/{t}/members`
  // (ADR-0060).
  {
    collection: COLLECTIONS.tenantMembers,
    name: "tenant_members_tenant_user_unique",
    keys: [
      ["tenantId", 1],
      ["userId", 1],
    ],
    unique: true,
  },
  // tenant_members — the workspace switcher and the caller's membership load on
  // the `GET /me` bootstrap both read `{ userId, status: "active" }`. This index
  // deliberately does NOT lead with `tenantId`: `tenantMembers` is a
  // *subject-scoped* join collection (one row per tenant **× user**), not one of
  // the `TENANT_SCOPED_COLLECTIONS` whose documents each belong to a single
  // tenant — so the U1 prefix lint does not apply (schema §13.4; ADR-0060).
  {
    collection: COLLECTIONS.tenantMembers,
    name: "tenant_members_user_status",
    keys: [
      ["userId", 1],
      ["status", 1],
    ],
  },
  // contact_change_fanouts — one fan-out per emitted `auth.contact.changed`
  // event. The unique index makes the fan-out write idempotent under an
  // at-least-once redelivery: a redelivery after a partial failure re-inserts
  // the same event id and collides harmlessly instead of losing the
  // replaced-contact target (ADR-0049 §1).
  {
    collection: COLLECTIONS.contactChangeFanouts,
    name: "contact_change_fanouts_event_id_unique",
    keys: [["eventId", 1]],
    unique: true,
  },
];

/** The outcome of a bootstrap run: which indexes were built and which existed. */
export interface IndexBootstrapReport {
  /** Names of the indexes created by this run. */
  readonly created: readonly string[];
  /** Names of the declared indexes that were already present. */
  readonly existing: readonly string[];
}

/** MongoDB server error code for a missing collection/namespace. */
const NAMESPACE_NOT_FOUND = 26;

/** True when `error` is MongoDB's "namespace does not exist" (code 26). */
function isMissingNamespace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === NAMESPACE_NOT_FOUND
  );
}

/**
 * Narrow an untyped driver result to an array.
 *
 * `listIndexes()` is typed `any[]` by the driver, so the result is funnelled
 * through `unknown` and re-narrowed here rather than trusting the broad type.
 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** True when `value` is an index description carrying a string `name`. */
function hasStringName(value: unknown): value is { readonly name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/** Turn the ordered key list into the driver's index specification document. */
function toIndexSpecification(keys: readonly IndexKey[]): Record<string, IndexDirection> {
  const specification: Record<string, IndexDirection> = {};
  for (const [field, direction] of keys) {
    specification[field] = direction;
  }
  return specification;
}

/** Turn a spec into the driver's create-index options. */
function toIndexOptions(spec: IndexSpec): CreateIndexesOptions {
  return {
    name: spec.name,
    ...(spec.unique === true ? { unique: true } : {}),
    ...(spec.partialFilterExpression === undefined
      ? {}
      : { partialFilterExpression: spec.partialFilterExpression }),
    ...(spec.expireAfterSeconds === undefined
      ? {}
      : { expireAfterSeconds: spec.expireAfterSeconds }),
  };
}

/**
 * List the index names already present on a collection.
 *
 * A collection that does not exist yet has no indexes: MongoDB answers with a
 * "namespace not found" error, which is treated as an empty set so the caller
 * can proceed to create them.
 */
async function listIndexNames(db: Db, collection: string): Promise<Set<string>> {
  try {
    const raw: unknown = await db.collection(collection).listIndexes().toArray();
    const names = new Set<string>();
    for (const entry of asArray(raw)) {
      if (hasStringName(entry)) {
        names.add(entry.name);
      }
    }
    return names;
  } catch (error) {
    if (isMissingNamespace(error)) {
      return new Set();
    }
    throw error;
  }
}

/**
 * Create every index in {@link INDEX_SPECS} that is not already present.
 *
 * Idempotent: a second run against the same database creates nothing and
 * reports every declared index as `existing`. Indexes present in the database
 * but absent from the registry are never dropped — the bootstrap only ever adds
 * (a destructive drop is a deliberate, separate operator action).
 *
 * @param db - The database to build indexes on.
 * @returns The report of created and already-existing index names.
 */
export async function ensureIndexes(db: Db): Promise<IndexBootstrapReport> {
  const created: string[] = [];
  const existing: string[] = [];

  const specsByCollection = new Map<string, IndexSpec[]>();
  for (const spec of INDEX_SPECS) {
    const specs = specsByCollection.get(spec.collection);
    if (specs === undefined) {
      specsByCollection.set(spec.collection, [spec]);
    } else {
      specs.push(spec);
    }
  }

  for (const [collection, specs] of specsByCollection) {
    const present = await listIndexNames(db, collection);
    for (const spec of specs) {
      if (present.has(spec.name)) {
        existing.push(spec.name);
      } else {
        await db
          .collection(collection)
          .createIndex(toIndexSpecification(spec.keys), toIndexOptions(spec));
        created.push(spec.name);
      }
    }
  }

  if (created.length > 0) {
    getLogger().info("db.indexes.created", { event: "db.indexes.created", names: created });
  }

  return { created, existing };
}
