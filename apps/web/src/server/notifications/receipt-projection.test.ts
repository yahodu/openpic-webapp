import { describe, expect, it } from "vitest";

import { contactHashOf } from "@/server/notifications/contact-hash";
import {
  reduceDeliveryReceipt,
  type NormalizedDeliveryReceipt,
  type ReceiptDispatch,
  type ReceiptKind,
} from "@/server/notifications/receipt-projection";

/**
 * Unit — the delivery-receipt reducer (OP-137 U1/U2, contract §10.1.3;
 * schema §19.5/§19.6; ADR-0875).
 *
 * `reduceDeliveryReceipt` is the **pure** half of the projection: one
 * normalized provider receipt, the dispatch row it matched and the instant it
 * is projected at, in; the `notificationDispatches` patch plus the optional
 * `notificationSuppressions` draft out. No database, no clock, no environment —
 * the applier (`projectDeliveryReceipt`) re-reads the inbox row, looks the
 * dispatch up and calls this function.
 *
 * ## Contract expected of the implementation
 *
 * ```ts
 * @/server/notifications/receipt-projection
 *
 * type ReceiptKind =
 *   | "delivered" | "hard_bounce" | "soft_bounce"
 *   | "complaint" | "unsubscribe" | "dnd_rejection";
 *
 * interface NormalizedDeliveryReceipt {
 *   kind: ReceiptKind;
 *   provider: string;                 // the registered adapter key, e.g. "novu"
 *   providerEventId: string | null;
 *   messageId: string;                // matched against providerRef.messageId
 *   channel: "email" | "sms" | "whatsapp";
 *   contact: string;                  // the destination the provider attempted
 *   occurredAt: Date;
 * }
 *
 * interface ReceiptDispatch {
 *   status: string;
 *   attempts: number;
 *   channel: string;
 *   contactHash: string | null;       // as the fan-out wrote it
 * }
 *
 * type ReceiptProjection =
 *   | { processResult: "applied";
 *       dispatchPatch: Readonly<Record<string, unknown>> | null;
 *       suppression: SuppressionDraft | null }
 *   | { processResult: "ignored"; dispatchPatch: null; suppression: null };
 *
 * interface SuppressionDraft {
 *   channel: string;
 *   contactHash: string;              // "sha256:" + the fan-out's digest
 *   reason: "hard_bounce" | "complaint" | "unsubscribe" | "dnd_registry";
 *   scope: "all" | "marketing";
 * }
 *
 * reduceDeliveryReceipt(input: {
 *   receipt: NormalizedDeliveryReceipt;
 *   dispatch: ReceiptDispatch | null;  // null when no ledger row matched
 *   now: Date;
 * }): ReceiptProjection
 * ```
 *
 * ## Assumptions recorded in the handoff (ADR-0875)
 *
 * - The patch is asserted with `toMatchObject`, so an implementation may carry
 *   extra §19.5 timeline fields (`failedAt`, `lastError`) the row already
 *   implies; only the fields §10.1.3 names are pinned.
 * - The suppression's `contactHash` is `"sha256:"` + the **fan-out's** digest
 *   (§19.6's documented form, already pinned for the unsubscribe row by
 *   `notification-unsubscribe.test.ts`), and the digest itself is the shared
 *   `contactHashOf` — U2's whole point is that a second, independently written
 *   hash would silently never match a suppression the resolver looks up.
 * - A `"complaint"` is `status: "failed"` because §10.1.3's row names it. The
 *   table names **no** dispatch status for `"unsubscribe"` or `"dnd_rejection"`,
 *   so those two arms pin the suppression only (plus "not delivered").
 */

/** The instant the projection runs at. */
const NOW = new Date("2026-11-18T09:00:00.000Z");

/** The destination the ledger and the receipt address. */
const EMAIL = "recipient@example.com";

/** An E.164 destination, for the SMS DND arm. */
const PHONE = ["+91", "90000", "00001"].join("");

/** The receipt instant, distinct from {@link NOW} so the patch is not a copy. */
const OCCURRED_AT = new Date("2026-11-18T08:30:00.000Z");

/** The suppression key form of a contact (§19.6). */
function suppressionKey(contact: string): string {
  const digest: string = contactHashOf(contact);
  return `sha256:${digest}`;
}

/** The `sent` dispatch row a fan-out leaves behind before a receipt arrives. */
function sentDispatch(overrides: Partial<ReceiptDispatch> = {}): ReceiptDispatch {
  return {
    status: "sent",
    attempts: 1,
    channel: "email",
    contactHash: contactHashOf(EMAIL),
    ...overrides,
  };
}

