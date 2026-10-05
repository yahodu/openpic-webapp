import { ObjectId, type Db } from "mongodb";

import { APIError } from "better-auth/api";

import { TransportError } from "@/server/adapters/transport-error";
import { getRateLimitConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import { sendTransactionalNow } from "@/server/notifications/fan-out";
import type { MessageTransport } from "@/server/notifications/message-transport";
import { hashIdentity } from "@/server/rate-limit";
import { platformRepo } from "@/server/repos";

import { otpInbox, type OtpChannel, type OtpInbox } from "./otp-inbox";

/**
 * The OTP sending port (OP-85; real sender OP-95, ADR-0020/ADR-0094).
 *
 * `createAuth` never talks to an SMS/email vendor directly: every delivered
 * one-time code goes through an {@link OtpSender}. OP-85 shipped a memory
 * implementation; OP-95 replaces it with {@link notificationOtpSender}, which
 * routes the code through the synchronous `NotificationService` path
 * (`notificationOtpSender` → `sendTransactionalNow`) and out through an injected
 * {@link MessageTransport}.
 *
 * The code itself is a credential, so the port records it only to the in-memory
 * capture (so the e2e suite can read it back) and never logs it: the log line
 * carries the channel and a **hashed** contact (`auth.otp.sent`, contract §0.13
 * never-return / OP-71 redaction).
 */

/** One one-time code to deliver. */
export interface OtpSendRequest {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

/**
 * The port every auth OTP delivery goes through.
 *
 * `send` may be asynchronous (the real sender reaches a transport), so callers
 * that must observe a completed delivery await its result.
 */
export interface OtpSender {
  send(request: OtpSendRequest): void | Promise<void>;
}

/** Construction seams for {@link memoryOtpSender} (tests inject a private inbox). */
export interface MemoryOtpSenderOptions {
  readonly inbox?: OtpInbox | undefined;
}

/** Construction seams for {@link notificationOtpSender}. */
export interface NotificationOtpSenderOptions {
  /** The database handle the transport catalogue and dispatch ledger are read from. */
  readonly db: Db;
  /** The outbound transport the rendered message is handed to. */
  readonly transport: MessageTransport;
  /** Overridable capture buffer (defaults to the process inbox). */
  readonly inbox?: OtpInbox | undefined;
}

/**
 * Emit the `auth.otp.sent` line: info level, the channel, and a salted hash of
 * the contact — never the raw email/phone and never the generated code.
 *
 * Hashing reuses the rate-limit identity hash so a contact can be correlated
 * across the two subsystems without either exposing the value. A configuration
 * failure must never leak the raw contact, so the fallback is a fixed marker.
 */
function logOtpSent(request: OtpSendRequest): void {
  let contact: string;
  try {
    contact = hashIdentity(request.to, getRateLimitConfig().salt);
  } catch {
    contact = "unavailable";
  }

  getLogger().info("OTP sent", {
    event: "auth.otp.sent",
    channel: request.channel,
    contact,
  });
}

/**
 * Build the in-memory {@link OtpSender} used by OP-85.
 *
 * @param options - Optional inbox override (defaults to the process inbox).
 * @returns The sender.
 */
export function memoryOtpSender(options: MemoryOtpSenderOptions = {}): OtpSender {
  const inbox = options.inbox ?? otpInbox;
  return {
    send(request: OtpSendRequest): void {
      inbox.record({ channel: request.channel, to: request.to, code: request.code });
      logOtpSent(request);
    },
  };
}

/** The notification type key for each Better Auth OTP channel. */
const OTP_TYPE_KEY: Readonly<Record<OtpChannel, string>> = {
  email: "auth.otp.email.requested",
  sms: "auth.otp.mobile.requested",
};

/** The Better Auth user collection (schema §13.1). */
const BETTER_AUTH_USER = "user";

/**
 * Resolve the account id owning a destination, else `null` (an email OTP may be
 * requested before an account exists, ADR-0094 assumption 4).
 */
async function resolveUserId(db: Db, channel: OtpChannel, to: string): Promise<string | null> {
  const query = channel === "email" ? { email: to } : { phoneNumber: to };
  const user = await platformRepo(db)
    .collection(BETTER_AUTH_USER)
    .findOne(query, { projection: { _id: 1 } });

  const id = user === null ? undefined : (user as { readonly _id?: unknown })._id;
  if (typeof id === "string") return id;
  if (id instanceof ObjectId) return id.toHexString();
  return null;
}

/**
 * Build the real {@link OtpSender}: Better Auth's OTP callbacks route every code
 * through the synchronous `NotificationService` path (OP-95, ADR-0094).
 *
 * The code is a template variable rendered at send time; it is never stored on
 * the dispatch ledger (`retainBody: false`) and never logged. A classified
 * transport failure is surfaced to Better Auth as a **retryable 503**
 * `upstream_unavailable` so the client can retry; any other failure propagates.
 *
 * @param options - The database, transport and optional inbox override.
 * @returns The sender.
 */
export function notificationOtpSender(options: NotificationOtpSenderOptions): OtpSender {
  const inbox = options.inbox ?? otpInbox;

  return {
    async send(request: OtpSendRequest): Promise<void> {
      const userId = await resolveUserId(options.db, request.channel, request.to);

      let providerMessageId: string;
      try {
        const result = await sendTransactionalNow({
          db: options.db,
          transport: options.transport,
          typeKey: OTP_TYPE_KEY[request.channel],
          channel: request.channel,
          destination: request.to,
          payload: { code: request.code },
          userId,
        });
        providerMessageId = result.providerMessageId;
      } catch (error) {
        if (error instanceof TransportError) {
          throw error.retryable
            ? APIError.from("SERVICE_UNAVAILABLE", {
                message: "OTP delivery is temporarily unavailable. Please retry.",
                code: "upstream_unavailable",
              })
            : APIError.from("BAD_REQUEST", {
                message: "OTP delivery was rejected upstream.",
                code: "upstream_rejected",
              });
        }
        throw error;
      }

      inbox.record({
        channel: request.channel,
        to: request.to,
        code: request.code,
        providerMessageId,
      });
      logOtpSent(request);
    },
  };
}
