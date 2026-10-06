/**
 * Shared redelivery plumbing for the dispatch retry and quiet-hours release
 * crons (OP-96, contract §10.2, ADR-0100).
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

  const userId = typeof target.userId === "string" ? target.userId : target.userId.toHexString();
  const subject = target.subject ?? "";
  const body = target.body ?? "";

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
