import { createHash, randomUUID } from "node:crypto";

import { Binary, ObjectId } from "mongodb";

import * as attendeeSessionsRouteModule from "@/app/api/v1/p/attendee-sessions/route";
import * as consentRouteModule from "@/app/api/v1/p/events/[slug]/consent/route";
import * as livenessRouteModule from "@/app/api/v1/p/events/[slug]/liveness/challenges/route";
import * as selfieSubmitRouteModule from "@/app/api/v1/p/events/[slug]/selfies/route";
import * as selfieReuseRouteModule from "@/app/api/v1/p/events/[slug]/selfies:reuse/route";
import * as selfieConfirmRouteModule from "@/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route";
import * as selfieUploadsRouteModule from "@/app/api/v1/p/events/[slug]/selfies/uploads/route";
import * as reusableSelfiesRouteModule from "@/app/api/v1/p/selfies/reusable/route";
import * as testStorageRouteModule from "@/app/api/v1/test-support/storage/[token]/route";
import { ATTENDEE_COOKIE_NAME } from "@/server/attendee/session-cookie";
import { hashAttendeeSessionToken } from "@/server/attendee/session-token";
import { COLLECTIONS } from "@/server/db/collections";
import { getWorkQueue } from "@/server/queue/get-work-queue";
import type { MemoryQueuedMessage, MemoryWorkQueue } from "@/server/adapters/memory-queue";

import { cookiePair, setCookies } from "./auth-requests";
import { APP_ORIGIN, makeIdentity, type SignedInUser, type TestApp } from "./authed-app";

/**
 * Shared fixture flow for the OP-132 liveness + selfie suites.
 *
 * Every case in the three specs needs the same seven handles: a tenant with one
 * published event and an active access link, a real anonymous attendee session,
 * a granted consent, a liveness challenge, an uploaded object, a submitted
 * selfie and — for the confirmation cases — a worker that has already written
 * its result. Building them once keeps each spec about the behaviour it pins
 * and keeps the stored shapes the implementation's own, never a hand-rolled
 * document that could drift from the real write path.
 *
 * Nothing here asserts: a helper that cannot build its fixture throws with the
 * step it failed at, so a spec never mistakes a broken fixture for a refusal.
 *
 * Route modules are reached by their **intended paths** (they do not exist until
 * the GREEN lands), so a missing module is an honest load failure and a missing
 * export is named explicitly by {@link requireHandler}.
 */

/* ───────────────────────────── route handlers ────────────────────────────── */

/** A `Request`-in, `Response`-out route handler. */
export type RouteHandler = (request: Request) => Promise<Response>;

/** Read a route export off a module namespace, failing with a naming message. */
export function requireHandler(
  module: object,
  name: "GET" | "POST" | "PUT" | "DELETE",
  path: string
): RouteHandler {
  const handler: unknown = Reflect.get(module, name);
  if (typeof handler !== "function") {
    throw new Error(`expected ${path} to export a ${name} handler`);
  }
  return handler as RouteHandler;
}

/** The routes these suites drive, resolved once. */
export const handlers = {
  createSession: requireHandler(attendeeSessionsRouteModule, "POST", "/api/v1/p/attendee-sessions"),
  grantConsent: requireHandler(consentRouteModule, "POST", "/api/v1/p/events/:slug/consent"),
  withdrawConsent: requireHandler(consentRouteModule, "DELETE", "/api/v1/p/events/:slug/consent"),
  challenge: requireHandler(
    livenessRouteModule,
    "POST",
    "/api/v1/p/events/:slug/liveness/challenges"
  ),
  presignSelfie: requireHandler(
    selfieUploadsRouteModule,
    "POST",
    "/api/v1/p/events/:slug/selfies/uploads"
  ),
  submitSelfie: requireHandler(selfieSubmitRouteModule, "POST", "/api/v1/p/events/:slug/selfies"),
  confirmSelfie: requireHandler(
    selfieConfirmRouteModule,
    "POST",
    "/api/v1/p/events/:slug/selfies/:selfieId/confirm"
  ),
  reuseSelfie: requireHandler(
    selfieReuseRouteModule,
    "POST",
    "/api/v1/p/events/:slug/selfies:reuse"
  ),
  reusableSelfies: requireHandler(reusableSelfiesRouteModule, "GET", "/api/v1/p/selfies/reusable"),
  /** The test-only storage `PUT` the memory adapter's presigned URL points at. */
  putObject: requireHandler(testStorageRouteModule, "PUT", "/api/v1/test-support/storage/:token"),
} as const;

