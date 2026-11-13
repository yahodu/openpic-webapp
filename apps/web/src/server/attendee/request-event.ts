import type { Db, ObjectId } from "mongodb";

import { getAuth } from "@/server/auth";
import { enforceAuth, resolvePrincipal } from "@/server/auth/guards";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { appError } from "@/server/http/errors";
import type { HandlerContext } from "@/server/http/define-route";
import { platformRepo, tenantRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

import { requireConsent, subjectFilter, type ConsentSubject } from "./consent-guard";
import type { ProfileStatus } from "./status-detail";
import { subjectForRequest } from "./subject";

/**
 * The scope of an attendee request (OP-131/OP-132, contract §6.2/§6.3;
 * ADR-0792).
 *
 * Every attendee route is addressed by the event's **active** access-link slug
 * and answers the same questions before it may look at its own input: which
 * tenant and event, which data subject, and whether that subject holds the
 * biometric consent in force. §6.2 makes consent a hard precondition, so the
 * order lives here once instead of in each of the consent, liveness, selfie and
 * reuse handlers — a route cannot check consent after reading its own body.
 */

/** The `events` fields the slug lookup reads (schema §15.1). */
interface EventRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly retentionExpiresAt?: Date | null;
}

/** The event one attendee call addresses. */
export interface ResolvedEvent {
  readonly db: Db;
  /** The event's tenant (hex, as the event row stores it). */
  readonly tenantKey: string;
  readonly eventId: ObjectId;
  /** The event's own retention deadline, or `null` when the plan is unlimited. */
  readonly retentionExpiresAt: Date | null;
}

/** A path segment's index counted from the end of the request path. */
export function pathSegmentFromRequest(request: Request, segmentFromEnd: number): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-segmentFromEnd) ?? "";
}

/**
 * The `{slug}` path segment of the request, counted from the end of the path.
 *
 * The route template is not part of the handler's `Request`, so the slug is read
 * by position: `…/{slug}/consent` is two segments from the end,
 * `…/{slug}/liveness/challenges` three, and so on.
 *
 * @param request - The inbound request.
 * @param segmentFromEnd - The slug's position from the path's end.
 * @returns The segment, or `""` when the path is shorter than expected.
 */
export function slugFromRequest(request: Request, segmentFromEnd = 2): string {
  return pathSegmentFromRequest(request, segmentFromEnd);
}

/**
 * Resolve the event a request addresses through an **active** access link.
 *
 * @param db - The database to read `events` from.
 * @param slug - The requested slug.
 * @returns The event's tenant and id.
 * @throws {AppError} `not_found` when no active link carries the slug.
 */
export async function resolveEventBySlug(db: Db, slug: string): Promise<ResolvedEvent> {
  const event =
    slug === ""
      ? null
      : ((await platformRepo(db)
          .collection(COLLECTIONS.events)
          .findOne(
            { accessLinks: { $elemMatch: { slug, active: true } } },
            { projection: { _id: 1, tenantId: 1, retentionExpiresAt: 1 } }
          )) as EventRow | null);
  if (event === null) {
    throw appError("not_found", { details: { resource: "event" } });
  }
  return {
    db,
    tenantKey: event.tenantId,
    eventId: event._id,
    retentionExpiresAt: event.retentionExpiresAt ?? null,
  };
}

/** What one attendee request resolves to, in contract order. */
export interface AttendeeScope {
  /** The shared database handle. */
  readonly db: Db;
  /** The event's active access-link slug, as addressed. */
  readonly slug: string;
  /** The event the request addresses. */
  readonly event: ResolvedEvent;
  /** The data subject behind the request. */
  readonly subject: ConsentSubject;
  /** The consent in force, which the grant path links to the profile. */
  readonly consentId: ObjectId;
}

/** Options accepted by {@link requireAttendeeScope}. */
export interface AttendeeScopeOptions {
  /**
   * The `{slug}` segment's position counted from the end of the path; two (the
   * default) for `…/{slug}/consent`, three for `…/{slug}/liveness/challenges`.
   */
  readonly slugFromEnd?: number;
}

