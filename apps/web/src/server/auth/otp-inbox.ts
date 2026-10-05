/**
 * Process-level capture of every delivered one-time code (OP-85).
 *
 * The real OTP transport is out of scope for OP-85 (memory now, real sender in
 * OP-92), but the e2e suite still needs to read the code a request generated
 * without it ever crossing the wire. This inbox is that process-local capture:
 * the auth config records every OTP here as it is handed to the (memory)
 * transport, and the test-only route reads it back.
 *
 * The store lives on `globalThis`, not in module scope, because a Next.js
 * server may evaluate a route module more than once (lambda re-use, hot
 * reload): the auth handler and the read-back route must observe the same
 * capture. Importing this module is side-effect free.
 */

/** The two channels an auth OTP may travel on. */
export type OtpChannel = "email" | "sms";

/** One captured one-time code. */
export interface CapturedOtp {
  readonly channel: OtpChannel;
  readonly to: string;
  readonly code: string;
  /**
   * The transport receipt id for the delivered message (OP-95).
   *
   * It is the e2e-observable proof that the code travelled through the injected
   * `MessageTransport`; the OP-85 memory sender minted no provider id, so older
   * captures may omit it.
   */
  readonly providerMessageId?: string | null;
}

/** The capture surface the auth config writes to and the test route reads. */
export interface OtpInbox {
  /** Record a delivered code. */
  record(otp: CapturedOtp): void;
  /** Every captured code, oldest first (never mutated by callers). */
  list(): readonly CapturedOtp[];
  /**
   * Remove and return the most recently captured code for a contact+channel.
   *
   * @param channel - The channel the code was sent on.
   * @param to - The email address or E.164 phone number.
   * @returns The captured code, or `undefined` when none is pending.
   */
  take(channel: OtpChannel, to: string): CapturedOtp | undefined;
  /** Drop every captured code. */
  clear(): void;
}

/** The `globalThis` slot carrying the shared capture buffer. */
interface OtpInboxGlobal {
  __openpicOtpInbox?: CapturedOtp[] | undefined;
}

const globalSlot = globalThis as typeof globalThis & OtpInboxGlobal;

/** The live capture buffer, created on first access. */
function buffer(): CapturedOtp[] {
  globalSlot.__openpicOtpInbox ??= [];
  return globalSlot.__openpicOtpInbox;
}

/** The process-wide OTP inbox shared by the auth config and the test route. */
export const otpInbox: OtpInbox = {
  record(otp: CapturedOtp): void {
    buffer().push(otp);
  },
  list(): readonly CapturedOtp[] {
    return [...buffer()];
  },
  take(channel: OtpChannel, to: string): CapturedOtp | undefined {
    const entries = buffer();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.channel === channel && entry.to === to) {
        entries.splice(index, 1);
        return entry;
      }
    }
    return undefined;
  },
  clear(): void {
    buffer().length = 0;
  },
};
