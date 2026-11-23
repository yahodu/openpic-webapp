import { ObjectId } from "mongodb";

import { PLATFORM_SETTINGS_DEFAULTS } from "@/server/settings/platform-settings";

/**
 * Fixtures for the OP-139 nightly jobs (contract §10.2; schema §20.1, §20.3).
 *
 * The four jobs read five source collections and one settings singleton, so a
 * spec that hand-builds each row re-types the same shape five times and drifts.
 * Every builder here keeps the *stored* field names of the shipped writers, and
 * every default is the quiet one (no activity, no counters, `active` tenant), so
 * a spec overrides exactly the fact its pin is about.
 *
 * The platform-settings builder is deliberately typed loosely: the OP-139
 * contract adds a `jobs` section the shipped defaults do not carry yet, and a
 * fixture must not depend on a production type that is the GREEN's to widen.
 */

/** The time zone every OP-139 job buckets its calendar day in. */
export const ROLLUP_TIME_ZONE = "Asia/Kolkata";

/** The instant every fixture in this lane is created at: 11:30 IST on 2026-11-17. */
export const ACTIVITY_AT = new Date("2026-11-17T06:00:00.000Z");

/** The `YYYY-MM-DD` day key {@link ACTIVITY_AT} falls in, in IST. */
export const ACTIVITY_DATE_KEY = "2026-11-17";

/**
 * Build a `tenants` row (schema §13.3).
 *
 * `counters.approximate` is the mandatory `true` literal §2.1 requires, and
 * `reconciledAt` starts `null` so `counter-reconcile` has a drift to stamp.
 *
 * @param input - The tenant id and slug, plus any counter overrides.
 * @returns A tenant document, ready for `insertOne`.
 */
export function makeTenantRow(input: {
  readonly _id: ObjectId;
  readonly slug: string;
  readonly counters?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    _id: input._id,
    slug: input.slug,
    name: input.slug,
    status: "active",
    ownerUserId: null,
    billingContactUserId: null,
    dataRegion: "in",
    settings: {
      defaultTimeZone: ROLLUP_TIME_ZONE,
      brandLogoUrl: null,
      defaultWatermarkUrl: null,
    },
    counters: {
      eventCount: 0,
      activeEventCount: 0,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      approximate: true,
      reconciledAt: null,
      ...input.counters,
    },
    createdAt: ACTIVITY_AT,
    updatedAt: ACTIVITY_AT,
  };
}

/** Build an `events` row (schema §13.6): `status` is `draft|published|archived`. */
export function makeEventRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId: string;
  readonly status?: "draft" | "published" | "archived";
  readonly createdAt?: Date;
  readonly counters?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const createdAt = input.createdAt ?? ACTIVITY_AT;
  const _id = input._id ?? new ObjectId();
  return {
    _id,
    tenantId: input.tenantId,
    slug: `event-${_id.toHexString()}`,
    title: "Fixture event",
    status: input.status ?? "published",
    displayTimeZone: ROLLUP_TIME_ZONE,
    counters: {
      imageCount: 0,
      storageBytes: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      ...input.counters,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Build an `event_images` join row (schema §16.1).
 *
 * The row carries its **own** `tenantId` beside the parent `eventId`, which is
 * what makes the `tenantId`/parent disagreement the isolation audit looks for
 * expressible at all.
 */
export function makeEventImageRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly processingStatus?: "queued" | "processing" | "processed" | "failed";
  readonly createdAt?: Date;
  readonly assetId?: ObjectId;
}): Record<string, unknown> {
  const createdAt = input.createdAt ?? ACTIVITY_AT;
  return {
    _id: input._id ?? new ObjectId(),
    tenantId: input.tenantId,
    eventId: input.eventId,
    assetId: input.assetId ?? new ObjectId(),
    uploadedByUserId: new ObjectId(),
    uploadBatchId: new ObjectId(),
    sequence: 1,
    processing: { status: input.processingStatus ?? "queued", attempts: 0 },
    faceCount: 0,
    visibility: "visible",
    createdAt,
    updatedAt: createdAt,
  };
}

/** Build an `attendee_event_profiles` row (schema §15.3). */
export function makeAttendeeProfileRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly matchCount?: number;
  readonly createdAt?: Date;
}): Record<string, unknown> {
  const createdAt = input.createdAt ?? ACTIVITY_AT;
  return {
    _id: input._id ?? new ObjectId(),
    tenantId: input.tenantId,
    eventId: input.eventId,
    subject: { kind: "user", userId: new ObjectId() },
    activeSelfieId: null,
    status: "ready",
    matchCount: input.matchCount ?? 0,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Build a `face_matches` row (schema §15.5) for one profile and image. */
export function makeFaceMatchRow(input: {
  readonly profileId: ObjectId;
  readonly imageId: ObjectId;
  readonly faceIndex?: number;
}): Record<string, unknown> {
  return {
    _id: new ObjectId(),
    profileId: input.profileId,
    imageId: input.imageId,
    faceIndex: input.faceIndex ?? 0,
    score: 0.9,
    createdAt: ACTIVITY_AT,
  };
}

/**
 * Build a `selfies` row (schema §16.4) as `submitSelfie` stores it.
 *
 * `processing.status` defaults to `processed` and `isActive` to `true` (the
 * terminal state of an accepted selfie), so a count of "selfies uploaded" that
 * filters on either field, or on neither, reads the same one row.
 */
export function makeSelfieRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly profileId?: ObjectId;
  readonly processingStatus?: "queued" | "processing" | "processed" | "failed";
  readonly isActive?: boolean;
  readonly createdAt?: Date;
}): Record<string, unknown> {
  const createdAt = input.createdAt ?? ACTIVITY_AT;
  return {
    _id: input._id ?? new ObjectId(),
    tenantId: input.tenantId,
    eventId: input.eventId,
    profileId: input.profileId ?? new ObjectId(),
    subject: { kind: "user", userId: new ObjectId() },
    contentHash: new ObjectId().toHexString(),
    assetId: new ObjectId(),
    liveness: { required: true, challengeKind: "gesture" },
    processing: { status: input.processingStatus ?? "processed", attempts: 0 },
    isActive: input.isActive ?? true,
    createdAt,
    expireAt: new Date(createdAt.getTime() + 30 * 86_400_000),
  };
}