/* ──────────────────────────────── requests ───────────────────────────────── */

/** Options every request these suites build shares. */
export interface CallOptions {
  /** The caller's credential: the `op_att` cookie or a signed-in session cookie. */
  readonly cookie?: string;
  /** The client address the call is attributed to (unique per case). */
  readonly ip: string;
  /** The JSON body; omitted means "send no body". */
  readonly body?: unknown;
  /** Overrides the generated `Idempotency-Key` (a UUIDv4 by default). */
  readonly idempotencyKey?: string;
  /** Sends a request with no `Idempotency-Key` at all (for a not-yet-required route). */
  readonly withoutIdempotencyKey?: boolean;
}

/** Build the `Request` a route handler is invoked with. */
export function requestFor(path: string, method: string, options: CallOptions): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": options.ip,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.withoutIdempotencyKey === true
      ? {}
      : { "idempotency-key": options.idempotencyKey ?? randomUUID() }),
  };
  return new Request(new URL(path, APP_ORIGIN), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** Parse a success body, failing loudly when the status is not the expected one. */
export async function bodyOf(
  response: Response,
  expectedStatus: number,
  label: string
): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.status !== expectedStatus) {
    throw new Error(
      `expected ${String(expectedStatus)} from ${label}, received ${String(response.status)}: ${JSON.stringify(parsed)}`
    );
  }
  return parsed;
}

/** The `error` block of a refusal body. */
export async function errorBody(
  response: Response
): Promise<{ code: string; message?: string; details?: Record<string, unknown> }> {
  const parsed = (await response.json()) as Record<string, unknown>;
  const envelope = parsed.error;
  if (envelope === null || typeof envelope !== "object") {
    throw new Error(
      `expected a refusal body with an \`error\` object, received ${JSON.stringify(parsed)}`
    );
  }
  return envelope as { code: string; message?: string; details?: Record<string, unknown> };
}

/** The sorted own keys of a JSON object, or `[]` for a non-object. */
export function keysOf(value: unknown): string[] {
  return value !== null && typeof value === "object" ? Object.keys(value).sort() : [];
}

/** A monotonically-increasing client address, so no two calls share a bucket. */
let ipSeq = 0;

