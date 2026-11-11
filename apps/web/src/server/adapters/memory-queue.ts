/**
 * In-memory `WorkQueue` adapter (OP-122, ADR-0681).
 *
 * The test/e2e adapter of the queue-swap surface (the `memoryMessageTransport` /
 * `memoryObjectStorage` precedent). It pins the *port* semantics — FIFO per key,
 * no in-flight redelivery, permanent `ack`, delayed `nack` — so a worker spec
 * written against `memory` proves something about every adapter, except where a
 * retry *lands*: this adapter redelivers in place, the list adapter serves it
 * last (ADR-0682 §4).
 */
import type { QueueEnvelope, QueueKey } from "../queue/envelope";
import type { EnqueueResult, QueueMessage, WorkQueue } from "../queue/work-queue";
import { systemClock, type Clock } from "../runtime/clock";

/** One enqueued record, as the inspecting suites read it back. */
export interface MemoryQueuedMessage {
  readonly messageId: string;
  readonly queueKey: QueueKey;
  readonly envelope: QueueEnvelope;
}

/** A memory queue that also exposes what it accepted. */
export interface MemoryWorkQueue extends WorkQueue {
  readonly outbox: readonly MemoryQueuedMessage[];
}

/** One queued entry's delivery state. */
interface Entry {
  readonly record: MemoryQueuedMessage;
  /** The instant it becomes claimable again after a `nack`. */
  visibleAtMs: number;
  /** Claimed and not yet acked/nacked: never handed out twice. */
  inFlight: boolean;
  /** Acked: gone for good. */
  done: boolean;
}

/**
 * Build an isolated in-memory queue.
 *
 * @param options - An optional clock, so the `nack` delay is deterministic.
 * @returns The queue, with its inspectable `outbox`.
 */
export function memoryWorkQueue(options: { readonly clock?: Clock } = {}): MemoryWorkQueue {
  const clock = options.clock ?? systemClock;
  const outbox: MemoryQueuedMessage[] = [];
  const entries: Entry[] = [];
  let sequence = 0;

  return {
    provider: "memory",

    get outbox(): readonly MemoryQueuedMessage[] {
      return outbox;
    },

    enqueue(envelope: QueueEnvelope, queueKey: QueueKey): Promise<EnqueueResult> {
      sequence += 1;
      const record: MemoryQueuedMessage = {
        messageId: `memory-${String(sequence)}`,
        queueKey,
        envelope,
      };
      outbox.push(record);
      entries.push({ record, visibleAtMs: clock.now().getTime(), inFlight: false, done: false });
      return Promise.resolve({ messageId: record.messageId });
    },

    claim(queueKey: QueueKey, max: number): Promise<QueueMessage[]> {
      const nowMs = clock.now().getTime();
      const claimed = entries.filter(
        (entry) =>
          !entry.done &&
          !entry.inFlight &&
          entry.record.queueKey === queueKey &&
          entry.visibleAtMs <= nowMs
      );
      const batch = claimed.slice(0, max);
      for (const entry of batch) {
        entry.inFlight = true;
      }
      return Promise.resolve(
        batch.map((entry) => ({
          messageId: entry.record.messageId,
          envelope: entry.record.envelope,
        }))
      );
    },

    ack(messageId: string): Promise<void> {
      const entry = entries.find((candidate) => candidate.record.messageId === messageId);
      if (entry !== undefined) {
        entry.done = true;
        entry.inFlight = false;
      }
      return Promise.resolve();
    },

    nack(messageId: string, delaySeconds: number): Promise<void> {
      const entry = entries.find((candidate) => candidate.record.messageId === messageId);
      if (entry !== undefined) {
        entry.inFlight = false;
        entry.visibleAtMs = clock.now().getTime() + delaySeconds * 1000;
      }
      return Promise.resolve();
    },
  };
}
