/**
 * U1 + U2 — the §10.4 queue envelope and the §18.1 queue-key mapping (OP-122).
 *
 * Two rules from the contract carry the whole lane:
 *
 *   - **No payload beyond identifiers** (§10.4): the message is a pointer, so
 *     the schema is `.strict()` — an extra field is a contract violation, not a
 *     tolerated annotation. A message that carried an image URL or an embedding
 *     would go stale in the queue and would leak media coordinates.
 *   - **Two logical queues, drained strictly in priority order** (§18.1):
 *     `q:selfie` before `q:image`, and a selfie is `high` because an attendee is
 *     staring at a spinner while an organizer's batch can wait.
 *
 * Both surfaces are pure, so they live in the `unit` project.
 */
import { describe, expect, it } from "vitest";

import {
  defaultPriorityFor,
  queueEnvelopeSchema,
  queueKeyFor,
  type QueueKey,
  type QueueKind,
  type QueuePriority,
} from "@/server/queue/envelope";

import { FIXTURE_TRACE_ID, makeQueueEnvelope, objectIdHex } from "../factories/queue";

/** The exact envelope key set of contract §10.4 — ten pointer fields, no more. */
const ENVELOPE_KEYS = [
  "attempt",
  "enqueuedAt",
  "eventId",
  "id",
  "kind",
  "priority",
  "spaceKey",
  "tenantId",
  "traceId",
  "v",
];

/** The three work types of §10.4. */
const KINDS: readonly QueueKind[] = ["event_image", "selfie", "match_incremental"];

/** `priority` → the physical queue it is drained from (§18.1). */
const PRIORITY_TO_KEY: readonly (readonly [QueuePriority, QueueKey])[] = [
  ["high", "q:selfie"],
  ["normal", "q:image"],
];

/** `kind` → the `processing.priority` the work item is stamped with (§18.2). */
const KIND_TO_PRIORITY: readonly (readonly [QueueKind, QueuePriority])[] = [
  ["selfie", "high"],
  ["match_incremental", "high"],
  ["event_image", "normal"],
];

/** `kind` → the queue its default priority resolves to. */
const KIND_TO_QUEUE: readonly (readonly [QueueKind, QueueKey, QueuePriority])[] = [
  ["selfie", "q:selfie", "high"],
  ["event_image", "q:image", "normal"],
  ["match_incremental", "q:selfie", "high"],
];

/** Extra fields a message must never carry, whatever their name suggests. */
const EXTRA_FIELDS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["payload", { payload: { imageUrl: "https://cdn.example.com/a.jpg" } }],
  ["url", { url: "https://cdn.example.com/a.jpg" }],
  ["embedding", { embedding: [0.1, 0.2, 0.3] }],
  ["r2Key", { r2Key: "images/abc.jpg" }],
  ["queueRef", { queueRef: { queueKey: "selfie", provider: "upstash", messageId: "m-1" } }],
];

describe("queueEnvelopeSchema (U1, contract §10.4)", () => {
  it("accepts the documented pointer envelope and returns exactly its ten keys", () => {
    const envelope = makeQueueEnvelope();

    const parsed = queueEnvelopeSchema.safeParse(envelope);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`expected the §10.4 envelope to parse: ${String(parsed.error)}`);
    }
    expect(parsed.data).toEqual(envelope);
    expect(Object.keys(parsed.data).sort()).toEqual(ENVELOPE_KEYS);
  });

  it("carries no nested value, because every field is an identifier or a scalar", () => {
    const parsed = queueEnvelopeSchema.parse(makeQueueEnvelope());

    expect(Object.values(parsed).filter((value) => typeof value === "object")).toEqual([]);
  });

  it.each(EXTRA_FIELDS)("rejects an extra %s field (strict)", (fieldName, extra) => {
    const parsed = queueEnvelopeSchema.safeParse({ ...makeQueueEnvelope(), ...extra });

    expect(parsed.success, `expected the schema to reject an extra "${fieldName}" field`).toBe(
      false
    );
  });

  it("rejects a match_incremental envelope that adds a media-only payload field", () => {
    const parsed = queueEnvelopeSchema.safeParse({
      ...makeQueueEnvelope(),
      kind: "match_incremental",
      profileId: objectIdHex(0x9f01),
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a match_incremental envelope with the same ten pointer keys", () => {
    const envelope = makeQueueEnvelope({ kind: "match_incremental" });

    const parsed = queueEnvelopeSchema.parse(envelope);

    expect(Object.keys(parsed).sort()).toEqual(ENVELOPE_KEYS);
    expect(parsed.kind).toBe("match_incremental");
  });

  it("rejects an unknown envelope version, so a worker never guesses", () => {
    expect(queueEnvelopeSchema.safeParse({ ...makeQueueEnvelope(), v: 2 }).success).toBe(false);
    expect(queueEnvelopeSchema.safeParse({ ...makeQueueEnvelope(), v: "1" }).success).toBe(false);
  });

  it("rejects a kind outside the three documented work types", () => {
    const parsed = queueEnvelopeSchema.safeParse({
      ...makeQueueEnvelope(),
      kind: "thumbnail",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a priority outside high|normal", () => {
    const parsed = queueEnvelopeSchema.safeParse({
      ...makeQueueEnvelope(),
      priority: "urgent",
    });

    expect(parsed.success).toBe(false);
  });

  it.each(["id", "tenantId", "eventId"])(
    "rejects a %s that is not a 24-character hex id",
    (field) => {
      const parsed = queueEnvelopeSchema.safeParse({
        ...makeQueueEnvelope(),
        [field]: "not-an-object-id",
      });

      expect(parsed.success).toBe(false);
    }
  );

  it("rejects an enqueuedAt that is not an ISO 8601 instant", () => {
    const parsed = queueEnvelopeSchema.safeParse({
      ...makeQueueEnvelope(),
      enqueuedAt: "25-09-2026 09:12",
    });

    expect(parsed.success).toBe(false);
  });

  it.each([-1, 1.5])(
    "rejects an attempt of %s, because attempt is a non-negative integer counter",
    (attempt) => {
      const parsed = queueEnvelopeSchema.safeParse({ ...makeQueueEnvelope(), attempt });

      expect(parsed.success).toBe(false);
    }
  );

  it("requires the trace id, which is the request id the work is correlated on", () => {
    const envelope: Record<string, unknown> = { ...makeQueueEnvelope() };
    delete envelope.traceId;

    expect(queueEnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(queueEnvelopeSchema.parse(makeQueueEnvelope()).traceId).toBe(FIXTURE_TRACE_ID);
  });
});

describe("queueKeyFor / defaultPriorityFor (U2, schema §18.1)", () => {
  it.each(PRIORITY_TO_KEY)("drains priority %s from %s", (priority, expected) => {
    expect(queueKeyFor(priority)).toBe(expected);
  });

  it.each(KIND_TO_PRIORITY)("gives a %s the %s priority", (kind, expected) => {
    expect(defaultPriorityFor(kind)).toBe(expected);
  });

  it.each(KIND_TO_QUEUE)("sends a %s to %s at %s priority", (kind, queueKey, priority) => {
    const resolvedPriority = defaultPriorityFor(kind);

    expect(resolvedPriority).toBe(priority);
    expect(queueKeyFor(resolvedPriority)).toBe(queueKey);
  });

  it.each(KINDS)("resolves a queue key for every kind in the vocabulary: %s", (kind) => {
    expect(queueKeyFor(defaultPriorityFor(kind))).toMatch(/^q:(selfie|image)$/);
  });
});
