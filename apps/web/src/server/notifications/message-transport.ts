/**
 * The outbound `MessageTransport` port (OP-92, API contract §9.4).
 *
 * Notification routing, templates and call sites decide *what* to send and
 * render it into an {@link OutboundMessage}; a transport adapter's only job is
 * to hand that fully rendered message to a provider and return a vendor-neutral
 * receipt. Because this port is the only contract the rest of the server knows,
 * swapping Novu for another provider is one adapter file with zero changes to
 * routing, templates or call sites (ADR-0001, `docs/CONVENTIONS.md` §7).
 *
 * No vendor-native type may cross this boundary: the receipt names a generic
 * `providerMessageId`, never Novu's `transactionId`.
 */

/** The outbound channels OpenPic can deliver on. */
export type OutboundChannel = "email" | "sms" | "whatsapp";

/**
 * A recipient: the internal user id plus the contact for the selected channel.
 *
 * `userId` is always present and becomes the provider's subscriber identity;
 * the channel-specific contact (`email` for email, `phoneE164` for SMS and
 * WhatsApp) is passed inline.
 */
export interface OutboundRecipient {
  readonly userId: string;
  readonly email?: string;
  readonly phoneE164?: string;
}

/** A fully rendered outbound message, ready for a transport adapter. */
export interface OutboundMessage {
  readonly channel: OutboundChannel;
  readonly to: OutboundRecipient;
  readonly subject?: string;
  readonly html?: string;
  readonly text?: string;
  readonly templateName?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The vendor-neutral receipt a transport returns for an accepted message. */
export interface TransportReceipt {
  readonly providerMessageId: string;
}

/** The one-method port every outbound provider adapter implements. */
export interface MessageTransport {
  /**
   * Hand a rendered message to the provider.
   *
   * @param message - The fully rendered outbound message.
   * @returns The provider's message identifier.
   * @throws {import("../adapters/transport-error").TransportError} On a
   *   classified transport failure.
   */
  send(message: OutboundMessage): Promise<TransportReceipt>;
}
