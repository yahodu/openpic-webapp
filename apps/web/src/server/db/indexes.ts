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
  COLLECTIONS.usageCounters,
  COLLECTIONS.entitlementGrants,
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
  // upload_sessions — expire automatically once their window passes (§16.2,
  // §22). OP-124 is the first lane to write a session row (ADR-0721 D2).
  {
    collection: COLLECTIONS.uploadSessions,
    name: "upload_sessions_expire_at_ttl",
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
  // invitations — token redemption: the public preview hashes the raw token and
  // reads the row by that hash, so the hash must be unique across every tenant
  // (§13.6).
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_token_hash_unique",
    keys: [["tokenHash", 1]],
    unique: true,
  },
  // invitations — "one live invitation per invitee per event": the partial
  // filter keeps only `pending` rows in the index, so a revoked, rejected or
  // expired invitation frees the slot for a re-invite (§13.6). One index per
  // invitee kind, because the stored contact lives in a kind-specific field.
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_pending_event_email_unique",
    keys: [
      ["eventId", 1],
      ["invitee.email", 1],
    ],
    unique: true,
    partialFilterExpression: { status: "pending", "invitee.email": { $type: "string" } },
  },
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_pending_event_user_unique",
    keys: [
      ["eventId", 1],
      ["invitee.userId", 1],
    ],
    unique: true,
    partialFilterExpression: { status: "pending", "invitee.userId": { $type: "string" } },
  },
  {
    collection: COLLECTIONS.invitations,
    name: "invitations_pending_event_phone_unique",
    keys: [
      ["eventId", 1],
      ["invitee.phoneE164", 1],
    ],
    unique: true,
    partialFilterExpression: { status: "pending", "invitee.phoneE164": { $type: "string" } },
  },

  // audit_logs — 400-day retention, swept by the TTL monitor (§22).
  {
    collection: COLLECTIONS.auditLogs,
    name: "audit_logs_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // event_organizers — one active membership row per (event, user); an event
  // may carry its organizer plus any number of co-organizers (schema §15.2:
  // `{eventId, userId}` unique). Revoked rows are excluded from uniqueness.
  {
    collection: COLLECTIONS.eventOrganizers,
    name: "event_organizers_active_event_unique",
    keys: [
      ["tenantId", 1],
      ["eventId", 1],
      ["userId", 1],
    ],
    unique: true,
    partialFilterExpression: { revokedAt: null },
  },

  // event_organizers — exactly one active ORGANIZER per event (schema §15.2:
  // `{eventId, role}` unique partial on `{role:"organizer"}`). Co-organizer
  // rows carry a different role, so this never blocks them.
  {
    collection: COLLECTIONS.eventOrganizers,
    name: "event_organizers_active_organizer_unique",
    keys: [
      ["tenantId", 1],
      ["eventId", 1],
      ["role", 1],
    ],
    unique: true,
    partialFilterExpression: { role: "organizer", revokedAt: null },
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
  // notification_dispatches — the quiet-hours release sweep selects
  // `{ status: "deferred", until <= now }`; the partial index scopes it to the
  // deferred rows only (ADR-0120 §Quiet-hours deferral; ADR-0124). `dispatches`
  // is tenant-scoped, so the compound index leads with `tenantId` (§21 P3).
  {
    collection: COLLECTIONS.dispatches,
    name: "dispatches_status_until_deferred",
    keys: [
      ["tenantId", 1],
      ["status", 1],
      ["until", 1],
    ],
    partialFilterExpression: { status: "deferred" },
  },

  // notificationDigests — one open bucket per (user, bucketKey); a flushed
  // bucket leaves the partial index and frees the key (schema §19.6, ADR-0120).
  {
    collection: COLLECTIONS.notificationDigests,
    name: "notification_digests_user_bucket_open_unique",
    keys: [
      ["userId", 1],
      ["bucketKey", 1],
    ],
    unique: true,
    partialFilterExpression: { status: "open" },
  },
  // notificationDigests — the flush cron reads open buckets whose flushAt has
  // passed, in flushAt order (schema §19.6, ADR-0120).
  {
    collection: COLLECTIONS.notificationDigests,
    name: "notification_digests_status_flush_at_open",
    keys: [
      ["status", 1],
      ["flushAt", 1],
    ],
    partialFilterExpression: { status: "open" },
  },
  // notificationDigests — retention via the TTL monitor (§22).
  {
    collection: COLLECTIONS.notificationDigests,
    name: "notification_digests_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // notificationSuppressions — one row per contact per channel, so the
  // unsubscribe upsert is idempotent and a second suppression of the same
  // address cannot be inserted (schema §19.6, ADR-0241).
  {
    collection: COLLECTIONS.notificationSuppressions,
    name: "notification_suppressions_channel_contact_unique",
    keys: [
      ["channel", 1],
      ["contactHash", 1],
    ],
    unique: true,
  },
  // notificationSuppressions — the admin audit view reads newest-first
  // (schema §19.6).
  {
    collection: COLLECTIONS.notificationSuppressions,
    name: "notification_suppressions_created_at",
    keys: [["createdAt", -1]],
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

  // events — the embedded public-link slot is globally unique per active slug
  // (schema §15.1, OP-115 ADR-0520). `accessLinks` is embedded, so the unique
  // multikey index keyed on `accessLinks.slug` restricted to rows that carry an
  // active link is what the create-route collision retry (I5) runs on: a
  // second event drawing an occupied slug is rejected with E11000 and the
  // route regenerates.
  {
    collection: COLLECTIONS.events,
    name: "events_active_slug_unique",
    keys: [["accessLinks.slug", 1]],
    unique: true,
    partialFilterExpression: { "accessLinks.active": true },
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

  // media_assets — the QR export cache lookup by its render-free key (OP-118
  // ADR-0623). Non-unique: the key addresses at most one row per tenant, but
  // the `(tenantId, contentHash)` unique index remains the only hard invariant.
  {
    collection: COLLECTIONS.mediaAssets,
    name: "media_assets_tenant_kind_qr_cache_key",
    keys: [
      ["tenantId", 1],
      ["kind", 1],
      ["qrCacheKey", 1],
    ],
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

  // provider_webhook_events — webhook replay protection with zero application
  // logic (§18.4, §21). The index is **partial on a string `providerEventId`**:
  // a payload that carries no vendor event id has no competing id, and a plain
  // unique index would collide every id-less delivery on `(provider, null)` —
  // silently swallowing every second status change (ADR-0441 §2).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_provider_event_unique",
    keys: [
      ["provider", 1],
      ["providerEventId", 1],
    ],
    unique: true,
    partialFilterExpression: { providerEventId: { $type: "string" } },
  },
  // provider_webhook_events — the second identity shape of §18.4: two payloads
  // that carry no event id are held apart by their content hash, and a byte
  // replay of one of them collides here (ADR-0441 §2).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_provider_payload_unique",
    keys: [
      ["provider", 1],
      ["payloadHash", 1],
    ],
    unique: true,
    partialFilterExpression: { providerEventId: null },
  },
  // provider_webhook_events — OP-111's `webhook-projection-sweep` reads every
  // unprocessed row oldest-first; the partial index keeps it sized to the
  // backlog rather than to the whole 90-day window (§10.2, §18.4).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_unprocessed_received",
    keys: [
      ["processedAt", 1],
      ["receivedAt", 1],
    ],
    partialFilterExpression: { processedAt: null },
  },
  // provider_webhook_events — 90-day retention (§22).
  {
    collection: COLLECTIONS.providerWebhookEvents,
    name: "provider_webhook_events_expire_at_ttl",
    keys: [["expireAt", 1]],
    expireAfterSeconds: 0,
  },

  // billing_transactions — the append-only ledger (§14.4). The unique
  // `idempotencyKey` is what lets a re-projection after a crash write the same
  // row instead of a second one. The collection is deliberately NOT in
  // `TENANT_SCOPED_COLLECTIONS`: its `{subscriptionId, kind, occurredAt}` index
  // is a legitimate per-subscription scan (a subscription already identifies
  // one tenant), not a cross-tenant query (§14.4, ADR-0441 §4).
  {
    collection: COLLECTIONS.billingTransactions,
    name: "billing_transactions_idempotency_key_unique",
    keys: [["idempotencyKey", 1]],
    unique: true,
  },
  // billing_transactions — the tenant's statement, newest-first (§14.4).
  {
    collection: COLLECTIONS.billingTransactions,
    name: "billing_transactions_tenant_occurred",
    keys: [
      ["tenantId", 1],
      ["occurredAt", -1],
    ],
  },
  // billing_transactions — one subscription's history by kind (§14.4).
  {
    collection: COLLECTIONS.billingTransactions,
    name: "billing_transactions_subscription_kind_occurred",
    keys: [
      ["subscriptionId", 1],
      ["kind", 1],
      ["occurredAt", -1],
    ],
  },
  // billing_transactions — reconciliation resolves a vendor transaction id back
  // to our row, so the partial multikey pair is the lookup (§11.1, §14.4).
  {
    collection: COLLECTIONS.billingTransactions,
    name: "billing_transactions_external_refs",
    keys: [
      ["externalRefs.provider", 1],
      ["externalRefs.id", 1],
    ],
    partialFilterExpression: { externalRefs: { $exists: true } },
  },
  // billing_transactions — the pending-status sweep scans only unsettled rows
  // (§14.4).
  {
    collection: COLLECTIONS.billingTransactions,
    name: "billing_transactions_status_pending",
    keys: [
      ["status", 1],
      ["occurredAt", 1],
    ],
    partialFilterExpression: { status: "pending" },
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
  // tenants — the schema §13.3 unique handle. It is the guard the provisioning
  // collision retry relies on: `generateTenantSlug` owns only the 8-character
  // string, and this index is what makes a duplicate slug impossible even under
  // concurrency (ADR-0260 D2, ADR-0261).
  {
    collection: COLLECTIONS.tenants,
    name: "tenants_slug_unique",
    keys: [["slug", 1]],
    unique: true,
  },
  // tenants — the provisioning fast path reads the caller's owned workspace by
  // `ownerUserId` before it inserts anything (schema §13.3).
  {
    collection: COLLECTIONS.tenants,
    name: "tenants_owner_user",
    keys: [["ownerUserId", 1]],
  },
  // tenants — the admin workspace list reads newest-first per status
  // (schema §13.3).
  {
    collection: COLLECTIONS.tenants,
    name: "tenants_status_created_at",
    keys: [
      ["status", 1],
      ["createdAt", -1],
    ],
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

  // usage_counters — one counter row per (tenant, key, period). This unique
  // index is what makes the entitlement service's conditional `$inc` upsert
  // race-safe: two concurrent first-uses cannot both insert a row, and the
  // loser retries as an update (schema §14.2; ADR-0341).
  {
    collection: COLLECTIONS.usageCounters,
    name: "usage_counters_tenant_key_period_unique",
    keys: [
      ["tenantId", 1],
      ["entitlementKey", 1],
      ["periodKey", 1],
    ],
    unique: true,
  },
  // entitlement_grants — the entitlement service reads every active grant for a
  // key by (tenant, key) window, so the compound index leads with `tenantId`
  // (schema §14.2; ADR-0341).
  {
    collection: COLLECTIONS.entitlementGrants,
    name: "entitlement_grants_tenant_key_valid_from",
    keys: [
      ["tenantId", 1],
      ["entitlementKey", 1],
      ["validFrom", 1],
    ],
  },

  // analytics_daily — one rollup row per (scope, day); the unique index is what
  // makes the nightly job's per-day write idempotent, and it is the index the
  // tenant analytics read uses (`scope.kind`, `scope.id`, `dateKey` range;
  // schema §20.1; ADR-0642). It deliberately does not lead with `tenantId`:
  // the aggregate is identified by `scope`, which is a tenant, an event or the
  // platform, so the collection is not one of `TENANT_SCOPED_COLLECTIONS` and
  // the U1 prefix lint does not apply.
  {
    collection: COLLECTIONS.analyticsDaily,
    name: "analytics_daily_scope_date_unique",
    keys: [
      ["scope.kind", 1],
      ["scope.id", 1],
      ["dateKey", -1],
    ],
    unique: true,
  },
  // analytics_daily — the retention/audit sweep walks the rollups by day.
  {
    collection: COLLECTIONS.analyticsDaily,
    name: "analytics_daily_date",
    keys: [["dateKey", -1]],
  },
];

/** The outcome of a bootstrap run: which indexes were built, repaired and found. */
export interface IndexBootstrapReport {
  /** Names of the indexes created by this run. */
  readonly created: readonly string[];
  /** Names the run found present and already matching their declaration. */
  readonly existing: readonly string[];
  /** Names the run dropped and rebuilt because the definition had drifted. */
  readonly reconciled: readonly string[];
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

/** One live index description, narrowed to the parts a spec can declare. */
interface LiveIndex {
  readonly name: string;
  /** The keys in index order, as the server reports them. */
  readonly key?: Readonly<Record<string, unknown>>;
  readonly unique?: boolean;
  readonly partialFilterExpression?: unknown;
  readonly expireAfterSeconds?: unknown;
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

/**
 * Narrow an untyped driver result to an array.
 *
 * `listIndexes()` is typed `any[]` by the driver, so the result is funnelled
 * through `unknown` and re-narrowed here rather than trusting the broad type.
 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** True when `value` is an object that can be read as a live index. */
function isLiveIndex(value: unknown): value is LiveIndex {
  if (!hasStringName(value)) {
    return false;
  }
  const candidate = value as { readonly key?: unknown };
  return (
    candidate.key === undefined || (typeof candidate.key === "object" && candidate.key !== null)
  );
}

/**
 * Index definitions already present on a collection, keyed by name.
 *
 * A collection that does not exist yet has no indexes: MongoDB answers with a
 * "namespace not found" error, which is treated as an empty map so the caller
 * can proceed to create them.
 */
async function listLiveIndexes(db: Db, collection: string): Promise<Map<string, LiveIndex>> {
  try {
    const raw: unknown = await db.collection(collection).listIndexes().toArray();
    const indexes = new Map<string, LiveIndex>();
    for (const entry of asArray(raw)) {
      if (isLiveIndex(entry)) {
        indexes.set(entry.name, entry);
      }
    }
    return indexes;
  } catch (error) {
    if (isMissingNamespace(error)) {
      return new Map();
    }
    throw error;
  }
}

/**
 * A deterministic rendering of one index-definition fragment.
 *
 * The server reports `partialFilterExpression` with its own key order, so a
 * structural comparison must sort keys to avoid reporting a false drift.
 */
function canonicalDefinition(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    );
  });
}

/**
 * Whether a live index disagrees with its declaration.
 *
 * The comparison covers the whole definition a spec can declare — the ordered
 * key list, uniqueness, the partial filter and the TTL — because MongoDB
 * refuses to change any of them on an existing index: a name-only check leaves
 * a drifted definition live forever (schema §15.2).
 */
function definitionDiffers(spec: IndexSpec, live: LiveIndex): boolean {
  const liveKeys = live.key === undefined ? [] : Object.entries(live.key);
  if (liveKeys.length !== spec.keys.length) {
    return true;
  }
  for (const [position, [field, direction]] of spec.keys.entries()) {
    const liveKey = liveKeys[position];
    if (liveKey?.[0] !== field || Number(liveKey[1]) !== direction) {
      return true;
    }
  }
  if ((live.unique === true) !== (spec.unique === true)) {
    return true;
  }
  if (
    canonicalDefinition(live.partialFilterExpression) !==
    canonicalDefinition(spec.partialFilterExpression)
  ) {
    return true;
  }
  return (live.expireAfterSeconds ?? null) !== (spec.expireAfterSeconds ?? null);
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
 * Create every index in {@link INDEX_SPECS}, reconciling a drifted definition.
 *
 * Idempotent: a second run against the same database creates nothing and
 * reports every declared index as `existing`. An index whose **name** is
 * present but whose **definition** disagrees with its declaration is dropped
 * and rebuilt, because MongoDB refuses to alter an existing index's keys,
 * uniqueness, filter or TTL — a name-only check would leave a drifted
 * definition live forever (schema §15.2). Indexes present in the database but
 * absent from the registry are never dropped: the bootstrap only ever adds or
 * repairs what it declares.
 *
 * @param db - The database to build indexes on.
 * @returns The report of created, reconciled and already-present index names.
 */
export async function ensureIndexes(db: Db): Promise<IndexBootstrapReport> {
  const created: string[] = [];
  const existing: string[] = [];
  const reconciled: string[] = [];

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
    const present = await listLiveIndexes(db, collection);
    for (const spec of specs) {
      const live = present.get(spec.name);
      if (live === undefined) {
        await db
          .collection(collection)
          .createIndex(toIndexSpecification(spec.keys), toIndexOptions(spec));
        created.push(spec.name);
        continue;
      }
      if (!definitionDiffers(spec, live)) {
        existing.push(spec.name);
        continue;
      }
      await db.collection(collection).dropIndex(spec.name);
      await db
        .collection(collection)
        .createIndex(toIndexSpecification(spec.keys), toIndexOptions(spec));
      reconciled.push(spec.name);
    }
  }

  if (created.length > 0) {
    getLogger().info("db.indexes.created", { event: "db.indexes.created", names: created });
  }
  if (reconciled.length > 0) {
    getLogger().info("db.indexes.reconciled", {
      event: "db.indexes.reconciled",
      names: reconciled,
    });
  }

  return { created, existing, reconciled };
}
