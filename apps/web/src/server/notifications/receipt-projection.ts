import { ObjectId, type Db } from "mongodb";
import { z } from "zod";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { getLogger } from "@/server/logging";
import { contactHashOf } from "@/server/notifications/contact-hash";
import { upsertSuppression } from "@/server/notifications/suppression-strength";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";

/**
 * The delivery-receipt projection (OP-137, contract §10.1.3; design §19.5 /
 * §19.6; ADR-0875 §5, ADR-0882).
 *
 * Two halves, as the OP-108 inbox has them:
 *
 *  - {@link reduceDeliveryReceipt} is the **pure** half: one normalized
 *    provider receipt, the dispatch row it matched and the instant it is
 *    projected at, in; the §10.1.3 `notificationDispatches` patch plus the
 *    optional `notificationSuppressions` draft out. No database, no clock, no
 *    environment.
 *  - {@link projectDeliveryReceipt} is the **applier**: it re-reads one
 *    `providerWebhookEvents` row, parses the stored payload, looks the dispatch
 *    up by `providerRef.messageId` alone (the fan-out writes the lane-neutral
 *    `providerRef.provider: "transport"` for both adapters, so a vendor-shaped
 *    filter would never match), applies the patch and upserts the suppression.
 *
 * A row whose payload the envelope schema rejects is `processResult: "error"`
 * with a `processError` naming the offending field, and is logged at `error`
 * with the provider: the provider is never told, exactly as the payment
 * projection records its own failures. A receipt no dispatch matched is
 * `processResult: "ignored"`, never an error.
 *
 * The parsed envelope is **vendor-neutral** (ADR-0875 §4: the reducer and the
 * applier never see a vendor field), so its schema lives here rather than in
 * `@/server/adapters/novu/schemas`: the ESLint boundary forbids the
 * notifications layer from importing the Novu adapter, and a vendor wire shape
 * maps onto this envelope inside that adapter (ADR-0882 §5).
 */

/** The six §10.1.3 receipt kinds the projection distinguishes. */
export type ReceiptKind =
  "delivered" | "hard_bounce" | "soft_bounce" | "complaint" | "unsubscribe" | "dnd_rejection";

/** One provider receipt, already normalized. */
export interface NormalizedDeliveryReceipt {
  readonly kind: ReceiptKind;
  /** The registered adapter key, e.g. `"novu"`. */
  readonly provider: string;
  readonly providerEventId: string | null;
  /** Matched against `notificationDispatches.providerRef.messageId`. */
  readonly messageId: string;
  readonly channel: "email" | "sms" | "whatsapp";
  /** The destination the provider attempted. */
  readonly contact: string;
  readonly occurredAt: Date;
}

/** The `notificationDispatches` fields the reducer reads (§19.5). */
export interface ReceiptDispatch {
  readonly status: string;
  readonly attempts: number;
  readonly channel: string;
  readonly contactHash: string | null;
}

/** The `notificationSuppressions` row the projection must upsert (§19.6). */
export interface SuppressionDraft {
  readonly channel: string;
  /** `"sha256:"` + the fan-out's digest. */
  readonly contactHash: string;
  readonly reason: "hard_bounce" | "complaint" | "unsubscribe" | "dnd_registry";
  readonly scope: "all" | "marketing";
}

/** What {@link reduceDeliveryReceipt} decided. */
export type ReceiptProjection =
  | {
      readonly processResult: "applied";
      readonly dispatchPatch: Readonly<Record<string, unknown>> | null;
      readonly suppression: SuppressionDraft | null;
    }
  | { readonly processResult: "ignored"; readonly dispatchPatch: null; readonly suppression: null };

/** What {@link reduceDeliveryReceipt} is given. */
export interface ReduceReceiptInput {
  readonly receipt: NormalizedDeliveryReceipt;
  /** `null` when no ledger row matched. */
  readonly dispatch: ReceiptDispatch | null;
  /** The instant the projection runs at. */
  readonly now: Date;
}

/** The options the applier accepts; both are injected by a spec or the sweep. */
export interface ProjectDeliveryReceiptOptions {
  readonly db?: Db;
  readonly clock?: Clock;
}

