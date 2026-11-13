import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo, tenantRepo } from "@/server/repos";
import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

/**
 * The attendee's download job (OP-133; contract §6.6; ADR-0794 §5).
 *
 * §6.6 splits the work: the API answers `202` with a job id and the build runs
 * elsewhere, so one row is the whole contract between the two. The row is
 * addressed by its id alone (`GET /p/downloads/{id}` carries no event), so it
 * lives in a platform-scope collection like `attendeeSessions` — with
 * `tenantId` carried as data for the worker and for a future purge, never as a
 * query scope. Ownership is still checked against the caller's profile in the
 * job's own tenant, so the unguessable id is never the authorization.
 */

/** The poll cadence §6.6 gives a queued job. */
export const DOWNLOAD_POLL_MS = 3_000;

/** How long a finished job (and its link) stays readable (§6.6). */
export const DOWNLOAD_JOB_TTL_SECONDS = 24 * 60 * 60;

/**
 * How many times one finished link may be downloaded.
 *
 * shortcut: a fixed cap, because no plan entitlement pins this yet; move it to
 * the plan when the download worker lands and the first plan documents a limit.
 */
export const DOWNLOAD_LINK_DOWNLOADS = 3;

/** The `downloadJobs.status` values (§6.6). */
export type DownloadJobStatus = "queued" | "building" | "ready" | "failed" | "expired";

/** What a download request asks for (§6.6). */
export type DownloadScope = "all_matches" | "selected";

/** The media quality a job packages (§6.6). */
export type DownloadQuality = "original" | "thumbnail";

/** A stored `downloadJobs` row, as its reader sees it. */
export interface DownloadJobRow {
  readonly _id: ObjectId;
  readonly tenantId: string;
  readonly eventId: ObjectId;
  readonly profileId: ObjectId;
  readonly kind: "attendee" | "organizer";
  readonly scope: DownloadScope;
  readonly quality: DownloadQuality;
  readonly status: DownloadJobStatus;
  readonly fileCount?: number;
  readonly bytes?: number;
  readonly url?: string | null;
  readonly urlExpiresAt?: Date | null;
  readonly downloadsRemaining?: number;
  readonly expireAt: Date;
  readonly createdAt: Date;
}

/** The §6.6 status body. */
export interface DownloadStatusBody {
  readonly downloadId: string;
  readonly status: DownloadJobStatus;
  readonly fileCount: number;
  readonly bytes: number;
  readonly url: string | null;
  readonly expiresAt: string | null;
  readonly downloadsRemaining: number;
  readonly createdAt: string;
}

/**
 * Project a stored job onto the §6.6 status body.
 *
 * @param job - The stored row.
 * @returns The five status facts plus the link, when there is one.
 */
export function downloadStatusBody(job: DownloadJobRow): DownloadStatusBody {
  return {
    downloadId: job._id.toHexString(),
    status: job.status,
    fileCount: job.fileCount ?? 0,
    bytes: job.bytes ?? 0,
    url: job.url ?? null,
    expiresAt:
      job.urlExpiresAt === undefined || job.urlExpiresAt === null
        ? null
        : job.urlExpiresAt.toISOString(),
    downloadsRemaining: job.downloadsRemaining ?? DOWNLOAD_LINK_DOWNLOADS,
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * Read one job by its id.
 *
 * @param db - The database to read from.
 * @param downloadId - The id the client polled.
 * @returns The stored row, or `null` when no job carries the id.
 */
export async function findDownloadJob(db: Db, downloadId: string): Promise<DownloadJobRow | null> {
  if (!ObjectId.isValid(downloadId)) {
    return null;
  }
  return (await platformRepo(db)
    .collection(COLLECTIONS.downloadJobs)
    .findOne({ _id: new ObjectId(downloadId) })) as DownloadJobRow | null;
}

/**
 * Whether the caller's own profile in the job's tenant is the job's owner.
 *
 * A stranger's id and an unknown id answer the same way (§0.4), so the check is
 * `true`/`false` and the route turns both refusals into one `404`.
 *
 * @param db - The database to read from.
 * @param job - The stored job.
 * @param profileId - The caller's profile id for the job's event.
 * @returns `true` only when the two ids name the same profile.
 */
export function ownsJob(job: DownloadJobRow, profileId: ObjectId | null): boolean {
  return profileId !== null && job.profileId.equals(profileId);
}

/**
 * The caller's profile id for one event, when they have one.
 *
 * @param db - The database to read from.
 * @param job - The job whose tenant and event scope the lookup.
 * @param subjectFilter - The stored `subject` predicate of the caller.
 * @returns The profile id, or `null` when the caller has no profile there.
 */
export async function callerProfileId(
  db: Db,
  job: DownloadJobRow,
  subjectFilter: Readonly<Record<string, unknown>>
): Promise<ObjectId | null> {
  const profile = (await tenantRepo(job.tenantId, db)
    .collection(COLLECTIONS.attendeeEventProfiles)
    .findOne({ eventId: job.eventId, ...subjectFilter }, { projection: { _id: 1 } })) as {
    readonly _id: ObjectId;
  } | null;
  return profile === null ? null : profile._id;
}
