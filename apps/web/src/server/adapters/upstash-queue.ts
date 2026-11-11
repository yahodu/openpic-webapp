/**
 * Upstash Redis `WorkQueue` adapter (OP-122, contract §10.4, ADR-0681).
 *
 * This is the only module that talks to the broker. Upstash exposes Redis over
 * REST: one POST per command, the body a command array, the answer
 * `{ result: ... }`. The two physical queues are plain Redis lists — `LPUSH`
 * onto the head and `RPOP` from the tail is FIFO, and the caller's `queueKey`
 * already carries its `q:` prefix.
 *
 * A Redis list has no server-assigned message id (LPUSH answers with the list
 * length), so ids are adapter-minted. That is safe because MongoDB owns retry
 * accounting (schema §18.1): the sweep keys off leases and `queuedAt`, never off
 * a broker ack.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Logger } from "../logging";
import { queueEnvelopeSchema, type QueueEnvelope, type QueueKey } from "../queue/envelope";
import type { EnqueueResult, QueueMessage, WorkQueue } from "../queue/work-queue";
import { UpstreamContractError, classifyTransportFailure } from "./transport-error";

/** The provider key recorded in `processing.queueRef.provider`. */
const PROVIDER = "upstash";

/** The drift event an unpinned Upstash answer is logged as (ADR-0072 shape). */
export const UPSTREAM_CONTRACT_VIOLATION_EVENT = "queue.upstream_contract_violation";

/** The documented answer to `LPUSH`: the new list length. */
const pushResultSchema = z.object({ result: z.number() });

/** The documented answer to `RPOP key count`: the popped payloads, or null when empty. */
const popResultSchema = z.object({ result: z.array(z.string()).nullable() });

/** Construction options for {@link createUpstashQueue}. */
export interface UpstashQueueOptions {
  /** The Upstash REST endpoint. */
  readonly url: string;
  /** The Upstash REST bearer token. */
  readonly token: string;
  /** Receives the drift signal for a response that broke the pinned shape. */
  readonly logger?: Logger;
  /** A fetch implementation override (tests / instrumentation). */
  readonly fetch?: typeof fetch;
}

/**
 * Build an Upstash-backed {@link WorkQueue}.
 *
 * @param options - The endpoint, token and optional logger/fetch.
 * @returns The queue adapter.
 */
export function createUpstashQueue(options: UpstashQueueOptions): WorkQueue {
  const fetchImpl = options.fetch ?? fetch;
  /** Claimed payloads, so `ack`/`nack` can act on an id the list does not keep. */
  const claimed = new Map<string, { readonly queueKey: QueueKey; readonly payload: string }>();

  /** Log the drift and build the error that carries it — never the token. */
  function contractViolation(
    message: string,
    operation: string,
    queueKey: QueueKey,
    cause: unknown
  ): UpstreamContractError {
    options.logger?.error(message, {
      event: UPSTREAM_CONTRACT_VIOLATION_EVENT,
      provider: PROVIDER,
      operation,
      queueKey,
    });
    return new UpstreamContractError(message, { cause });
  }

  /** POST one Redis command and return the raw answer body. */
  async function command(
    body: readonly unknown[],
    operation: string,
    queueKey: QueueKey
  ): Promise<unknown> {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(body),
    }).catch((error: unknown) => {
      throw classifyTransportFailure({ error });
    });

    if (!response.ok) {
      throw classifyTransportFailure({ status: response.status });
    }

    return response.json().catch((cause: unknown) => {
      throw contractViolation("Upstash queue response was not JSON.", operation, queueKey, cause);
    });
  }

  return {
    provider: PROVIDER,

    async enqueue(envelope: QueueEnvelope, queueKey: QueueKey): Promise<EnqueueResult> {
      const body = await command(
        ["LPUSH", queueKey, JSON.stringify(envelope)],
        "enqueue",
        queueKey
      );
      const parsed = pushResultSchema.safeParse(body);
      if (!parsed.success) {
        throw contractViolation(
          "Upstash queue response did not match the LPUSH contract.",
          "enqueue",
          queueKey,
          parsed.error
        );
      }
      return { messageId: randomUUID() };
    },

    async claim(queueKey: QueueKey, max: number): Promise<QueueMessage[]> {
      const body = await command(["RPOP", queueKey, String(max)], "claim", queueKey);
      const parsed = popResultSchema.safeParse(body);
      if (!parsed.success) {
        throw contractViolation(
          "Upstash queue response did not match the RPOP contract.",
          "claim",
          queueKey,
          parsed.error
        );
      }

      const messages: QueueMessage[] = [];
      for (const payload of parsed.data.result ?? []) {
        let raw: unknown;
        try {
          raw = JSON.parse(payload);
        } catch (cause) {
          throw contractViolation("A queued message was not JSON.", "claim", queueKey, cause);
        }
        const envelope = queueEnvelopeSchema.safeParse(raw);
        if (!envelope.success) {
          throw contractViolation(
            "A queued message did not match the §10.4 envelope.",
            "claim",
            queueKey,
            envelope.error
          );
        }
        const messageId = randomUUID();
        claimed.set(messageId, { queueKey, payload });
        messages.push({ messageId, envelope: envelope.data });
      }
      return messages;
    },

    ack(messageId: string): Promise<void> {
      // RPOP already removed the payload; ack only retires the local claim.
      claimed.delete(messageId);
      return Promise.resolve();
    },

    nack(messageId: string, _delaySeconds: number): Promise<void> {
      // shortcut: a Redis list has no delay — the payload is requeued at the head
      // immediately; upgrade to a delayed sorted set when in-broker backoff matters.
      const entry = claimed.get(messageId);
      if (entry === undefined) {
        return Promise.resolve();
      }
      claimed.delete(messageId);
      return command(["LPUSH", entry.queueKey, entry.payload], "nack", entry.queueKey).then(
        () => undefined
      );
    },
  };
}
