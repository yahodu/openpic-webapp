/**
 * The provider-neutral `WorkQueue` port (OP-122, contract §10.4, schema §28).
 *
 * Nothing outside an adapter references the broker: swapping Upstash for SQS
 * changes `processing.queueRef.provider` and one module. The backend mostly
 * enqueues; the worker claims, acks and nacks.
 */
import type { QueueEnvelope, QueueKey } from "./envelope";

/** The broker-side receipt of an enqueue. */
export interface EnqueueResult {
  /** The broker message id; it lives only in `processing.queueRef.messageId`. */
  readonly messageId: string;
}

/** One claimed message. */
export interface QueueMessage {
  readonly messageId: string;
  readonly envelope: QueueEnvelope;
}

/** The queue-swap surface of contract §10.4. */
export interface WorkQueue {
  /** The provider key that lands in `processing.queueRef.provider`. */
  readonly provider: string;
  enqueue(envelope: QueueEnvelope, queueKey: QueueKey): Promise<EnqueueResult>;
  /** Claim up to `max` messages from `queueKey`, in FIFO order. */
  claim(queueKey: QueueKey, max: number): Promise<QueueMessage[]>;
  /** Drop a claimed message permanently. */
  ack(messageId: string): Promise<void>;
  /**
   * Return a claimed message to the queue, claimable again after the delay.
   *
   * Guaranteed: FIFO over *enqueued* messages, and a nacked one becomes
   * claimable no sooner than the delay. Its position among the remaining
   * messages is adapter-defined (ADR-0682 §4): `memory` redelivers in place,
   * the Upstash list re-pushes to the head and serves it last.
   */
  nack(messageId: string, delaySeconds: number): Promise<void>;
}
