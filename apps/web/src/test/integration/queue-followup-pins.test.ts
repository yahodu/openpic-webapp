/**
 * OP-122 queue follow-up pins (ADR-0682, ADR-0684), at the round-1 sign-off
 * (`c9c259c`).
 *
 * These pins cover the enqueue path and the two adapters' retry position and
 * failure containment. Two are **RED by design** — they describe behaviour the
 * sign-off left open and must fail until the GREEN child lands:
 *
 * - **P4 (memory)** a nacked message becomes available **after** the messages
 *   enqueued behind it — the "back" rule ADR-0683 §4 prefers, which the Upstash
 *   list already has. `memoryWorkQueue.nack` must move the entry to the back of
 *   its table instead of redelivering it in place (ADR-0684 §2).
 * - **P6** one poison payload must not cost the claimed batch: `claim`
 *   re-`LPUSH`es every §10.4-valid payload of the batch before it raises the
 *   drift, drops only the poison and logs the drift once (ADR-0684 §1).
 *
 * The rest are **characterization** pins: they describe what the code does today
 * and are green on arrival, so a later reader does not mistake a green run for a
 * red pin that failed to bite.
 *
 * - **P1** the pointer is validated (`queueEnvelopeSchema` and the `ObjectId`)
 *   *before* `queue.enqueue`, so no request path puts a §10.4-rejected value on
 *   the broker (green since the follow-up GREEN, PR #421).
 * - **P2** the Upstash adapter bounds every request with `timeoutMs`, so a hung
 *   broker is a retryable `TransportError` and never a hung user request (green
 *   since PR #421).
 * - **P3** `ack`/`nack` on an id this process never minted is a silent no-op
 *   (the process-local `claimed` ledger; the payload is already gone).
 * - **P4 (upstash)** the list re-`LPUSH`es a nacked payload to the head and
 *   `RPOP`s the tail, so the message is served last — the position both
 *   adapters now share.
 * - **P5** `nack`'s `delaySeconds` never reaches the Upstash broker: the payload
 *   is re-pushed immediately and is claimable at once at any delay. A delayed
 *   sorted set (`ZADD` with a score, `ZRANGEBYSCORE` + `ZREM` to promote on
 *   time) is the upgrade that would honour it; until then this pin freezes the
 *   divergence so it cannot change silently (ADR-0684 §3).
 *
 * The round-1 follow-up card added **P7–P9** (ADR-0686) after the containment
 * GREEN (ADR-0685) shipped, to close the coverage gaps that review left: the
 * ledger exactness was only pinned for a batch's **first** message, the broker
 * failure that can interrupt the rescue was unpinned, and the "one drift per
 * claim, first class wins" rule had no case with two poison classes at once.
 * They are characterization pins on the shipped behaviour and contain no
 * production change:
 *
 * - **P7** the `claimed` ledger maps **each** `messageId` of a claimed batch to
 *   its **own** payload, so `nack`ing the second of two messages re-`LPUSH`es
 *   the second's bytes — not a duplicate of the first.
 * - **P8** a broker failure **mid-rescue** rejects `claim` with a retryable
 *   `TransportError` and records **no** drift; the call reports no partial
 *   success, and the payload re-pushed before the failure is claimable again.
 * - **P9** a batch that holds two invalid payloads of **different** classes
 *   raises exactly one drift, and its message names the **first** class.
 *
 * The pins drive the real modules over MSW (`integration/setup.ts` intercepts
 * every outbound request) and the Mongo memory server, never a stubbed
 * collaborator, so a behaviour-preserving refactor keeps them green and a
 * regression breaks the named case. The Upstash mock emulates a real Redis list
 * (head/tail), so "served last", "re-queued" and "not re-queued" are observed as
 * the payloads a worker would actually receive next.
 */
import { ObjectId } from "mongodb";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryWorkQueue } from "@/server/adapters/memory-queue";
import { TransportError, UpstreamContractError } from "@/server/adapters/transport-error";
import { createUpstashQueue, type UpstashQueueOptions } from "@/server/adapters/upstash-queue";
import { COLLECTIONS } from "@/server/db/collections";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import { enqueueWork, type WorkItemPointer } from "@/server/queue/enqueue-work";
import { queueEnvelopeSchema } from "@/server/queue/envelope";
import { fixedClock } from "@/server/runtime/clock";

