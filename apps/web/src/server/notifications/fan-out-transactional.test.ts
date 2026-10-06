import { describe, expect, it } from "vitest";

import {
  buildDispatchRecord,
  resolveOtpTarget,
  type DispatchRecord,
  type DispatchRecordInput,
} from "@/server/notifications/fan-out";
import type { ResolveContacts, ResolveProfile } from "@/server/notifications/resolve-channel";

import { makeNotificationType, requireType } from "@/test/factories/notification";

/**
 * The synchronous transactional entry point — unit contract (OP-95, design §5,
 * §8.2, schema §19.1/§19.4/§19.5; ADR-0094).
 *
 * `sendTransactionalNow` is the join the fan-out left out (ADR-0090 "Out of
 * scope"): the synchronous resolve → render → dispatch path that Better Auth's
 * OTP delivery runs inline, with no outbox delay. This spec pins the two
 * **pure** pieces the synchronous path is built from, so the channel pin and
 * the secret-retention rule are provable with zero Mongo, clock or network:
 *
 *   U1  `resolveOtpTarget` maps a Better Auth OTP channel (`email` | `sms`) to
 *       the concrete `(typeKey, channelGroup, channel)` the synchronous path
 *       dispatches. The `mobile` OTP type is pinned to `sms` (notification
 *       §4.1): WhatsApp must never carry an auth secret, so a `whatsappCapable`
 *       user still gets `sms`.
 *   U2  `buildDispatchRecord` is the metadata-only ledger row. A type with
 *       `retainBody: false` (every `auth.otp.*` type) must **omit the rendered
 *       body** so the one-time code never reaches the durable ledger (rule 6,
 *       API Contract §0.13).
 *
 * ## Contract expected of the implementation
 *
 * Module: `@/server/notifications/fan-out` (existing; OP-95 adds the exports).
 *
 * ```ts
 * type OtpChannel = "email" | "sms";
 *
 * interface OtpTargetInput {
 *   channel: OtpChannel;
 *   typeRow: NotificationType;
 *   profile: ResolveProfile;
 *   contacts: ResolveContacts;
 * }
 * interface OtpTarget {
 *   typeKey: string;
 *   channelGroup: "in_app" | "email" | "mobile";
 *   channel: "in_app" | "email" | "sms" | "whatsapp";
 * }
 * resolveOtpTarget(input: OtpTargetInput): OtpTarget
 *
 * interface DispatchRecordInput {
 *   typeRow: NotificationType;
 *   userId?: string | null;
 *   tenantId?: string | null;
 *   eventId?: string | null;
 *   channel: ResolvedChannel;
 *   channelGroup: string;
 *   contactHash?: string | null;
 *   dedupeKey?: string | null;
 *   templateVersion?: number | null;
 *   rendered?: { subject: string; body: string } | null;
 *   now: Date;
 *   expireAt: Date;
 * }
 * interface DispatchRecord {
 *   typeKey: string;
 *   channel: ResolvedChannel;
 *   channelGroup: string;
 *   status: "queued" | "sent" | "failed" | "skipped";
 *   skipReason: string | null;
 *   contactHash: string | null;
 *   dedupeKey: string | null;
 *   templateVersion: number | null;
 *   body: string | null;   // the rendered copy, retained ONLY when typeRow.retainBody
 *   attempts: number;
 *   lastError: { retryable: boolean; code: string; status?: number } | null;
 *   queuedAt: Date;
 *   sentAt: Date | null;
 *   failedAt: Date | null;
 *   expireAt: Date;
 * }
 * buildDispatchRecord(input: DispatchRecordInput): DispatchRecord
 *
 * interface TransactionalSendInput {
 *   db?: Db;
 *   transport: MessageTransport;
 *   clock?: Clock;
 *   typeKey: string;                    // e.g. "auth.otp.email.requested"
 *   channel: "email" | "sms";
 *   destination: string;               // email address or E.164 phone
 *   payload: Readonly<Record<string, unknown>>;   // template vars, includes `code`
 *   userId?: string | null;
 * }
 * interface TransactionalSendResult {
 *   dispatchId: string;
 *   status: "sent";
 *   providerMessageId: string;
 * }
 * sendTransactionalNow(input: TransactionalSendInput): Promise<TransactionalSendResult>
 * ```
 *
 * `sendTransactionalNow` is the operator-routed home for OP-94 card §6: the
 * synchronous entry point lives in `fan-out.ts` alongside the pure helpers.
 *
 * ## Assumptions (ADR-0094)
 *
 * - `resolveOtpTarget` reuses the real {@link resolveChannel} against the real
 *   seeded OTP type row; it is not a re-implementation of the resolver. A
 *   `send` decision is required, otherwise it throws naming the skip reason.
 * - The dispatch `body` field is an OP-95 addition for the synchronous path; the
 *   fan-out ledger (ADR-0092) carries none. `retainBody: false` makes it `null`.
 */