/** A normalized receipt of one kind, addressed at {@link EMAIL}. */
function receiptOf(
  kind: ReceiptKind,
  overrides: Partial<NormalizedDeliveryReceipt> = {}
): NormalizedDeliveryReceipt {
  return {
    kind,
    provider: "novu",
    providerEventId: "evt_op137_unit",
    messageId: "memory-1",
    channel: "email",
    contact: EMAIL,
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

describe("reduceDeliveryReceipt — the §10.1.3 mapping, one table row per case (U1)", () => {
  it("U1: a delivered receipt marks the dispatch delivered at the provider's instant", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("delivered"),
      dispatch: sentDispatch(),
      now: NOW,
    });

    // Assert
    expect(projection.processResult).toBe("applied");
    expect(projection.dispatchPatch).toMatchObject({
      status: "delivered",
      deliveredAt: OCCURRED_AT,
    });
    expect(projection.suppression).toBeNull();
  });

  it("U1: a hard bounce marks the dispatch bounced and drafts an all-scope suppression", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("hard_bounce"),
      dispatch: sentDispatch(),
      now: NOW,
    });

    // Assert
    expect(projection.processResult).toBe("applied");
    expect(projection.dispatchPatch).toMatchObject({ status: "bounced" });
    expect(projection.suppression).toEqual({
      channel: "email",
      contactHash: suppressionKey(EMAIL),
      reason: "hard_bounce",
      scope: "all",
    });
  });

  it("U1: a soft bounce fails the dispatch, increments attempts and suppresses nothing", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("soft_bounce"),
      dispatch: sentDispatch({ attempts: 1 }),
      now: NOW,
    });

    // Assert — §10.1.3: "status failed, attempts++, retry per policy. No suppression."
    expect(projection.processResult).toBe("applied");
    expect(projection.dispatchPatch).toMatchObject({ status: "failed", attempts: 2 });
    expect(projection.suppression).toBeNull();
  });

  it("U1: a complaint fails the dispatch and drafts an all-scope complaint suppression", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("complaint"),
      dispatch: sentDispatch(),
      now: NOW,
    });

    // Assert
    expect(projection.dispatchPatch).toMatchObject({ status: "failed" });
    expect(projection.suppression).toEqual({
      channel: "email",
      contactHash: suppressionKey(EMAIL),
      reason: "complaint",
      scope: "all",
    });
  });

  it("U1: a provider-side unsubscribe drafts a marketing-scope suppression, never all-scope", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("unsubscribe"),
      dispatch: sentDispatch(),
      now: NOW,
    });

    // Assert — §10.1.3: "scope matters: an unsubscribe must never block an OTP".
    expect(projection.suppression).toEqual({
      channel: "email",
      contactHash: suppressionKey(EMAIL),
      reason: "unsubscribe",
      scope: "marketing",
    });
    expect(projection.dispatchPatch?.status).not.toBe("delivered");
  });

  it("U1: a DND-registry rejection drafts an all-scope dnd_registry suppression on the SMS channel", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("dnd_rejection", { channel: "sms", contact: PHONE }),
      dispatch: sentDispatch({ channel: "sms", contactHash: contactHashOf(PHONE) }),
      now: NOW,
    });

    // Assert
    expect(projection.suppression).toEqual({
      channel: "sms",
      contactHash: suppressionKey(PHONE),
      reason: "dnd_registry",
      scope: "all",
    });
    expect(projection.dispatchPatch?.status).not.toBe("delivered");
  });

  it("U1: a receipt no dispatch matched is ignored, with no patch and no suppression", () => {
    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("hard_bounce"),
      dispatch: null,
      now: NOW,
    });

    // Assert — §10.1.3: "An unmatched receipt is processResult ignored, never an error."
    expect(projection).toEqual({
      processResult: "ignored",
      dispatchPatch: null,
      suppression: null,
    });
  });
});

describe("reduceDeliveryReceipt — the suppression key is the fan-out's digest (U2)", () => {
  it("U2: the suppression key reuses the ledger's contact hash even when the payload's address differs in case and spacing", () => {
    // Arrange — the provider echoes the address it was handed, and providers
    // normalise addressing differently. A second, independently written hash
    // would produce a key that no fan-out lookup ever matches.
    const dispatch = sentDispatch();
    const ledgerHash: string = dispatch.contactHash ?? "";

    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("hard_bounce", { contact: `  ${EMAIL.toUpperCase()} ` }),
      dispatch,
      now: NOW,
    });

    // Assert
    expect(projection.suppression?.contactHash).toBe(`sha256:${ledgerHash}`);
  });

  it("U2: the suppression key follows the ledger's contact hash when the payload names another address", () => {
    // Arrange — the ledger hashed an address that is *not* the one the provider
    // echoed, so the two derivations cannot coincide: a reducer that re-hashes
    // `receipt.contact` answers a key that no fan-out lookup ever builds
    // (ADR-0888).
    const receiptContact = `  ${EMAIL.toUpperCase()} `;
    const ledgerHash: string = contactHashOf("previous@example.com");
    expect(ledgerHash).not.toBe(contactHashOf(receiptContact));

    // Act
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("hard_bounce", { contact: receiptContact }),
      dispatch: sentDispatch({ contactHash: ledgerHash }),
      now: NOW,
    });

    // Assert
    expect(projection.suppression?.contactHash).toBe(`sha256:${ledgerHash}`);
  });

  it("U2: a ledger row with no contact hash falls back to the receipt's canonical digest", () => {
    // Act — a legacy row that predates the digest carries `contactHash: null`.
    const projection = reduceDeliveryReceipt({
      receipt: receiptOf("hard_bounce", { contact: `  ${EMAIL.toUpperCase()} ` }),
      dispatch: sentDispatch({ contactHash: null }),
      now: NOW,
    });

    // Assert
    expect(projection.suppression?.contactHash).toBe(suppressionKey(EMAIL));
  });

  it("U2: contactHashOf returns one canonical lowercase SHA-256 hex digest for an address in any casing", () => {
    expect(contactHashOf(`  ${EMAIL.toUpperCase()} `)).toBe(contactHashOf(EMAIL));
    expect(contactHashOf(EMAIL)).toMatch(/^[0-9a-f]{64}$/);
  });
});