import { startTestApp, type TestApp } from "../helpers/authed-app";
import { MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";
import {
  FIXTURE_ENQUEUED_AT,
  FIXTURE_SPACE_KEY,
  FIXTURE_TRACE_ID,
  makeQueueEnvelope,
  objectIdHex,
} from "../factories/queue";

import { server } from "./setup";

/** The deployment's Upstash REST endpoint (a fixture host, never a real one). */
const UPSTASH_URL = "https://mock-upstash.test/queue";

/** The bearer token the adapter must send. */
const UPSTASH_TOKEN = "test-upstash-token";

/** The drift event an unpinned Upstash answer is logged as. */
const DRIFT_EVENT = "queue.upstream_contract_violation";

/** The non-fatal-enqueue warning `enqueueWork` must leave behind. */
const ENQUEUE_FAILED_EVENT = "queue.enqueue_failed";

const TENANT_ID = objectIdHex(0x7e4a2);
const EVENT_ID = objectIdHex(0xe7e7f);

/**
 * The request budget this card fixes on the adapter's options (ADR-0682 §2).
 * Small enough that a hung fetch is caught inside the case, large enough that a
 * healthy mock never trips it.
 */
const TIMEOUT_MS = 40;

/**
 * How long a RED case waits before declaring the adapter never settled. Well
 * under the 5 s default test timeout, so the failure is the assertion
 * ("expected 'still-pending'…") and not a bare vitest timeout.
 */
const SETTLE_DEADLINE_MS = 1_500;

/**
 * The option shape ADR-0682 §2 fixes for the request timeout.
 *
 * `createUpstashQueue` takes a {@link UpstashQueueOptions} today, so passing the
 * extra field through a *variable* of this type is structurally valid while the
 * field is still unknown to the adapter — i.e. the spec type-checks at RED and
 * the adapter simply ignores `timeoutMs` until the GREEN implements it. The
 * GREEN adds `readonly timeoutMs?: number` to `UpstashQueueOptions` (optional,
 * so every shipped `createUpstashQueue({url, token, logger})` call stays valid)
 * with the documented default recorded in the ADR.
 */
interface TimedUpstashQueueOptions extends UpstashQueueOptions {
  readonly timeoutMs: number;
}

/** A logger wired to a memory sink, so a case can read what was emitted. */
function makeLogger(): { readonly logger: Logger; readonly sink: MemoryTransport } {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "trace",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    base: { requestId: FIXTURE_TRACE_ID },
  });
  return { logger, sink };
}

/** Resolve after `ms`, so a case can race a call that may never settle. */
function waitMs(ms: number): Promise<"still-pending"> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("still-pending");
    }, ms);
  });
}

/** A captured Redis command, in call order. */
interface MockBroker {
  /** Every command array the adapter POSTed, in call order. */
  readonly commands: readonly (readonly unknown[])[];
  /** Replace the list with these payloads, in the order `RPOP` must serve them. */
  pop(payloads: readonly string[]): void;
}

/**
 * Install the Upstash REST mock over a real Redis-list emulation.
 *
 * `LPUSH` prepends to the head and `RPOP key count` drains from the tail — the
 * documented Redis semantics the adapter relies on — so a case observes the
 * payloads a worker would actually receive next, not a canned answer. `pop`
 * replaces the list with the payloads a case wants served, in FIFO order.
 *
 * @returns The captured commands and the list-seeding function.
 */
function installBroker(): MockBroker {
  const commands: (readonly unknown[])[] = [];
  /** The list as Redis holds it: index 0 is the head, the last element the tail. */
  let list: string[] = [];

  server.use(
    http.post(UPSTASH_URL, async ({ request }) => {
      const raw: unknown = await request.json();
      if (!Array.isArray(raw)) {
        throw new Error("expected the Upstash REST body to be a command array");
      }
      commands.push(raw);

      const [name, , argument] = raw;
      if (name === "LPUSH") {
        list.unshift(String(argument));
        return HttpResponse.json({ result: list.length });
      }

      const popped = list.splice(Math.max(list.length - Number(argument), 0)).reverse();
      return HttpResponse.json({ result: popped.length === 0 ? null : popped });
    })
  );

  return {
    commands,
    pop: (payloads) => {
      list = [...payloads].reverse();
    },
  };
}

