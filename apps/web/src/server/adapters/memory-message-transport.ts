/**
 * In-memory outbox transport (OP-92 §2, ADR-0074).
 *
 * A test/e2e `MessageTransport` that records every rendered {@link OutboundMessage}
 * in call order and mints a per-send provider id. Each factory call returns a
 * fresh, isolated outbox.
 *
 * Deliberately named `memoryMessageTransport` — **not** `memoryTransport`, which
 * `@/server/logging` already exports (the memory *log sink*, whose `entries`
 * hold log lines). The two ports must never be conflated.
 */
import type {
  MessageTransport,
  OutboundMessage,
  TransportReceipt,
} from "../notifications/message-transport";

/** A transport that also exposes the messages it accepted. */
export interface MemoryMessageTransport extends MessageTransport {
  readonly outbox: readonly OutboundMessage[];
}

/**
 * Build an isolated in-memory outbox transport.
 *
 * @returns The transport, with its inspectable `outbox`.
 */
export function memoryMessageTransport(): MemoryMessageTransport {
  const outbox: OutboundMessage[] = [];
  let sequence = 0;

  return {
    get outbox(): readonly OutboundMessage[] {
      return outbox;
    },
    send(message: OutboundMessage): Promise<TransportReceipt> {
      outbox.push(message);
      sequence += 1;
      return Promise.resolve({ providerMessageId: `memory-${String(sequence)}` });
    },
  };
}
