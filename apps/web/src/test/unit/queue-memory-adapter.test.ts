/**
 * The `memory` WorkQueue adapter (OP-122, contract §10.4 queue-swap surface).
 *
 * Every later lane drives the queue through a `memory` adapter in tests and e2e
 * (the `memoryMessageTransport` / `memoryObjectStorage` precedent), so the port's
 * claim/ack/nack semantics have to be pinned here — the Upstash adapter's wire
 * commands are the GREEN's choice, but the *port* must behave the same whichever
 * adapter is selected, or a worker spec written against `memory` proves nothing.
 *
 * The delay on `nack` is read from the injected `Clock`, so the redelivery case
 * is deterministic instead of a `sleep`.
 */
import { describe, expect, it } from "vitest";

import { memoryWorkQueue } from "@/server/adapters/memory-queue";
import type { Clock } from "@/server/runtime/clock";

import { makeQueueEnvelope, objectIdHex } from "../factories/queue";

/** The four port methods §10.4 names. */
const PORT_METHODS = ["enqueue", "claim", "ack", "nack"] as const;

/** The instant the delay cases start from. */
const START_INSTANT = "2026-09-25T09:12:00.000Z";

/**
 * A clock the test moves by hand.
 *
 * @returns The clock and the advance function that moves it.
 */
function movableClock(): { readonly clock: Clock; readonly advance: (ms: number) => void } {
  const state = { nowMs: Date.parse(START_INSTANT) };
  return {
    clock: { now: () => new Date(state.nowMs) },
    advance: (ms) => {
      state.nowMs += ms;
    },
  };
}

describe("memoryWorkQueue (contract §10.4, schema §18.1)", () => {
  it("records the memory provider key, so queueRef.provider never names a vendor", () => {
    expect(memoryWorkQueue().provider).toBe("memory");
  });

  it.each(PORT_METHODS)("implements %s() from the queue-swap surface", (method) => {
    expect(typeof memoryWorkQueue()[method]).toBe("function");
  });

  it("claims the enqueued envelopes in FIFO order and never redelivers an in-flight one", async () => {
    const queue = memoryWorkQueue();
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });

    await queue.enqueue(first, "q:image");
    await queue.enqueue(second, "q:image");

    const claimed = await queue.claim("q:image", 10);

    expect(claimed.map((message) => message.envelope)).toEqual([first, second]);
    expect(claimed.every((message) => message.messageId.length > 0)).toBe(true);
    expect(new Set(claimed.map((message) => message.messageId)).size).toBe(2);
    expect(Object.keys(claimed[0] ?? {}).sort()).toEqual(["envelope", "messageId"]);
    expect(await queue.claim("q:image", 10)).toEqual([]);
  });

  it("returns at most the requested batch size", async () => {
    const queue = memoryWorkQueue();
    await queue.enqueue(makeQueueEnvelope({ id: objectIdHex(0x100) }), "q:image");
    await queue.enqueue(makeQueueEnvelope({ id: objectIdHex(0x101) }), "q:image");
    await queue.enqueue(makeQueueEnvelope({ id: objectIdHex(0x102) }), "q:image");

    expect((await queue.claim("q:image", 2)).length).toBe(2);
    expect((await queue.claim("q:image", 2)).length).toBe(1);
  });

  it("keeps the two logical queues separate", async () => {
    const queue = memoryWorkQueue();
    const selfie = makeQueueEnvelope();
    const image = makeQueueEnvelope({ kind: "event_image", priority: "normal" });

    await queue.enqueue(selfie, "q:selfie");
    await queue.enqueue(image, "q:image");

    const claimed = await queue.claim("q:selfie", 10);

    expect(claimed.map((message) => message.envelope)).toEqual([selfie]);
  });

  it("drops a message permanently once it is acked", async () => {
    const queue = memoryWorkQueue();
    await queue.enqueue(makeQueueEnvelope(), "q:selfie");
    await queue.enqueue(makeQueueEnvelope({ id: objectIdHex(0xbeef3) }), "q:selfie");
    const [acked] = await queue.claim("q:selfie", 1);
    if (acked === undefined) {
      throw new Error("expected the first message to be claimable");
    }

    await queue.ack(acked.messageId);

    expect(acked.messageId).toBe(queue.outbox[0]?.messageId);
    expect((await queue.claim("q:selfie", 10)).map((message) => message.messageId)).toEqual([
      queue.outbox[1]?.messageId,
    ]);
  });

  it("redelivers a nacked message only after its delay has elapsed", async () => {
    const { clock, advance } = movableClock();
    const queue = memoryWorkQueue({ clock });
    await queue.enqueue(makeQueueEnvelope(), "q:selfie");
    const [claimed] = await queue.claim("q:selfie", 10);
    if (claimed === undefined) {
      throw new Error("expected the enqueued message to be claimable");
    }

    await queue.nack(claimed.messageId, 30);
    advance(29_000);
    const early = await queue.claim("q:selfie", 10);
    advance(1_000);
    const late = await queue.claim("q:selfie", 10);

    expect(early).toEqual([]);
    expect(late.map((message) => message.messageId)).toEqual([claimed.messageId]);
  });

  it("records what was enqueued, with its queue key, for the suites that inspect it", async () => {
    const queue = memoryWorkQueue();
    const envelope = makeQueueEnvelope();

    await queue.enqueue(envelope, "q:selfie");

    expect(queue.outbox.map((record) => record.queueKey)).toEqual(["q:selfie"]);
    expect(queue.outbox[0]?.envelope).toEqual(envelope);
  });
});