/**
 * Install the Upstash REST mock over a real Redis-list emulation whose
 * `LPUSH`es start failing with a `503` from the given attempt on.
 *
 * This is the mid-rescue transport failure of the claim path: the `RPOP`
 * succeeds, the first rescue push lands, and every later command answers like a
 * broker that went away. `RPOP` keeps draining a real list, so a case can still
 * observe which payloads the rescue managed to put back.
 *
 * @param failPushFrom - The 1-based `LPUSH` attempt that starts answering `503`.
 * @returns The captured commands and the list-seeding function.
 */
function installBrokerFailingPushes(failPushFrom: number): MockBroker {
  const commands: (readonly unknown[])[] = [];
  /** The list as Redis holds it: index 0 is the head, the last element the tail. */
  let list: string[] = [];
  let pushes = 0;

  server.use(
    http.post(UPSTASH_URL, async ({ request }) => {
      const raw: unknown = await request.json();
      if (!Array.isArray(raw)) {
        throw new Error("expected the Upstash REST body to be a command array");
      }
      commands.push(raw);

      const [name, , argument] = raw;
      if (name === "LPUSH") {
        pushes += 1;
        if (pushes >= failPushFrom) {
          return HttpResponse.json({ error: "upstream unavailable" }, { status: 503 });
        }
        list.unshift(String(argument));
        return HttpResponse.json({ result: list.length });
      }

      const popped = list.splice(Math.max(list.length - Number(argument), 0)).reverse();
      return HttpResponse.json({ result: popped.length === 0 ? null : popped });
    })
  );

  return {
    commands,
    pop: (payloads) => {
      list = [...payloads].reverse();
    },
  };
}

/** Answer every command with a response that never arrives (a hung broker). */
function hangTheBroker(): void {
  server.use(
    http.post(UPSTASH_URL, async () => {
      await new Promise(() => undefined);
      return HttpResponse.json({ result: 1 });
    })
  );
}