/**
 * The normalized receipt envelope a provider's payload must carry (§10.1.3).
 *
 * `bounceType` is required exactly when `status` is `"bounced"`: an ambiguous
 * bounce must not default to a permanent hard-bounce suppression of the whole
 * contact. A payload that no longer matches this shape is recorded as
 * `processResult: "error"`, so a provider's shape change is detected rather
 * than guessed at.
 */
export const deliveryReceiptSchema = z
  .object({
    eventId: z.string().min(1),
    transactionId: z.string().min(1),
    status: z.enum(["delivered", "bounced", "complained", "unsubscribed", "dnd_rejected"]),
    channel: z.enum(["email", "sms", "whatsapp"]),
    to: z.string().min(1),
    bounceType: z.enum(["hard", "soft"]).optional(),
    occurredAt: z.iso.datetime(),
  })
  .refine((receipt) => receipt.status !== "bounced" || receipt.bounceType !== undefined, {
    message: "bounceType is required when status is bounced",
    path: ["bounceType"],
  });

/** The parsed envelope. */
type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;

/** The §18.4 inbox row fields the applier reads. */
const inboxRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  provider: z.string(),
  providerEventId: z.string().nullable(),
  rawPayload: z.unknown(),
});

/** The §19.5 dispatch fields the reducer needs. */
const dispatchRowSchema = z.object({
  _id: z.instanceof(ObjectId),
  status: z.string(),
  attempts: z.number(),
  channel: z.string(),
  contactHash: z.string().nullable(),
});

/** The suppression a kind drafts, or `null` for a kind that suppresses nothing. */
function suppressionFor(
  receipt: NormalizedDeliveryReceipt,
  dispatch: ReceiptDispatch,
  reason: SuppressionDraft["reason"],
  scope: SuppressionDraft["scope"]
): SuppressionDraft {
  return {
    channel: receipt.channel,
    // U2: the **ledger's** digest, so the key is the one a fan-out lookup built
    // from the same address can match; the receipt's own casing is irrelevant.
    contactHash: `sha256:${dispatch.contactHash ?? contactHashOf(receipt.contact)}`,
    reason,
    scope,
  };
}

/**
 * The pure §10.1.3 mapping: one receipt + its matched dispatch → the patch and
 * the suppression (§19.6).
 *
 * @param input - The normalized receipt, the dispatch row (`null` when none
 *   matched) and the projection instant.
 * @returns The `applied` decision, or `ignored` for an unmatched receipt.
 */
export function reduceDeliveryReceipt(input: ReduceReceiptInput): ReceiptProjection {
  const { receipt, dispatch } = input;
  if (dispatch === null) {
    return { processResult: "ignored", dispatchPatch: null, suppression: null };
  }

  switch (receipt.kind) {
    case "delivered":
      return {
        processResult: "applied",
        dispatchPatch: { status: "delivered", deliveredAt: receipt.occurredAt },
        suppression: null,
      };
    case "hard_bounce":
      return {
        processResult: "applied",
        dispatchPatch: {
          status: "bounced",
          failedAt: receipt.occurredAt,
          lastError: { retryable: false, code: "hard_bounce" },
        },
        suppression: suppressionFor(receipt, dispatch, "hard_bounce", "all"),
      };
    case "soft_bounce":
      return {
        processResult: "applied",
        // §10.1.3: "attempts++, retry per policy" — and deliberately no
        // suppression, so a transient bounce never stops the next send.
        dispatchPatch: {
          status: "failed",
          attempts: dispatch.attempts + 1,
          failedAt: receipt.occurredAt,
          lastError: { retryable: true, code: "soft_bounce" },
        },
        suppression: null,
      };
    case "complaint":
      return {
        processResult: "applied",
        dispatchPatch: {
          status: "failed",
          failedAt: receipt.occurredAt,
          lastError: { retryable: false, code: "complaint" },
        },
        suppression: suppressionFor(receipt, dispatch, "complaint", "all"),
      };
    case "unsubscribe":
      // §10.1.3 names no dispatch status for this arm; scope is the whole
      // behaviour — marketing only, so a transactional OTP still delivers.
      return {
        processResult: "applied",
        dispatchPatch: null,
        suppression: suppressionFor(receipt, dispatch, "unsubscribe", "marketing"),
      };
    case "dnd_rejection":
      return {
        processResult: "applied",
        dispatchPatch: null,
        suppression: suppressionFor(receipt, dispatch, "dnd_registry", "all"),
      };
  }
}

