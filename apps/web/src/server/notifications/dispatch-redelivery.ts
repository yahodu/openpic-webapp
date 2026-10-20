/**
 * Shared redelivery plumbing for the dispatch retry and quiet-hours release
 * crons (OP-96, contract §10.2, ADR-0120).
 *
 * A `notification-dispatches` row that is `failed`/retryable or `deferred`
 * carries the rendered copy it must re-send (`subject`/`body`, persisted by the
 * fan-out when the type's `retainBody` allows it) plus the `channel` and
 * `userId`. The destination is deliberately **not** stored in clear text — the
 * ledger keeps only `contactHash` (schema §19.5) — so it is re-resolved from
 * the Better Auth `user` row at redelivery time. This module owns exactly that
 * mechanical half so the retry and release crons share one implementation and
 * one failure classifier.
 */
import type { Db, ObjectId as ObjectIdValue } from "mongodb";
import { ObjectId } from "mongodb";

import { TransportError } from "@/server/adapters/transport-error";
import { getAppEnv } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { platformRepo } from "@/server/repos";

import type {
  MessageTransport,
  OutboundChannel,
  OutboundMessage,
  TransportReceipt,
} from "./message-transport";
import type { ResolvedChannel } from "./resolve-channel";

/** The Better Auth user collection (schema §13.1) — a literal, not `COLLECTIONS.users`. */
const BETTER_AUTH_USER = "user";

/** The classified failure a redelivery attempt records on `lastError`. */
export interface RedeliveryFailure {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;
}

/** A redelivery attempt that succeeded or failed in a classified way. */
export type RedeliveryOutcome =
  | { readonly ok: true; readonly receipt: TransportReceipt }
  | { readonly ok: false; readonly failure: RedeliveryFailure };

/** The persisted facts a redelivery needs to rebuild its message. */
export interface RedeliveryTarget {
  /** The recipient's user id as stored on the dispatch row. */
  readonly userId: ObjectIdValue | null;
  /** The resolved channel the row was dispatched on. */
  readonly channel: ResolvedChannel;
  /** The rendered subject, when the row persisted one. */
  readonly subject: string | null;
  /** The rendered body, when the row persisted one (`retainBody`). */
  readonly body: string | null;
}