/**
 * Build a `notification_dispatches` row (schema §17.3) in the `sent` terminal
 * state, with `queuedAt` and `sentAt` both on the fixture instant so a rollup
 * that buckets either field reads the same day.
 */
export function makeDispatchRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId?: string | null;
  readonly eventId?: ObjectId | null;
  readonly typeKey?: string;
  readonly createdAt?: Date;
}): Record<string, unknown> {
  const createdAt = input.createdAt ?? ACTIVITY_AT;
  return {
    _id: input._id ?? new ObjectId(),
    userId: new ObjectId(),
    tenantId: input.tenantId ?? null,
    eventId: input.eventId ?? null,
    typeKey: input.typeKey ?? "event.starting_soon",
    channelGroup: "organizer",
    channel: "email",
    status: "sent",
    skipReason: null,
    contactHash: null,
    templateVersion: null,
    dedupeKey: null,
    providerRef: null,
    attempts: 1,
    lastError: null,
    subject: "Fixture dispatch",
    body: "Fixture body",
    until: null,
    queuedAt: createdAt,
    sentAt: createdAt,
    deliveredAt: createdAt,
    failedAt: null,
    notificationId: null,
    createdAt,
    expireAt: new Date(createdAt.getTime() + 180 * 86_400_000),
  };
}

/**
 * Build a `domain_events` outbox row for `event.created` (schema §18.3).
 *
 * The rollup is documented as rolling `domainEvents` as well as the collection
 * counts, so the fixture carries the field the bucketing reads (`occurredAt`)
 * and the dispatch flags the fan-out would have set.
 */
export function makeEventCreatedRow(input: {
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly occurredAt?: Date;
}): Record<string, unknown> {
  const occurredAt = input.occurredAt ?? ACTIVITY_AT;
  return {
    eventKey: "event.created",
    tenantId: input.tenantId,
    actorRef: { kind: "user", id: new ObjectId().toHexString() },
    subjectRef: { kind: "event", id: input.eventId.toHexString() },
    payload: {},
    occurredAt,
    expireAt: new Date(occurredAt.getTime() + 180 * 86_400_000),
    dispatch: { notifications: "done", analytics: "pending", queue: "done" },
  };
}

/**
 * Build a `dataSubjectRequests` row (schema §20.3, OP-138).
 *
 * The shape is the one `POST /api/v1/me/data-requests` writes, so the SLA check
 * reads its fixtures through the same `status` / `slaDueAt` / `scope` fields a
 * real filing carries.
 */
export function makeDsrRow(input: {
  readonly _id?: ObjectId;
  readonly tenantId: string;
  readonly status?: "received" | "verifying" | "in_progress" | "completed" | "rejected";
  readonly slaDueAt: Date;
  readonly requestType?: "access" | "erasure" | "portability";
  readonly receivedAt?: Date;
}): Record<string, unknown> {
  const receivedAt = input.receivedAt ?? ACTIVITY_AT;
  return {
    _id: input._id ?? new ObjectId(),
    requestType: input.requestType ?? "access",
    subject: { kind: "user", userId: new ObjectId() },
    regulation: "dpdpa",
    status: input.status ?? "received",
    slaDueAt: input.slaDueAt,
    scope: { tenantIds: [input.tenantId], eventIds: [] },
    executionLog: [],
    exportAssetId: null,
    completedAt: null,
    rejectionReason: null,
    receivedAt,
    schemaVersion: 1,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
}

/**
 * Build the `platformSettings` singleton with the OP-139 jobs section.
 *
 * `driftThresholdPercent` is the threshold `counter-reconcile` reads: a drift
 * (as a percentage of the recomputed value) **above** it raises one
 * `admin.abuse.flagged`. The rest of the document is the shipped default so the
 * singleton still parses.
 *
 * @param driftThresholdPercent - The configured drift threshold in percent.
 * @returns The singleton document, ready for `insertOne`.
 */
export function makePlatformSettingsDocument(
  driftThresholdPercent: number
): Record<string, unknown> {
  return {
    _id: "singleton",
    ...PLATFORM_SETTINGS_DEFAULTS,
    jobs: { counterReconcile: { driftThresholdPercent } },
    updatedAt: ACTIVITY_AT.toISOString(),
    updatedByUserId: null,
  };
}
