import type { Db } from "mongodb";

import { sendTransactionalNow } from "@/server/notifications/fan-out";
import { getLogger } from "@/server/logging";
import { getNotificationTransport } from "@/server/services/notification-transport";

/**
 * Invitation delivery (OP-120, contract §2.3, ADR-0661 D3/D4).
 *
 * The invitation link is the **only** place the raw token exists, so delivery
 * cannot be deferred to the outbox fan-out: the fan-out resolves recipients
 * from accounts (`event_organizers` rows and the Better Auth `user` document),
 * and an invitation may precede the account — an email or phone invitee has no
 * account to address. The route therefore renders and sends through the
 * synchronous transactional seam (`sendTransactionalNow`), which stamps the
 * destination's `contactHash`, keeps the rendered body on the dispatch ledger
 * (the type retains its body) and hands the message to the configured
 * transport.
 *
 * ## A delivery failure never loses the invitation
 *
 * The invitation is committed before this module runs. A transport failure is
 * therefore handled where the architecture already records it: the dispatch
 * row is written `failed` with its classified `lastError` and the
 * `notification-dispatch-retry` cron owns redelivery (ADR-0120). It is logged
 * at error level here — with the invitation and channel, **never** the link,
 * which would put the token in the logs — and the `201` still stands, because
 * the organizer did create a durable invitation.
 */

/** The notification type whose rendered copy carries the invitation link. */
export const INVITE_TYPE_KEY = "collab.invite.sent";

/** One delivery attempt's facts. */
export interface InviteDeliveryInput {
  /** The database handle the dispatch ledger is written to. */
  readonly db: Db;
  /** The invitation the link redeems. */
  readonly invitationId: string;
  /** The invitee's address, when the invitation goes by email. */
  readonly email: string | null;
  /** The invitee's E.164 number, when the invitation goes by SMS. */
  readonly sms: string | null;
  /** The one-time link carrying the raw token. */
  readonly inviteUrl: string;
  /** The invitee's account id, when it has one (kept off an account-less row). */
  readonly userId: string | null;
}

/** Send one transactional invitation, recording a failure on the ledger. */
async function sendInvite(
  input: InviteDeliveryInput,
  channel: "email" | "sms",
  destination: string
): Promise<void> {
  try {
    await sendTransactionalNow({
      db: input.db,
      transport: getNotificationTransport(),
      typeKey: INVITE_TYPE_KEY,
      channel,
      destination,
      payload: { actionUrl: input.inviteUrl },
      userId: input.userId,
    });
  } catch (error) {
    // The dispatch ledger already carries the classified failure; this line is
    // the operator-visible signal, and it deliberately names no link.
    getLogger().error("invitation delivery failed", {
      event: "collab.invite.delivery_failed",
      invitationId: input.invitationId,
      channel,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Deliver an invitation over every channel its contact allows.
 *
 * @param input - The invitation, its destinations and the one-time link.
 * @returns Nothing; each channel's failure is recorded and logged, never thrown
 *   (the invitation is already durable).
 */
export async function deliverInvite(input: InviteDeliveryInput): Promise<void> {
  if (input.email !== null) {
    await sendInvite(input, "email", input.email);
  }
  if (input.sms !== null) {
    await sendInvite(input, "sms", input.sms);
  }
}