/** Classify an error thrown by a transport send into a dispatch `lastError`. */
export function classifyRedeliveryError(error: unknown): RedeliveryFailure {
  if (error instanceof TransportError) {
    return {
      retryable: error.retryable,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { retryable: false, code: "render_error" };
}

/** True for a deliverable outbound channel (never `in_app`). */
function toOutboundChannel(channel: ResolvedChannel): OutboundChannel | null {
  return channel === "email" || channel === "sms" || channel === "whatsapp" ? channel : null;
}

/**
 * Re-resolve a dispatch row's destination from the recipient's `user` document.
 *
 * @param db - The database handle.
 * @param userId - The stored `userId` (`ObjectId` or hex string).
 * @param channel - The resolved channel.
 * @returns The email address / E.164 phone, or `null` when absent or unknown.
 */
export async function resolveDestination(
  db: Db,
  userId: ObjectIdValue | string | null,
  channel: ResolvedChannel
): Promise<string | null> {
  if (userId === null) return null;
  const objectId = typeof userId === "string" ? new ObjectId(userId) : userId;

  const raw: unknown = await platformRepo(db)
    .collection(BETTER_AUTH_USER)
    .findOne({ _id: objectId });
  if (typeof raw !== "object" || raw === null) return null;
  const user = raw as Record<string, unknown>;

  if (channel === "email") {
    const email: unknown = user.email;
    return typeof email === "string" ? email : null;
  }
  if (channel === "sms" || channel === "whatsapp") {
    const phone: unknown = user.phoneNumber;
    return typeof phone === "string" ? phone : null;
  }
  return null;
}

/** Build the outbound message a redelivery re-sends. */
export function buildRedeliveryMessage(
  target: RedeliveryTarget,
  destination: string
): OutboundMessage | null {
  const channel = toOutboundChannel(target.channel);
  if (channel === null || target.userId === null) return null;

  // A `retainBody:false` row persists no body (the one-time code must never
  // reach the ledger). Rebuilding it would produce a subject-only message, so
  // there is nothing deliverable to reconstruct (F4, ADR-0130): the caller
  // classifies the row terminally instead of sending an empty body.
  if (target.body === null) return null;

  const userId = typeof target.userId === "string" ? target.userId : target.userId.toHexString();
  const subject = target.subject ?? "";
  const body = target.body;

  if (channel === "email") {
    return {
      channel,
      to: { userId, email: destination },
      subject,
      html: body,
      text: body,
    };
  }
  return { channel, to: { userId, phoneE164: destination }, subject, text: body };
}

/**
 * Attempt a redelivery through the injected transport.
 *
 * @param transport - The outbound transport.
 * @param message - The reconstructed message.
 * @returns `{ ok: true, receipt }` or a classified `{ ok: false, failure }`.
 */
export async function sendRedelivery(
  transport: MessageTransport,
  message: OutboundMessage
): Promise<RedeliveryOutcome> {
  try {
    const receipt = await transport.send(message);
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, failure: classifyRedeliveryError(error) };
  }
}

/** A persisted dispatch row a redelivery re-sends (schema §19.5). */
export interface RedeliveryRow extends RedeliveryTarget {
  /** The `notificationDispatches` row id. */
  readonly _id: ObjectIdValue;
  /** The attempts already recorded on the row. */
  readonly attempts: number;
  /**
   * The digest bucket this row was flushed from, when the row records a
   * **digest flush failure** (schema §19.5). A successful redelivery of such a
   * row credits the bucket (`redeliveredAt`) so the daily cap counts the
   * recovered delivery (F1c-r2, ADR-0141). Absent for every non-digest row.
   */
  readonly digestBucketId?: ObjectIdValue | null;
}

/** Write a row's `lastError` transition after a failed redelivery. */
function recordFailure(
  db: Db,
  id: ObjectIdValue,
  attempts: number,
  now: Date,
  failure: RedeliveryFailure
): Promise<unknown> {
  return platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .updateOne(
      { _id: id },
      { $set: { status: "failed", attempts, failedAt: now, lastError: failure } }
    );
}

/**
 * Credit the digest bucket a redelivered row flushes (F1c-r2, ADR-0141).
 *
 * A digest summary that fails retryably closes its bucket
 * (`flushOutcome: "failed"`) while the owning `failed` ledger row carries the
 * rendered copy. When that row is finally redelivered the summary **reaches the
 * recipient**, so the bucket records the delivery instant in `redeliveredAt`;
 * `countFlushedToday` then counts it against `maxDigestEmailsPerDay` exactly
 * like a first-attempt success. Only a bucket that is still the closed flush it
 * links from (`status: "flushed"`) is credited — the update is a no-op
 * otherwise.
 *
 * @param db - The database handle.
 * @param bucketId - The linked `notificationDigests` bucket id.
 * @param now - The redelivery instant (the delivery time).
 * @returns The update result.
 */
function creditDigestBucket(db: Db, bucketId: ObjectIdValue, now: Date): Promise<unknown> {
  return platformRepo(db)
    .collection(COLLECTIONS.notificationDigests)
    .updateOne({ _id: bucketId, status: "flushed" }, { $set: { redeliveredAt: now } });
}

/**
 * Re-send one durable dispatch row and persist its transition.
 *
 * The single implementation both redelivery crons share (the retry sweep and the
 * quiet-hours release always act identically on a row — they differ only in
 * *which* rows they select). Re-resolves the destination, rebuilds the message
 * from the persisted copy, classifies the outcome and writes `sent`/`failed`
 * with the incremented `attempts`. A digest flush's `failed` row (`digestBucketId`)
 * additionally credits its bucket on success (F1c-r2, ADR-0141).
 *
 * @param db - The database handle.
 * @param row - The durable row to re-send.
 * @param now - The run instant (`sentAt` / `failedAt`).
 * @param transport - The outbound transport.
 * @returns `"sent"` when the transport accepted the message, else `"error"`.
 */
export async function redeliverDispatchRow(
  db: Db,
  row: RedeliveryRow,
  now: Date,
  transport: MessageTransport
): Promise<"sent" | "error"> {
  const attempts = row.attempts + 1;

  // A `retainBody:false` row carries no body (F4, ADR-0130): there is nothing
  // to re-send, so the row reaches a terminal, non-retryable classification —
  // exactly like `no_destination` — instead of a subject-only empty message.
  // It therefore leaves the sweep forever.
  if (row.body === null) {
    await recordFailure(db, row._id, attempts, now, {
      retryable: false,
      code: "unretained_body",
    });
    return "error";
  }

  const destination = await resolveDestination(db, row.userId, row.channel);
  if (destination === null) {
    await recordFailure(db, row._id, attempts, now, {
      retryable: false,
      code: "no_destination",
    });
    return "error";
  }

  const message = buildRedeliveryMessage(row, destination);
  if (message === null) return "error";

  const outcome = await sendRedelivery(transport, message);
  if (!outcome.ok) {
    await recordFailure(db, row._id, attempts, now, outcome.failure);
    return "error";
  }

  await platformRepo(db)
    .collection(COLLECTIONS.dispatches)
    .updateOne(
      { _id: row._id },
      {
        $set: {
          status: "sent",
          attempts,
          sentAt: now,
          lastError: null,
          providerRef: {
            provider: "transport",
            env: getAppEnv(),
            messageId: outcome.receipt.providerMessageId,
          },
        },
      }
    );
  // A digest flush's `failed` row reaching the recipient is a digest the
  // recipient now **receives**: credit the bucket so it consumes the daily
  // allowance (F1c-r2, ADR-0141).
  if (row.digestBucketId !== undefined && row.digestBucketId !== null) {
    await creditDigestBucket(db, row.digestBucketId, now);
  }
  return "sent";
}
