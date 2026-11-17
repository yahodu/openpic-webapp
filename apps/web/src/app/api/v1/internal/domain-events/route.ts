import { z } from "zod";

import { internalAuthStage } from "@/server/auth/internal-hmac";
import { getConfig } from "@/server/config/env";
import { getDb } from "@/server/db/mongo";
import { DomainEventError, emitDomainEvent } from "@/server/domain/domain-events";
import { defineRoute } from "@/server/http/define-route";

/**
 * `POST /api/v1/internal/domain-events` — the worker's outbox flush (OP-135,
 * contract §10.3.2, §7.6, §7.7; ADR-0029, ADR-0808 §3, ADR-0829 §2).
 *
 * The Python worker must never embed a notification client, so every fact it
 * produces reaches the outbox through here. Each item is gated separately: an
 * unknown `eventKey` is refused **in the answer** and the rest of the batch
 * still commits (§10.3.2's "a bad key never fails the batch"), and `dedupeKey`
 * is honoured through {@link emitDomainEvent} — which is what makes the worker's
 * announcement of an activation result and the confirmation's the same
 * delivery (ADR-0808 §3).
 */

const ROUTE = "/api/v1/internal/domain-events";

/** §10.3.2's batch cap. */
const MAX_BATCH = 100;

/** One event as the worker sends it. */
const batchItemSchema = z.object({
  eventKey: z.string().min(1),
  tenantId: z.string().min(1),
  actorRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  subjectRef: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.iso.datetime(),
  dedupeKey: z.string().min(1).optional(),
});

type BatchItem = z.infer<typeof batchItemSchema>;

/** One refused item: its position, its key and the stable reason. */
const rejectedItemSchema = z.object({
  index: z.number().int(),
  eventKey: z.string(),
  reason: z.string(),
});

/** The §10.3.2 answer: three counters, and `accepted + deduped + rejected = total`. */
const batchResponseSchema = z.object({
  accepted: z.number().int(),
  deduped: z.number().int(),
  rejected: z.array(rejectedItemSchema),
});

export const POST = defineRoute<{ events: BatchItem[] }, z.infer<typeof batchResponseSchema>>({
  route: ROUTE,
  body: z.object({ events: z.array(batchItemSchema).max(MAX_BATCH) }),
  response: batchResponseSchema,
  // The secrets are read through a thunk: `getConfig()` validates the
  // environment, which `next build` runs without.
  auth: (ctx, request) =>
    internalAuthStage({
      internalApiSecret: getConfig().internal.apiSecret,
      cronSecret: getConfig().cron.secret,
    })(ctx, request),
  handler: async (ctx) => {
    const db = getDb();
    const rejected: z.infer<typeof rejectedItemSchema>[] = [];
    let accepted = 0;
    let deduped = 0;

    for (const [index, item] of ctx.body.events.entries()) {
      try {
        const result = await emitDomainEvent(
          {
            eventKey: item.eventKey,
            tenantId: item.tenantId,
            actorRef: item.actorRef,
            subjectRef: item.subjectRef,
            payload: item.payload,
            ...(item.dedupeKey === undefined ? {} : { dedupeKey: item.dedupeKey }),
          },
          // The worker's own instant is the event's `occurredAt`; the outbox
          // stamps it from this seam rather than from the request clock.
          { db, clock: { now: () => new Date(item.occurredAt) } }
        );
        if (result.deduped) {
          deduped += 1;
        } else {
          accepted += 1;
        }
      } catch (error: unknown) {
        if (!(error instanceof DomainEventError)) {
          throw error;
        }
        rejected.push({ index, eventKey: item.eventKey, reason: error.code });
      }
    }

    return { status: 202, body: { accepted, deduped, rejected } };
  },
});