/** A fixed instant so nothing here depends on the wall clock. */
const NOW = new Date("2026-03-01T00:00:00.000Z");
const EXPIRE = new Date("2026-08-28T00:00:00.000Z");

/** A sentinel distinct from any seed copy, so a scan cannot false-positive. */
const SENTINEL = "otp-code-4f7c9a-sentinel";

/** A profile with the given WhatsApp capability. */
function makeProfile(whatsappCapable: boolean | null): ResolveProfile {
  return {
    userId: "000000000000000000000001",
    contactCapabilities: { whatsappCapable, whatsappCheckedAt: null },
  };
}

/** Verified email + phone contacts by default. */
function makeContacts(overrides: Partial<ResolveContacts> = {}): ResolveContacts {
  return {
    email: "otp-user@example.com",
    emailVerified: true,
    phoneNumber: "+919900000001",
    phoneNumberVerified: true,
    ...overrides,
  };
}

/** The pure dispatch-record input for a retained/omitted body. */
function dispatchInput(overrides: Partial<DispatchRecordInput> = {}): DispatchRecordInput {
  return {
    typeRow: requireType("auth.otp.email.requested"),
    userId: "000000000000000000000001",
    tenantId: null,
    eventId: null,
    channel: "email",
    channelGroup: "email",
    contactHash: "a".repeat(64),
    dedupeKey: null,
    templateVersion: 1,
    rendered: { subject: "Your code", body: SENTINEL },
    now: NOW,
    expireAt: EXPIRE,
    ...overrides,
  };
}

describe("resolveOtpTarget — channel pinning (U1)", () => {
  it("U1a: routes the email OTP type to the email group and channel", () => {
    const target = resolveOtpTarget({
      channel: "email",
      typeRow: requireType("auth.otp.email.requested"),
      profile: makeProfile(true),
      contacts: makeContacts(),
    });

    expect(target).toEqual({
      typeKey: "auth.otp.email.requested",
      channelGroup: "email",
      channel: "email",
    });
  });

  it("U1b: pins the mobile OTP to sms even when the user is whatsappCapable", () => {
    const target = resolveOtpTarget({
      channel: "sms",
      typeRow: requireType("auth.otp.mobile.requested"),
      profile: makeProfile(true),
      contacts: makeContacts(),
    });

    expect(target).toEqual({
      typeKey: "auth.otp.mobile.requested",
      channelGroup: "mobile",
      // Never "whatsapp" — an auth secret must not travel on WhatsApp.
      channel: "sms",
    });
  });

  it("U1c: pins the mobile OTP to sms when WhatsApp capability is unknown", () => {
    const target = resolveOtpTarget({
      channel: "sms",
      typeRow: requireType("auth.otp.mobile.requested"),
      profile: makeProfile(null),
      contacts: makeContacts(),
    });

    expect(target.channel).toBe("sms");
  });

  it("U1d: refuses to route the mobile OTP when the phone is not verified", () => {
    expect(() =>
      resolveOtpTarget({
        channel: "sms",
        typeRow: requireType("auth.otp.mobile.requested"),
        profile: makeProfile(null),
        contacts: makeContacts({ phoneNumberVerified: false }),
      })
    ).toThrow(/no_verified_contact/);
  });
});

describe("buildDispatchRecord — secret retention (U2)", () => {
  it("U2: omits the rendered body for a retainBody:false OTP type", () => {
    const record: DispatchRecord = buildDispatchRecord(dispatchInput());

    expect(record.body).toBeNull();
    expect(JSON.stringify(record)).not.toContain(SENTINEL);
    expect(record).toMatchObject({
      typeKey: "auth.otp.email.requested",
      channel: "email",
      channelGroup: "email",
    });
  });

  it("U2b: retains the rendered body for a retainBody:true type", () => {
    const record = buildDispatchRecord(
      dispatchInput({
        typeRow: makeNotificationType({ typeKey: "event.details.updated", retainBody: true }),
      })
    );

    expect(record.body).toBe(SENTINEL);
  });
});