/**
 * Resolve the scope of one attendee request, refusing without consent.
 *
 * @param ctx - The handler context, for the request and the principal.
 * @param options - Where the slug sits in the path.
 * @returns The database, slug, event, subject and consent id.
 * @throws {AppError} `not_found` for no active access link,
 *   `authentication_required` for no credential, and `consent_required` (412)
 *   when the subject holds no consent in force for the addressed event.
 */
export async function requireAttendeeScope(
  ctx: HandlerContext,
  options: AttendeeScopeOptions = {}
): Promise<AttendeeScope> {
  const db = getDb();
  const slug = slugFromRequest(ctx.request, options.slugFromEnd);
  const event = await resolveEventBySlug(db, slug);
  const subject = await subjectForRequest(db, ctx.request, ctx.principal);
  const { consentId } = await requireConsent({
    db,
    tenantKey: event.tenantKey,
    eventId: event.eventId,
    subject,
  });
  return { db, slug, event, subject, consentId };
}

/**
 * Resolve the `attendee` credential of one request (contract §0.2, Appendix A.1).
 *
 * The OP-133 read routes resolve the addressed event **before** the credential:
 * an unknown slug answers `404` whatever the caller presented (§0.4), while a
 * known slug without a credential answers `401`. That order cannot be expressed
 * as a pipeline stage (the stage runs before the handler), so the guard's own
 * pieces run here.
 *
 * @param ctx - The handler context, for the request and the route.
 * @param db - The database the session resolvers read.
 * @returns The data subject behind the request.
 * @throws {AppError} `authentication_required` (401) and the account-state
 *   refusals the `attendee` label applies.
 */
export async function requireAttendeeSubject(ctx: HandlerContext, db: Db): Promise<ConsentSubject> {
  const principal = await resolvePrincipal(ctx.request, { auth: getAuth(), database: db });
  enforceAuth("attendee", { principal, now: systemClock.now() }, ctx.request, ctx.route);
  return subjectForRequest(
    db,
    ctx.request,
    principal !== null && principal.kind === "user" ? principal.userId : undefined
  );
}

/** A stored `attendeeEventProfiles` row, as the attendee read routes use it (§15.3). */
export interface AttendeeProfileRow {
  readonly _id: ObjectId;
  readonly status: ProfileStatus;
  readonly activeSelfieId: ObjectId | null;
  readonly matchCount: number;
  readonly lastMatchRunAt?: Date | null;
  readonly lastSeenGalleryAt?: Date | null;
  readonly subject: Record<string, unknown>;
}

/** One attendee read's scope: the event facts plus the caller's own profile. */
export interface AttendeeProfileScope extends AttendeeScope {
  readonly profile: AttendeeProfileRow;
}

/**
 * Resolve the attendee's own `attendeeEventProfiles` row for the addressed
 * event (OP-133, contract §6.4/§6.5/§6.6).
 *
 * Every attendee read is "about my profile in this event", and the profile is
 * what the gallery, the poll and the hide/seen writes are keyed on, so the
 * lookup lives next to the scope it belongs to.
 *
 * @param ctx - The handler context, for the request and the route.
 * @param options - Where the slug sits in the path.
 * @returns The scope plus the caller's profile row.
 * @throws {AppError} `not_found` for no active access link or no profile,
 *   `authentication_required` for no credential, and `consent_required` (412)
 *   when the subject holds no consent in force for the addressed event.
 */
export async function requireAttendeeProfile(
  ctx: HandlerContext,
  options: AttendeeScopeOptions = {}
): Promise<AttendeeProfileScope> {
  const db = getDb();
  const slug = slugFromRequest(ctx.request, options.slugFromEnd);
  const event = await resolveEventBySlug(db, slug);
  const subject = await requireAttendeeSubject(ctx, db);
  const { consentId } = await requireConsent({
    db,
    tenantKey: event.tenantKey,
    eventId: event.eventId,
    subject,
  });
  const profile = (await tenantRepo(event.tenantKey, db)
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({
      eventId: event.eventId,
      ...subjectFilter(subject),
    })) as AttendeeProfileRow | null;
  if (profile === null) {
    throw appError("not_found", { details: { resource: "profile" } });
  }
  return { db, slug, event, subject, consentId, profile };
}