/** A client address no other case has used. */
export function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${String(ipSeq % 250)}`;
}

/* ──────────────────────────────── seeding ────────────────────────────────── */

/** One seeded event: its id, its active access-link slug and its name. */
export interface SeededEvent {
  readonly id: ObjectId;
  readonly slug: string;
  readonly name: string;
}

/** A tenant, its owner and one published event. */
export interface SeededTenantEvent {
  readonly tenantKey: string;
  readonly owner: SignedInUser;
  readonly event: SeededEvent;
}

/** A monotonically-increasing unique access-link slug for seeded events. */
let slugSeq = 0;

/** A unique active access-link slug. */
function nextSlug(prefix: string): string {
  slugSeq += 1;
  return `${prefix}${String(slugSeq).padStart(6, "0")}`;
}

/**
 * Insert a stored `events` row (schema §15.1) with one active access link.
 *
 * @param app - The booted test app.
 * @param tenantKey - The owning tenant (hex, as the create route stores it).
 * @param ownerUserId - The organizer's user id (hex).
 * @param prefix - The suite's slug prefix, so a captured slug is traceable.
 * @returns The event id and its active slug.
 */
export async function seedEvent(
  app: TestApp,
  tenantKey: string,
  ownerUserId: string,
  prefix: string
): Promise<SeededEvent> {
  const _id = new ObjectId();
  const now = new Date("2026-01-02T00:00:00.000Z");
  const slug = nextSlug(prefix);
  const name = "Rahul & Priya's Wedding";

  await app.db.collection(COLLECTIONS.events).insertOne({
    _id,
    tenantId: tenantKey,
    name,
    description: "",
    status: "published",
    startAt: new Date("2026-11-14T12:00:00.000Z"),
    endAt: new Date("2026-11-15T04:00:00.000Z"),
    displayTimeZone: "Asia/Kolkata",
    // Open: the selfie routes refuse a closed upload window (contract §6.3).
    uploadWindowEndsAt: new Date("2027-01-31T04:00:00.000Z"),
    retentionExpiresAt: new Date("2027-02-14T18:00:00.000Z"),
    accessLinks: [{ slug, active: true, createdAt: now, revokedAt: null, scanCount: 0 }],
    counters: {
      imageCount: 0,
      processedImageCount: 0,
      failedImageCount: 0,
      attendeeCount: 0,
      matchCount: 0,
      storageBytes: 0,
    },
    sequence: 1,
    logoAssetId: null,
    watermarkAssetId: null,
    createdByUserId: ownerUserId,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  });
  return { id: _id, slug, name };
}

/**
 * Seed a tenant owned by a fresh signed-in user, with one published event.
 *
 * @param app - The booted test app.
 * @param prefix - The suite-local identity/slug prefix.
 * @param eventCount - How many events to publish (a reuse case needs two).
 * @returns The tenant key, the owner and the events, in creation order.
 */
export async function seedTenant(
  app: TestApp,
  prefix: string,
  eventCount = 1
): Promise<{ tenantKey: string; owner: SignedInUser; events: readonly SeededEvent[] }> {
  const owner = await app.signIn(makeIdentity(prefix));
  await app.db
    .collection(COLLECTIONS.userProfiles)
    .updateOne(
      { userId: owner.userId },
      { $set: { accountCompletedAt: new Date(), displayName: "Organizer", updatedAt: new Date() } }
    );
  const tenantId = new ObjectId();
  await app.db.collection(COLLECTIONS.tenants).insertOne({
    _id: tenantId,
    slug: `op132-${prefix}`,
    name: "Rahul Studio",
    status: "active",
    ownerUserId: owner.userId,
    billingContactUserId: owner.userId,
    dataRegion: "in",
    counters: {
      eventCount: eventCount,
      activeEventCount: eventCount,
      imageCount: 0,
      storageBytes: 0,
      attendeeCount: 0,
      reconciledAt: null,
    },
    settings: {
      defaultTimeZone: "Asia/Kolkata",
      brandLogoAssetId: null,
      defaultWatermarkAssetId: null,
    },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schemaVersion: 1,
  });
  await app.db.collection(COLLECTIONS.tenantMembers).insertOne({
    tenantId,
    userId: owner.userId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });

  const tenantKey = tenantId.toHexString();
  const events: SeededEvent[] = [];
  for (let index = 0; index < eventCount; index += 1) {
    events.push(await seedEvent(app, tenantKey, owner.userId.toHexString(), prefix));
  }
  return { tenantKey, owner, events };
}

/* ──────────────────────────── attendee sessions ──────────────────────────── */

/** The cookie and stored id of a real anonymous attendee session. */
export interface AttendeeSession {
  readonly cookie: string;
  readonly sessionId: string;
}

/**
 * Create a real anonymous attendee session through the shipped route.
 *
 * @param app - The booted test app.
 * @param ip - The client address to attribute the call to (the class is
 *   fail-closed, so an unattributable caller is refused before the handler).
 * @returns The `op_att` cookie to replay and the stored session id.
 */
export async function createAttendeeSession(app: TestApp, ip: string): Promise<AttendeeSession> {
  const response = await handlers.createSession(
    requestFor("/api/v1/p/attendee-sessions", "POST", {
      ip,
      body: {},
      withoutIdempotencyKey: true,
    })
  );
  if (response.status !== 201) {
    throw new Error(
      `expected 201 from the attendee-session route, received ${String(response.status)}`
    );
  }
  const header = setCookies(response).find((cookie) => cookie.startsWith(ATTENDEE_COOKIE_NAME));
  if (header === undefined) {
    throw new Error("the attendee-session route did not set an op_att cookie");
  }
  const cookie = cookiePair(header);
  const token = cookie.slice(`${ATTENDEE_COOKIE_NAME}=`.length);
  const row = await app.db
    .collection(COLLECTIONS.attendeeSessions)
    .findOne({ tokenHash: hashAttendeeSessionToken(token) });
  if (row === null) {
    throw new Error("expected the attendee session row to exist");
  }
  return { cookie, sessionId: String(row._id) };
}

/* ───────────────────────────────── consent ───────────────────────────────── */

/** The biometric policy version the settings default to (contract §6.1). */
export const POLICY_VERSION = "biometric-2026-03";

/**
 * Grant biometric consent for one event, through the shipped route.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential and client address.
 * @returns The `201` body.
 */
export async function grantConsent(
  slug: string,
  options: { readonly cookie: string; readonly ip: string }
): Promise<Record<string, unknown>> {
  const response = await handlers.grantConsent(
    requestFor(`/api/v1/p/events/${slug}/consent`, "POST", {
      cookie: options.cookie,
      ip: options.ip,
      body: {
        purpose: "biometric_processing",
        policyVersion: POLICY_VERSION,
        granted: true,
        ageConfirmed: true,
      },
      withoutIdempotencyKey: true,
    })
  );
  return bodyOf(response, 201, `POST consent on ${slug}`);
}

/**
 * Withdraw biometric consent for one event, through the shipped route.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential and client address.
 * @returns The `204` response, so a caller can read `X-Deleted-Counts`.
 */
export async function withdrawConsent(
  slug: string,
  options: { readonly cookie: string; readonly ip: string }
): Promise<Response> {
  return handlers.withdrawConsent(
    requestFor(`/api/v1/p/events/${slug}/consent`, "DELETE", {
      cookie: options.cookie,
      ip: options.ip,
      withoutIdempotencyKey: true,
    })
  );
}

/* ──────────────────────────── liveness challenge ─────────────────────────── */

/** The §6.3 challenge `201` body, as the follow-up calls read it. */
export interface IssuedChallenge {
  readonly challengeId: string;
  readonly challengeKind: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

/**
 * Issue one liveness challenge through the shipped route.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential and client address.
 * @returns The stored challenge id and its evidence-binding nonce.
 */
export async function issueChallenge(
  slug: string,
  options: { readonly cookie: string; readonly ip: string }
): Promise<IssuedChallenge> {
  const response = await handlers.challenge(
    requestFor(`/api/v1/p/events/${slug}/liveness/challenges`, "POST", {
      cookie: options.cookie,
      ip: options.ip,
      body: {},
      withoutIdempotencyKey: true,
    })
  );
  const body = await bodyOf(response, 201, `POST liveness challenge on ${slug}`);
  const { challengeId, challengeKind, nonce, expiresAt } = body;
  if (typeof challengeId !== "string" || typeof nonce !== "string") {
    throw new Error(
      `expected the challenge body to carry challengeId and nonce: ${JSON.stringify(body)}`
    );
  }
  if (typeof challengeKind !== "string" || typeof expiresAt !== "string") {
    throw new Error(
      `expected the challenge body to carry challengeKind and expiresAt: ${JSON.stringify(body)}`
    );
  }
  return { challengeId, challengeKind, nonce, expiresAt };
}

/* ──────────────────────────── selfie upload (PUT) ────────────────────────── */

/** A minimal but real JPEG: SOI, an APP0 JFIF header, then EOI. */
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/**
 * One selfie's bytes, distinct per call so no two cases share a content hash.
 *
 * @param tag - A per-case tag folded into the bytes.
 * @returns The bytes and their lowercase-hex SHA-256.
 */
export function makeSelfieBytes(tag: string): { bytes: Buffer; hash: string } {
  const bytes = Buffer.concat([JPEG_HEADER, Buffer.from(tag, "utf8")]);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

/** A presigned selfie upload, already redeemed at the storage URL. */
export interface UploadedSelfie {
  readonly hash: string;
  readonly size: number;
  readonly mimeType: string;
  /** The presigned-url `201` body, for the envelope pins. */
  readonly presign: Record<string, unknown>;
}

/**
 * Presign, then **PUT the bytes to the storage URL**, exactly as the browser does.
 *
 * The object has to exist before the submit route's `headObject` verification,
 * and the only honest way to put it there is the URL the route itself minted.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential, client address and the image bytes.
 * @returns The declared hash/size/mime and the presign body.
 */
export async function uploadSelfie(
  slug: string,
  options: {
    readonly cookie: string;
    readonly ip: string;
    readonly bytes: Buffer;
    readonly hash: string;
    readonly mimeType?: string;
  }
): Promise<UploadedSelfie> {
  const mimeType = options.mimeType ?? "image/jpeg";
  const presignResponse = await handlers.presignSelfie(
    requestFor(`/api/v1/p/events/${slug}/selfies/uploads`, "POST", {
      cookie: options.cookie,
      ip: options.ip,
      body: { hash: options.hash, size: options.bytes.byteLength, mimeType },
      withoutIdempotencyKey: true,
    })
  );
  const presign = await bodyOf(presignResponse, 201, `POST selfie uploads on ${slug}`);
  const url = presign.url;
  if (typeof url !== "string") {
    throw new Error(`expected the presign body to carry a url: ${JSON.stringify(presign)}`);
  }
  const put = await handlers.putObject(
    new Request(url, { method: "PUT", body: new Uint8Array(options.bytes) })
  );
  if (put.status !== 200) {
    throw new Error(`expected the presigned PUT to answer 200, received ${String(put.status)}`);
  }
  return { hash: options.hash, size: options.bytes.byteLength, mimeType, presign };
}

/* ─────────────────────────────── submit/confirm ──────────────────────────── */

/** The §6.3 submit body's evidence half. */
export interface LivenessEvidenceBody {
  readonly nonce: string;
  readonly frameHashes: readonly string[];
}

/** The §6.3 submit body. */
export interface SubmitBody {
  readonly hash: string;
  readonly challengeId: string;
  readonly livenessEvidence: LivenessEvidenceBody;
}

/**
 * Build the §6.3 submit body for one upload and one challenge.
 *
 * @param upload - The redeemed upload.
 * @param challenge - The challenge the evidence is bound to.
 * @param overrides - What a case varies (a mismatched nonce, missing evidence).
 * @returns The body the submit route validates.
 */
export function submitBody(
  upload: { readonly hash: string },
  challenge: IssuedChallenge,
  overrides: Partial<SubmitBody> = {}
): SubmitBody {
  return {
    hash: upload.hash,
    challengeId: challenge.challengeId,
    livenessEvidence: {
      nonce: challenge.nonce,
      frameHashes: [
        createHash("sha256").update(`${challenge.nonce}:0`).digest("hex"),
        createHash("sha256").update(`${challenge.nonce}:1`).digest("hex"),
        createHash("sha256").update(`${challenge.nonce}:2`).digest("hex"),
      ],
    },
    ...overrides,
  };
}

/** Submit one selfie (the §6.3 `POST …/selfies`), returning the raw response. */
export async function submitSelfie(
  slug: string,
  options: CallOptions & { readonly body: unknown }
): Promise<Response> {
  return handlers.submitSelfie(requestFor(`/api/v1/p/events/${slug}/selfies`, "POST", options));
}

/** Confirm one submitted selfie (the two-step activation), returning the raw response. */
export async function confirmSelfie(
  slug: string,
  selfieId: string,
  options: CallOptions
): Promise<Response> {
  return handlers.confirmSelfie(
    requestFor(`/api/v1/p/events/${slug}/selfies/${selfieId}/confirm`, "POST", {
      ...options,
      body: options.body ?? {},
    })
  );
}

/** The handles a submitted selfie leaves behind. */
export interface SubmittedSelfie {
  readonly selfieId: string;
  readonly profileId: string;
  /** The `202` body. */
  readonly body: Record<string, unknown>;
}

/**
 * Drive the whole happy path: challenge → presign → PUT → submit.
 *
 * @param slug - The event's active access-link slug.
 * @param options - The caller's credential, client address and a per-case tag.
 * @returns The selfie and profile ids and the `202` body.
 */
export async function submitHappyPath(
  slug: string,
  options: { readonly cookie: string; readonly ip: string; readonly tag: string }
): Promise<SubmittedSelfie> {
  const challenge = await issueChallenge(slug, options);
  const bytes = makeSelfieBytes(options.tag);
  const upload = await uploadSelfie(slug, {
    cookie: options.cookie,
    ip: options.ip,
    bytes: bytes.bytes,
    hash: bytes.hash,
  });
  const response = await submitSelfie(slug, {
    cookie: options.cookie,
    ip: options.ip,
    body: submitBody(upload, challenge),
  });
  const body = await bodyOf(response, 202, `POST selfies on ${slug}`);
  const selfieId = body.selfieId;
  const profileId = body.profileId;
  if (typeof selfieId !== "string" || typeof profileId !== "string") {
    throw new Error(
      `expected the 202 body to carry selfieId and profileId: ${JSON.stringify(body)}`
    );
  }
  return { selfieId, profileId, body };
}

/* ─────────────────────────── simulating the worker ───────────────────────── */

/**
 * Write what the OP-132-lane worker writes once it has embedded a selfie.
 *
 * The queue consumer is a later card, so the specs play it: the `selfies` row
 * carries the face vector and the quality verdict (schema §16.4), `processing`
 * is `done` (§18.2), and one `faceMatches` row per found photo exists (§17.5).
 * The rows deliberately carry **no** publication marker: whether a match is
 * provisional is decided by the two-step submission, not by the row's shape.
 *
 * @param app - The booted test app.
 * @param input - The selfie to finish and how many photos it matched.
 */
export async function finishSelfieWorker(
  app: TestApp,
  input: {
    readonly selfieId: string;
    readonly profileId: string;
    readonly eventId: string;
    readonly tenantKey: string;
    readonly subject: Record<string, unknown>;
    readonly matches: number;
  }
): Promise<void> {
  const selfieId = new ObjectId(input.selfieId);
  const finishedAt = new Date();
  const vector = new Float32Array(512).fill(0.0625);
  const selfie = await app.db
    .collection(COLLECTIONS.selfies)
    .findOne({ _id: selfieId }, { projection: { eventId: 1 } });
  if (selfie === null) {
    throw new Error(`expected a stored selfie ${input.selfieId}`);
  }

  await app.db.collection(COLLECTIONS.selfies).updateOne(
    { _id: selfieId },
    {
      $set: {
        embedding: new Binary(new Uint8Array(vector.buffer), 9),
        spaceKey: "arcface_r100_512",
        quality: {
          faceCount: 1,
          largestFaceBox: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
          blurScore: 0.9,
          brightnessScore: 0.8,
          accepted: true,
          rejectionReason: null,
        },
        liveness: { required: true, passed: true, score: 0.94 },
        "processing.status": "done",
        "processing.finishedAt": finishedAt,
        "processing.durationMs": 1_200,
      },
    }
  );

  const rows = Array.from({ length: input.matches }, (_unused, faceIndex) => ({
    tenantId: input.tenantKey,
    eventId: new ObjectId(input.eventId),
    profileId: new ObjectId(input.profileId),
    subject: input.subject,
    imageId: new ObjectId(),
    faceIndex,
    selfieId,
    similarity: 0.74,
    confidence: "strong",
    spaceKey: "arcface_r100_512",
    modelKey: "antelopev2",
    seenAt: null,
    hiddenAt: null,
    createdAt: finishedAt,
  }));
  if (rows.length > 0) {
    await app.db.collection(COLLECTIONS.faceMatches).insertMany(rows);
  }
}

/* ──────────────────────────────── the queue ──────────────────────────────── */

/**
 * The memory queue the submit route enqueues into (`QUEUE_PROVIDER=memory`).
 *
 * `getWorkQueue()` memoizes per process, so this is the very adapter the route
 * wrote to; reading its `outbox` is how a spec sees the pointer a worker would
 * claim, without a broker.
 *
 * @returns The queue, with its inspectable `outbox`.
 */
export function memoryQueue(): MemoryWorkQueue {
  const queue = getWorkQueue();
  if (queue.provider !== "memory") {
    throw new Error(`expected the memory queue in tests, received ${queue.provider}`);
  }
  return queue as MemoryWorkQueue;
}

/** The queue entries enqueued since `from` was read. */
export function entriesSince(from: number): readonly MemoryQueuedMessage[] {
  return memoryQueue().outbox.slice(from);
}

/** The current `outbox` length — read it *before* the call a case measures. */
export function outboxLength(): number {
  return memoryQueue().outbox.length;
}
