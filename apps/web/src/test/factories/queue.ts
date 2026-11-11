/**
 * Queue fixtures (OP-122, contract §10.4).
 *
 * The envelope is a **pointer**: `{v, kind, id, tenantId, eventId, priority,
 * spaceKey, enqueuedAt, attempt, traceId}` and nothing else. Every field is a
 * primitive, so the fixture keeps the defaults primitive too — a nested object
 * in a default would quietly stop the "no payload beyond identifiers" pin from
 * meaning anything.
 *
 * Ids are deterministic 24-character hex strings (the ObjectId wire shape the
 * contract's examples use), so a failing assertion prints a readable id instead
 * of a random one.
 */
import type { QueueEnvelope } from "@/server/queue/envelope";

/**
 * Build a deterministic 24-character hex id.
 *
 * @param seed - A number to render as hex (0 through 2^40 stay 24 chars).
 * @returns The zero-padded hex string.
 */
export function objectIdHex(seed: number): string {
  return seed.toString(16).padStart(24, "0");
}

/** The embedding space the fixture snapshots (schema §17.2). */
export const FIXTURE_SPACE_KEY = "arcface_r100_512";

/** The fixture enqueue instant. */
export const FIXTURE_ENQUEUED_AT = "2026-09-25T09:12:00.000Z";

/** The fixture request id the envelope carries as its trace id. */
export const FIXTURE_TRACE_ID = "req_01JBQ7X3M2";

/**
 * Build a valid §10.4 envelope — a high-priority selfie by default.
 *
 * @param overrides - Fields to override.
 * @returns A complete envelope.
 */
export function makeQueueEnvelope(overrides: Partial<QueueEnvelope> = {}): QueueEnvelope {
  return {
    v: 1,
    kind: "selfie",
    id: objectIdHex(0x51f1e),
    tenantId: objectIdHex(0x7e4a2),
    eventId: objectIdHex(0xe7e7f),
    priority: "high",
    spaceKey: FIXTURE_SPACE_KEY,
    enqueuedAt: FIXTURE_ENQUEUED_AT,
    attempt: 0,
    traceId: FIXTURE_TRACE_ID,
    ...overrides,
  };
}