/** The `ReceiptKind` a schema-validated receipt names. */
function kindOf(receipt: DeliveryReceipt): ReceiptKind {
  switch (receipt.status) {
    case "delivered":
      return "delivered";
    case "bounced":
      return receipt.bounceType === "soft" ? "soft_bounce" : "hard_bounce";
    case "complained":
      return "complaint";
    case "unsubscribed":
      return "unsubscribe";
    case "dnd_rejected":
      return "dnd_rejection";
  }
}

/** The driver's `_id` value for a projection target. */
function toObjectId(id: ObjectId | string): ObjectId {
  return typeof id === "string" ? new ObjectId(id) : id;
}

/** The `processError` text a schema rejection records, naming the fields. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "payload"}: ${issue.message}`)
    .join("; ");
}

/**
 * Project one inbox row into the dispatch ledger and the suppression store.
 *
 * @param inboxId - The `providerWebhookEvents._id` the route handed to `after()`.
 * @param options - The database and clock seams; both default to the process
 *   singletons so the route and the sweep call the same function.
 */
export async function projectDeliveryReceipt(
  inboxId: ObjectId | string,
  options: ProjectDeliveryReceiptOptions = {}
): Promise<void> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const inbox = platformRepo(db).collection(COLLECTIONS.providerWebhookEvents);
  const raw = await inbox.findOne({ _id: toObjectId(inboxId) });
  if (raw === null) {
    return;
  }
  const row = inboxRowSchema.parse(raw);

  const parsed = deliveryReceiptSchema.safeParse(row.rawPayload);
  if (!parsed.success) {
    const processError = describeIssues(parsed.error);
    getLogger().error("delivery receipt failed the envelope schema", {
      event: "notification.receipt.invalid",
      provider: row.provider,
      processError,
    });
    // Terminal: a shape rejection does not heal on retry, and the inbox row is
    // the operator's evidence of what the provider sent.
    await inbox.updateOne(
      { _id: row._id },
      { $set: { processedAt: now, processResult: "error", processError } }
    );
    return;
  }

  const data = parsed.data;
  const receipt: NormalizedDeliveryReceipt = {
    kind: kindOf(data),
    provider: row.provider,
    providerEventId: row.providerEventId,
    messageId: data.transactionId,
    channel: data.channel,
    contact: data.to,
    occurredAt: new Date(data.occurredAt),
  };

  const dispatches = platformRepo(db).collection(COLLECTIONS.dispatches);
  const stored = await dispatches.findOne({ "providerRef.messageId": receipt.messageId });
  const found = stored === null ? null : dispatchRowSchema.parse(stored);
  const dispatch: ReceiptDispatch | null =
    found === null
      ? null
      : {
          status: found.status,
          attempts: found.attempts,
          channel: found.channel,
          contactHash: found.contactHash,
        };

  const projection = reduceDeliveryReceipt({ receipt, dispatch, now });

  if (projection.dispatchPatch !== null && found !== null) {
    await dispatches.updateOne({ _id: found._id }, { $set: projection.dispatchPatch });
  }

  if (projection.suppression !== null) {
    // Upgrade-only: a stronger receipt replaces a weaker row, and an equal or
    // weaker one must not weaken it (the row is shared with the unsubscribe route).
    await upsertSuppression(
      platformRepo(db).collection(COLLECTIONS.notificationSuppressions),
      {
        channel: projection.suppression.channel,
        contactHash: projection.suppression.contactHash,
        reason: projection.suppression.reason,
        scope: projection.suppression.scope,
        source: { provider: receipt.provider, providerEventId: receipt.providerEventId },
      },
      now
    );
  }

  await inbox.updateOne(
    { _id: row._id },
    { $set: { processedAt: now, processResult: projection.processResult, processError: null } }
  );
}
