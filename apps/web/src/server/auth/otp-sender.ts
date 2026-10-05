import { getRateLimitConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import { hashIdentity } from "@/server/rate-limit";

import { otpInbox, type OtpChannel, type OtpInbox } from "./otp-inbox";

/**
 * The OTP sending port (OP-85, §4 "OTP sending port").
 *
 * `createAuth` never talks to an SMS/email vendor directly: every delivered
 * one-time code goes through an {@link OtpSender}. OP-85 ships the memory
 * implementation (it records the code into the process OTP inbox and emits the
 * single required log line); the real vendor sender arrives in OP-92 with no
 * change to the auth wiring.
 *
 * The code itself is a credential, so the port records it only to the in-memory
 * capture and never logs it: the log line carries the channel and a **hashed**
 * contact (`auth.otp.sent`, contract §0.13 never-return / OP-71 redaction).
 */

/** One one-time code to deliver. */
export interface OtpSendRequest {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
}

/** The port every auth OTP delivery goes through. */
export interface OtpSender {
  send(request: OtpSendRequest): void;
}

/** Construction seams for {@link memoryOtpSender} (tests inject a private inbox). */
export interface MemoryOtpSenderOptions {
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