describe("queue follow-up pins (OP-122 round 1, ADR-0682)", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp({ prefix: "op122-pins" });
  }, MONGO_READY_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await app.cleanup();
  });

  beforeEach(async () => {
    await app.db.collection(COLLECTIONS.eventImages).deleteMany({});
  });

  /** Seed a queued work item with no queueRef, and return its hex id. */
  async function seedWorkItem(): Promise<{ readonly id: string }> {
    const imageId = new ObjectId();
    await app.db.collection(COLLECTIONS.eventImages).insertOne({
      _id: imageId,
      tenantId: TENANT_ID,
      eventId: EVENT_ID,
      processing: {
        status: "queued",
        attempts: 0,
        leaseExpiresAt: null,
        workerId: null,
        queueRef: null,
      },
    });
    return { id: imageId.toHexString() };
  }

  /** Read the work item's `processing` sub-document back. */
  async function readProcessing(id: string): Promise<Record<string, unknown>> {
    const row = await app.db.collection(COLLECTIONS.eventImages).findOne({
      _id: new ObjectId(id),
    });
    if (row === null) {
      throw new Error(`expected the work item ${id} to exist`);
    }
    return row.processing as Record<string, unknown>;
  }

  /** The four pointer fields every case shares. */
  function basePointer(id: string): WorkItemPointer {
    return {
      kind: "selfie",
      id,
      tenantId: TENANT_ID,
      eventId: EVENT_ID,
      spaceKey: FIXTURE_SPACE_KEY,
      traceId: FIXTURE_TRACE_ID,
    };
  }

  // ---------------------------------------------------------------------------
  // P1 — RED by design: the pointer is validated after it is already on the broker
  // ---------------------------------------------------------------------------

  /** The three pointer corruptions a request path can hand `enqueueWork`. */
  const INVALID_POINTERS: readonly {
    readonly label: string;
    readonly overrides: Partial<WorkItemPointer>;
  }[] = [
    {
      label: "a work id that is not a 24-hex ObjectId",
      overrides: { id: "not-a-24-hex-object-id" },
    },
    { label: "an empty spaceKey", overrides: { spaceKey: "" } },
    { label: "a tenantId that is not 24-hex", overrides: { tenantId: "tenant-42" } },
  ];

  it.each(INVALID_POINTERS)(
    "enqueueWork refuses $label before anything reaches the broker",
    async ({ overrides }) => {
      const { logger, sink } = makeLogger();
      const queue = memoryWorkQueue();
      const { id } = await seedWorkItem();

      const result = await enqueueWork({
        db: app.db,
        queue,
        collection: COLLECTIONS.eventImages,
        logger,
        clock: fixedClock(FIXTURE_ENQUEUED_AT),
        work: { ...basePointer(id), ...overrides },
      });

      expect(result).toEqual({ enqueued: false });
      expect(queue.outbox).toEqual([]);
      expect((await readProcessing(id)).queueRef).toBeNull();

      const warning = sink.entries.find((entry) => entry.event === ENQUEUE_FAILED_EVENT);
      expect(warning?.level).toBe("warn");
      expect(warning?.queueKey).toBe("q:selfie");
      expect(warning?.kind).toBe("selfie");
    }
  );

  it("keeps every envelope on the broker §10.4-parseable — the invalid pointers add nothing", async () => {
    const { logger } = makeLogger();
    const queue = memoryWorkQueue();
    const { id } = await seedWorkItem();
    const base = basePointer(id);
    const enqueue = (work: WorkItemPointer): Promise<{ enqueued: boolean }> =>
      enqueueWork({
        db: app.db,
        queue,
        collection: COLLECTIONS.eventImages,
        logger,
        clock: fixedClock(FIXTURE_ENQUEUED_AT),
        work,
      });

    const valid = await enqueue(base);
    const badId = await enqueue({ ...base, id: "not-a-24-hex-object-id" });
    const badSpaceKey = await enqueue({ ...base, spaceKey: "" });
    const badTenant = await enqueue({ ...base, tenantId: "tenant-42" });

    expect([valid.enqueued, badId.enqueued, badSpaceKey.enqueued, badTenant.enqueued]).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(queue.outbox).toHaveLength(1);
    expect(
      queue.outbox.map((record) => queueEnvelopeSchema.safeParse(record.envelope).success)
    ).toEqual([true]);
    expect((await readProcessing(id)).queueRef).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // P2 — RED by design: a hung broker hangs the user request
  // ---------------------------------------------------------------------------

  it("enqueue rejects with a retryable timeout TransportError when the broker never answers", async () => {
    hangTheBroker();
    const { logger, sink } = makeLogger();
    const options: TimedUpstashQueueOptions = {
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
      logger,
      timeoutMs: TIMEOUT_MS,
    };
    const queue = createUpstashQueue(options);

    const outcome = await Promise.race([
      queue.enqueue(makeQueueEnvelope(), "q:selfie").then(
        () => "resolved" as const,
        (error: unknown) => error
      ),
      waitMs(SETTLE_DEADLINE_MS),
    ]);

    expect(outcome).toBeInstanceOf(TransportError);
    expect(outcome).toMatchObject({ code: "timeout", retryable: true });
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toEqual([]);
  });

  it("treats a hung broker as a non-fatal enqueue: {enqueued:false}, no queueRef", async () => {
    hangTheBroker();
    const { logger } = makeLogger();
    const options: TimedUpstashQueueOptions = {
      url: UPSTASH_URL,
      token: UPSTASH_TOKEN,
      logger,
      timeoutMs: TIMEOUT_MS,
    };
    const { id } = await seedWorkItem();

    const outcome = await Promise.race([
      enqueueWork({
        db: app.db,
        queue: createUpstashQueue(options),
        collection: COLLECTIONS.eventImages,
        logger,
        clock: fixedClock(FIXTURE_ENQUEUED_AT),
        work: basePointer(id),
      }),
      waitMs(SETTLE_DEADLINE_MS),
    ]);

    expect(outcome).toEqual({ enqueued: false });
    expect((await readProcessing(id)).queueRef).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // P3 — characterization: the claim ledger is process-local (green on arrival)
  // ---------------------------------------------------------------------------

  it("nack() resolves for an id this process never minted, with no broker call and no log", async () => {
    const broker = installBroker();
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });

    await expect(queue.nack("id-from-another-process", 30)).resolves.toBeUndefined();

    expect(broker.commands).toEqual([]);
    expect(sink.entries).toEqual([]);
  });

  it("ack() resolves for an id this process never minted, with no broker call", async () => {
    const broker = installBroker();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN });

    await expect(queue.ack("id-from-another-process")).resolves.toBeUndefined();

    expect(broker.commands).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // P4 — one retry position for both adapters: a nacked message goes to the back
  //      (memory is RED by design; the Upstash list already behaves that way)
  // ---------------------------------------------------------------------------

  it("memory redelivers a nacked message after the message enqueued behind it", async () => {
    const queue = memoryWorkQueue();
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    await queue.enqueue(first, "q:image");
    await queue.enqueue(second, "q:image");

    const [claimed] = await queue.claim("q:image", 1);
    if (claimed === undefined) {
      throw new Error("expected the first message to be claimable");
    }
    await queue.nack(claimed.messageId, 0);

    const redelivered = await queue.claim("q:image", 10);

    // The "back" rule (ADR-0683 §4, adopted in ADR-0684 §2): the retry lands
    // behind everything already enqueued, which is the position the Upstash list
    // produces by re-`LPUSH`ing to the head while `RPOP` drains the tail.
    expect(redelivered.map((message) => message.envelope)).toEqual([second, first]);
  });

  it("upstash re-LPUSHes a nacked payload to the head, so the tail-draining claim serves it last", async () => {
    const broker = installBroker();
    const { logger } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    await queue.enqueue(first, "q:image");
    await queue.enqueue(second, "q:image");

    const claimed = await queue.claim("q:image", 2);
    const [firstClaimed] = claimed;
    if (firstClaimed === undefined) {
      throw new Error("expected the first payload to be claimable");
    }
    await queue.nack(firstClaimed.messageId, 30);

    expect(broker.commands).toHaveLength(4);
    expect(broker.commands[3]).toEqual(["LPUSH", "q:image", JSON.stringify(first)]);
  });

  // ---------------------------------------------------------------------------
  // P5 — characterization: nack's delaySeconds never reaches the broker
  // ---------------------------------------------------------------------------

  /**
   * The delays a real backoff would ask for, including one far beyond any test
   * window: after each of them the payload must come back at once.
   */
  const NACK_DELAYS_SECONDS: readonly { readonly delaySeconds: number }[] = [
    { delaySeconds: 0 },
    { delaySeconds: 600 },
    { delaySeconds: 3_600 },
  ];

  it.each(NACK_DELAYS_SECONDS)(
    "nack(id, $delaySeconds) re-pushes the payload immediately, so the delay is ignored",
    async ({ delaySeconds }) => {
      const broker = installBroker();
      const { logger } = makeLogger();
      const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
      const envelope = makeQueueEnvelope();
      await queue.enqueue(envelope, "q:selfie");

      const [claimed] = await queue.claim("q:selfie", 1);
      if (claimed === undefined) {
        throw new Error("expected the enqueued payload to be claimable");
      }
      await queue.nack(claimed.messageId, delaySeconds);

      // No delayed structure and no delay argument: the nack emits exactly one
      // immediate re-push onto the same list key. The sorted-set upgrade that
      // would honour the delay (`ZADD` a score, promote with `ZRANGEBYSCORE`)
      // is named in the file docblock; this pin freezes today's shortcut.
      expect(broker.commands.map((command) => command[0])).toEqual(["LPUSH", "RPOP", "LPUSH"]);
      expect(broker.commands[2]).toEqual(["LPUSH", "q:selfie", JSON.stringify(envelope)]);

      // The delay is not honoured: the payload is claimable with no wait at all —
      // at 600 s and at 3 600 s just as at 0 s.
      const redelivered = await queue.claim("q:selfie", 1);
      expect(redelivered.map((message) => message.envelope)).toEqual([envelope]);
    }
  );

  // ---------------------------------------------------------------------------
  // P6 — RED by design: one poison payload must not cost the claimed batch
  // ---------------------------------------------------------------------------

  /**
   * The two payload corruptions `claim` has to contain: a payload that is not
   * JSON at all, and one that parses as JSON but is not a §10.4 envelope.
   */
  const POISON_PAYLOADS: readonly { readonly label: string; readonly payload: string }[] = [
    { label: "not JSON", payload: "{not-json" },
    { label: "not a §10.4 envelope", payload: JSON.stringify({ v: 1 }) },
  ];

  it.each(POISON_PAYLOADS)(
    "re-queues the batch's valid payloads when a middle payload is $label",
    async ({ payload }) => {
      const broker = installBroker();
      const { logger, sink } = makeLogger();
      const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
      const first = makeQueueEnvelope();
      const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
      broker.pop([JSON.stringify(first), payload, JSON.stringify(second)]);

      await expect(queue.claim("q:image", 3)).rejects.toBeInstanceOf(UpstreamContractError);

      // At-least-once (ADR-0684 §1): every §10.4-valid payload the one `RPOP`
      // removed is back on the list, in FIFO order, before the drift surfaced.
      const redelivered = await queue.claim("q:image", 3);
      expect(redelivered.map((message) => message.envelope)).toEqual([first, second]);

      // Only the poison is gone: nothing was re-pushed behind the valid payloads,
      // so the key cannot loop on a payload every claim would reject again.
      expect(await queue.claim("q:image", 3)).toEqual([]);

      // The loss that did happen is loud: exactly one drift record, naming the
      // claim, the provider and the queue key.
      const drift = sink.entries.filter((entry) => entry.event === DRIFT_EVENT);
      expect(drift).toHaveLength(1);
      expect(drift[0]?.level).toBe("error");
      expect(drift[0]?.provider).toBe("upstash");
      expect(drift[0]?.operation).toBe("claim");
      expect(drift[0]?.queueKey).toBe("q:image");
    }
  );

  it("re-queues the payloads that the one RPOP took after the poison", async () => {
    const broker = installBroker();
    const { logger } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const good = makeQueueEnvelope();
    broker.pop(["{not-json", JSON.stringify(good)]);

    await expect(queue.claim("q:image", 2)).rejects.toBeInstanceOf(UpstreamContractError);

    // Validation order is not the queue's order: the payload behind the poison
    // was already popped by the same `RPOP` and must not be lost either.
    const redelivered = await queue.claim("q:image", 2);
    expect(redelivered.map((message) => message.envelope)).toEqual([good]);
  });

  it("keeps claiming a batch that holds no malformed payload", async () => {
    const broker = installBroker();
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    broker.pop([JSON.stringify(first), JSON.stringify(second)]);

    const claimed = await queue.claim("q:image", 2);

    expect(claimed.map((message) => message.envelope)).toEqual([first, second]);
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toEqual([]);
  });

  it("still raises the drift, and re-queues nothing, when every payload is malformed", async () => {
    const broker = installBroker();
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    broker.pop(["{not-json"]);

    // Containment must not become silence: a batch with nothing salvageable is
    // still a raised drift, and the poison is not re-queued.
    await expect(queue.claim("q:image", 1)).rejects.toBeInstanceOf(UpstreamContractError);

    expect(await queue.claim("q:image", 1)).toEqual([]);
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // P7 — characterization: the claim ledger maps every id to its own payload
  // ---------------------------------------------------------------------------

  it("re-pushes the nacked message's own payload when the batch's second message is nacked", async () => {
    const broker = installBroker();
    const { logger } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    broker.pop([JSON.stringify(first), JSON.stringify(second)]);

    const claimed = await queue.claim("q:image", 2);
    const [firstClaimed, secondClaimed] = claimed;
    if (firstClaimed === undefined || secondClaimed === undefined) {
      throw new Error("expected both enqueued payloads to be claimable");
    }
    expect(claimed.map((message) => message.envelope)).toEqual([first, second]);
    expect(firstClaimed.messageId).not.toBe(secondClaimed.messageId);

    await queue.nack(secondClaimed.messageId, 0);

    // The ledger entry the second id was minted with must hold the second
    // payload's own bytes (ADR-0685 §1): a ledger keyed to one payload would
    // re-push a duplicate of `first` while `second`'s bytes — already removed
    // by the `RPOP` — were gone.
    const pushes = broker.commands.filter((command) => command[0] === "LPUSH");
    const lastPush = pushes[pushes.length - 1];
    expect(lastPush).toEqual(["LPUSH", "q:image", JSON.stringify(second)]);
    expect(lastPush?.[2]).not.toBe(JSON.stringify(first));

    // On the wire that is one message for a worker, and it is the nacked one.
    const redelivered = await queue.claim("q:image", 2);
    expect(redelivered.map((message) => message.envelope)).toEqual([second]);
  });

  // ---------------------------------------------------------------------------
  // P8 — characterization: a broker failure mid-rescue is a transport error
  // ---------------------------------------------------------------------------

  it("rejects a broker failure mid-rescue with a retryable TransportError and logs no drift", async () => {
    // The rescue pushes twice (two valid payloads); the second answers 503.
    const broker = installBrokerFailingPushes(2);
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    broker.pop([JSON.stringify(first), "{not-json", JSON.stringify(second)]);

    const outcome = await queue.claim("q:image", 3).then(
      () => "resolved" as const,
      (error: unknown) => error
    );

    // A 5xx is a transport failure a retry can fix, so it must surface as a
    // retryable `TransportError` and not as a contract drift: the rescue loop
    // throws before the drift is built (ADR-0686 §1).
    expect(outcome).toBeInstanceOf(TransportError);
    expect(outcome).not.toBeInstanceOf(UpstreamContractError);
    expect(outcome).toMatchObject({ code: "http", retryable: true, status: 503 });
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toEqual([]);

    // No partial success: the call rejected rather than handing the worker the
    // payload it managed to rescue, and that rescued payload is claimable again
    // on the next claim. `toContainEqual`, not `toEqual`: an at-least-once fix
    // that also recovers the payload the failed push dropped must not redden
    // this pin — its durability is F7 (OP-136 I1), deliberately not frozen here.
    const resumed = await queue.claim("q:image", 3);
    expect(resumed.map((message) => message.envelope)).toContainEqual(first);
  });

  // ---------------------------------------------------------------------------
  // P9 — characterization: one drift per claim, naming the first poison class
  // ---------------------------------------------------------------------------

  it("raises exactly one drift naming the first invalid class when the batch holds two", async () => {
    const broker = installBroker();
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    await queue.enqueue(first, "q:image");
    await queue.enqueue(second, "q:image");
    broker.pop([
      JSON.stringify(first),
      "{not-json",
      JSON.stringify({ v: 1 }),
      JSON.stringify(second),
    ]);

    await expect(queue.claim("q:image", 4)).rejects.toBeInstanceOf(UpstreamContractError);

    // Two poison classes, one record: the first invalid payload of the batch
    // decides both the count and the message (ADR-0685 §1 decision 3).
    const drift = sink.entries.filter((entry) => entry.event === DRIFT_EVENT);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.level).toBe("error");
    expect(drift[0]?.provider).toBe("upstash");
    expect(drift[0]?.operation).toBe("claim");
    expect(drift[0]?.queueKey).toBe("q:image");
    expect(drift[0]?.msg).toBe("A queued message was not JSON.");
    expect(drift[0]?.msg).not.toBe("A queued message did not match the §10.4 envelope.");

    // Both valid payloads were rescued around the two poison ones, in FIFO
    // order, and nothing is left behind for a third claim.
    const redelivered = await queue.claim("q:image", 4);
    expect(redelivered.map((message) => message.envelope)).toEqual([first, second]);
    expect(await queue.claim("q:image", 4)).toEqual([]);
  });
});
