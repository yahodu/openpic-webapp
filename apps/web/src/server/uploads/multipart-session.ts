import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { eventIdFromRequest } from "@/server/events/event-id";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { isStorageLocationKey, type StorageLocationKey } from "@/server/storage/locations";

import { getHandleService, resolveMultipartHandle } from "./multipart-handle";

/**
 * Loading the upload a multipart call addresses (OP-125, contract §5.4).
 *
 * The four calls after `create` share one preamble: the session is found by the
 * provider's upload id, and the `key` the client presented must prove ownership
 * of **that** session before anything else is read. Doing it once here keeps
 * every route's refusal identical — an unknown upload id and a forged token are
 * the same `404`.
 */

/** The `upload_sessions` fields a multipart call reads (§16.2). */
export interface MultipartSessionRow {
  readonly _id: ObjectId;
  readonly contentHash: string;
  readonly batchId: ObjectId | string;
  readonly fileName: string;
  readonly declaredSize: number;
  readonly declaredMimeType: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly expireAt: Date;
  readonly externalRefs: readonly { readonly kind: string; readonly id: string }[];
}

/** One inbound multipart call. */
export interface MultipartCall {
  readonly db: Db;
  /** The workspace whose session is addressed. */
  readonly tenantKey: string;
  readonly request: Request;
  /** The authenticated caller presenting the handle. */
  readonly principal: string;
  /** How far from the path's end the event id sits (§5.4). */
  readonly eventIdFromEnd: number;
  /** How far from the path's end the provider upload id sits. */
  readonly uploadIdFromEnd: number;
  /**
   * The handle when the call carries it in the body (`complete`), instead of
   * the `key` query parameter the other three hooks use.
   */
  readonly handle?: string;
}

/** The session a call addresses, bound to the handle the caller presented. */
export interface BoundMultipartUpload {
  readonly session: MultipartSessionRow;
  /** The provider's multipart id, as the path and the session spell it. */
  readonly uploadId: string;
  readonly locationKey: StorageLocationKey;
  readonly objectKey: string;
}

/**
 * Read one path segment, counting from the end.
 *
 * @param request - The inbound request.
 * @param fromEnd - `1` for the last segment.
 * @returns The raw segment.
 * @throws {AppError} `not_found` when the segment is absent.
 */
function pathSegment(request: Request, fromEnd: number): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const raw = segments.at(-fromEnd);
  if (raw === undefined || raw === "") {
    throw appError("not_found");
  }
  return raw;
}

/**
 * Load the session behind `{uploadId}` and verify the presented handle.
 *
 * @param call - The workspace, the request, the caller and both path offsets.
 * @returns The session, the provider id and the object key the handle resolves.
 * @throws {AppError} `not_found` for an upload id this event does not hold or a
 *   handle that does not prove ownership of it.
 */
export async function loadMultipartUpload(call: MultipartCall): Promise<BoundMultipartUpload> {
  const eventId = eventIdFromRequest(call.request, { segmentFromEnd: call.eventIdFromEnd });
  const uploadId = pathSegment(call.request, call.uploadIdFromEnd);

  const session = (await tenantRepo(call.tenantKey, call.db)
    .collection(COLLECTIONS.uploadSessions)
    .findOne({
      eventId,
      externalRefs: { $elemMatch: { kind: "multipart_upload", id: uploadId } },
    })) as MultipartSessionRow | null;
  if (session === null) {
    throw appError("not_found");
  }

  const handle = call.handle ?? new URL(call.request.url).searchParams.get("key") ?? "";
  const resolved = resolveMultipartHandle({
    service: getHandleService(),
    handle,
    presentingUserId: call.principal,
    uploadSessionId: session._id.toHexString(),
  });
  if (!isStorageLocationKey(resolved.locationKey)) {
    // A handle can only have been minted for a §11.2 location; anything else is
    // not an upload this surface serves.
    throw appError("not_found");
  }

  return {
    session,
    uploadId,
    locationKey: resolved.locationKey,
    objectKey: resolved.objectKey,
  };
}

/**
 * The provider's multipart id recorded on one session, or `null`.
 *
 * @param session - A session row (or any value carrying its external refs).
 * @returns The id inside its `multipart_upload` external ref.
 */
export function multipartUploadIdOf(session: {
  readonly externalRefs: readonly { readonly kind: string; readonly id: string }[];
}): string | null {
  const ref = session.externalRefs.find((candidate) => candidate.kind === "multipart_upload");
  return ref === undefined ? null : ref.id;
}
