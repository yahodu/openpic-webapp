import { createHash, createHmac } from "node:crypto";

/**
 * Novu delivery-receipt fixtures (OP-137, contract §10.1.3; ADR-0875).
 *
 * Novu signs its webhooks with **Svix**, and this factory reproduces that scheme
 * exactly so the route under test verifies the real thing rather than a
 * home-made one:
 *
 * ```
 * key      = base64decode(secret after the "whsec_" prefix)
 * content  = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 * header   = "v1," + base64(HMAC-SHA256(key, content))
 * ```
 *
 * A `webhook-signature` header may carry several space-separated `v1,<sig>`
 * entries (Svix rotates its key); {@link makeNovuWebhookHeaders} emits one and
 * {@link withExtraSignature} appends a second, so the "any entry may verify"
 * arm is expressible.
 *
 * The secret is **derived at runtime**, never written as a literal: `gitleaks`
 * classifies a high-entropy string bound to a secret-named identifier as
 * `generic-api-key` and would fail `secret-scan` on the PR (ADR-0875 §4).
 */

/** The `whsec_`-prefixed signing secret the suite boots the app with. */
export const TEST_NOVU_WEBHOOK_SECRET = `whsec_${createHash("sha256")
  .update("openpic-op137-novu-receipt-fixture")
  .digest("base64")}`;

/** A second, different valid key, for the rotation arm. */
export const TEST_NOVU_WEBHOOK_SECRET_PREVIOUS = `whsec_${createHash("sha256")
  .update("openpic-op137-novu-receipt-fixture-previous")
  .digest("base64")}`;

/**
 * The `webhook-id` of the standard receipt the suite delivers.
 *
 * Svix's `webhook-id` is the provider's own message id, so it is also the
 * `providerWebhookEvents` identity the duplicate arm replays.
 */
export const NOVU_RECEIPT_WEBHOOK_ID = "msg_op137_receipt_0001";

/**
 * The instant the standard receipt says the delivery happened.
 *
 * A fixed value, so `deliveredAt` can be asserted exactly instead of bounded.
 */
export const NOVU_RECEIPT_OCCURRED_AT = "2026-11-18T08:30:00.000Z";

/** The receipt statuses the projection contract (§10.1.3) distinguishes. */
export type NovuReceiptStatus =
  "delivered" | "bounced" | "complained" | "unsubscribed" | "dnd_rejected";

/** The outbound channel a receipt names. */
export type NovuReceiptChannel = "email" | "sms" | "whatsapp";

/** The receipt body this lane's adapter schema parses (ADR-0875 §3). */
export interface NovuReceiptBody {
  /** The provider's own event id. */
  readonly eventId: string;
  /** The dispatch's `providerRef.messageId` — the lookup key. */
  readonly transactionId: string;
  readonly status: NovuReceiptStatus;
  readonly channel: NovuReceiptChannel;
  /** The destination the provider attempted; the suppression key's source. */
  readonly to: string;
  /** Present **iff** `status` is `"bounced"`. */
  readonly bounceType?: "hard" | "soft";
  /** RFC 3339 instant of the provider event. */
  readonly occurredAt: string;
}

/** The body a receipt fixture starts from before overrides. */
const RECEIPT_DEFAULTS: NovuReceiptBody = {
  eventId: "evt_op137_0001",
  transactionId: "msg_op137_0001",
  status: "delivered",
  channel: "email",
  to: "recipient@example.com",
  occurredAt: NOVU_RECEIPT_OCCURRED_AT,
};

/**
 * Build a receipt payload.
 *
 * @param overrides - Fields to replace; `bounceType` is added only when given,
 *   mirroring a provider that does not send it for a non-bounce.
 * @returns The payload as the plain object a `JSON.stringify` can serialise.
 */
export function makeNovuReceiptBody(
  overrides: Partial<NovuReceiptBody> = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    eventId: overrides.eventId ?? RECEIPT_DEFAULTS.eventId,
    transactionId: overrides.transactionId ?? RECEIPT_DEFAULTS.transactionId,
    status: overrides.status ?? RECEIPT_DEFAULTS.status,
    channel: overrides.channel ?? RECEIPT_DEFAULTS.channel,
    to: overrides.to ?? RECEIPT_DEFAULTS.to,
    occurredAt: overrides.occurredAt ?? RECEIPT_DEFAULTS.occurredAt,
  };
  if (overrides.bounceType !== undefined) {
    body.bounceType = overrides.bounceType;
  }
  return body;
}

/** The key Svix derives the HMAC from: the secret minus `whsec_`, base64-decoded. */
function signingKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/**
 * Sign one delivery the Svix way.
 *
 * @param input - The secret, the `webhook-id`, the `webhook-timestamp` and the
 *   **raw** body bytes (never a re-serialised object).
 * @returns `v1,<base64 HMAC-SHA256>` — the single-entry header value.
 */
export function signNovuWebhook(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly rawBody: string;
}): string {
  const signature = createHmac("sha256", signingKey(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.rawBody}`, "utf8")
    .digest("base64");
  return `v1,${signature}`;
}

/**
 * Build the four headers a Novu delivery carries.
 *
 * @param input - The secret, id, timestamp and raw body to sign.
 * @returns The headers as the plain record a `Request` accepts.
 */
export function makeNovuWebhookHeaders(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly rawBody: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "webhook-id": input.id,
    "webhook-timestamp": input.timestamp,
    "webhook-signature": signNovuWebhook(input),
  };
}

/**
 * Append a second, differently-keyed `v1,` entry to a signature header.
 *
 * Svix emits one entry per active key during a rotation, and a receiver must
 * accept the delivery when **any** entry verifies.
 *
 * @param headers - The headers a delivery already carries.
 * @param extraSignature - The additional `v1,<sig>` entry.
 * @returns A copy of the headers with both entries, space-separated.
 */
export function withExtraSignature(
  headers: Record<string, string>,
  extraSignature: string
): Record<string, string> {
  return {
    ...headers,
    "webhook-signature": `${headers["webhook-signature"] ?? ""} ${extraSignature}`.trim(),
  };
}
