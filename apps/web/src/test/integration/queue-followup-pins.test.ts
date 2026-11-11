/**
 * OP-122 round-1 review follow-up pins (ADR-0682), at the OP-122 GREEN head
 * (`5f28acd`).
 *
 * Six findings the shipped OP-122 specs left blind. Two of them are **RED by
 * design** — they describe the code the review found and must fail until the
 * follow-up GREEN lands:
 *
 * - **P1** `enqueueWork` calls `queue.enqueue(...)` *before* it builds the
 *   `ObjectId` and never parses the envelope, so a pointer the strict §10.4
 *   schema rejects reaches the broker while the call reports `{enqueued:false}`
 *   (invalid id) or even reports success (empty `spaceKey`, non-hex `tenantId`).
 * - **P2** the Upstash adapter builds no `AbortController`, so a hung broker
 *   never settles: the user request hangs and `classifyTransportFailure`'s
 *   `timeout` branch is unreachable.
 *
 * Four are **characterization** pins — they describe what the adapter does
 * today and are expected to be **green on arrival**, so a later reader does not
 * mistake a green run for a red pin that failed to bite:
 *
 * - **P3** `ack`/`nack` on an id this process never minted is a silent no-op
 *   (the process-local `claimed` ledger; the payload is already gone).
 * - **P4** the two adapters disagree on where a retry goes: memory redelivers
 *   in place, Upstash re-`LPUSH`es to the head and therefore serves it last.
 * - **P5** `nack`'s `delaySeconds` never reaches the Upstash broker.
 * - **P6** one malformed payload costs the whole claimed batch — the good
 *   payloads are dropped and never re-`LPUSH`ed.
 *
 * The pins drive the real modules over MSW (`integration/setup.ts` intercepts
 * every outbound request) and the Mongo memory server, never a stubbed
 * collaborator, so a behaviour-preserving refactor keeps them green and a
 * regression breaks the named case.
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
  /** Set the payloads the next `RPOP` answers with. */
  pop(payloads: readonly string[]): void;
}

/**
 * Install the Upstash REST mock with the two documented commands.
 *
 * `LPUSH` answers with the new list length, `RPOP` with the payloads a case
 * armed through {@link MockBroker.pop}. No list is emulated: the case asserts
 * on the *commands*, which is the observable wire contract.
 *
 * @returns The captured commands and the `RPOP` arming function.
 */
function installBroker(): MockBroker {
  const commands: (readonly unknown[])[] = [];
  let popped: readonly string[] = [];

  server.use(
    http.post(UPSTASH_URL, async ({ request }) => {
      const raw: unknown = await request.json();
      if (!Array.isArray(raw)) {
        throw new Error("expected the Upstash REST body to be a command array");
      }
      commands.push(raw);
      return raw[0] === "RPOP"
        ? HttpResponse.json({ result: popped })
        : HttpResponse.json({ result: commands.length });
    })
  );

  return {
    commands,
    pop: (payloads) => {
      popped = [...payloads];
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
  // P4 — characterization: the two adapters disagree on where a retry goes
  // ---------------------------------------------------------------------------

  it("memory redelivers a nacked message in place, before a message enqueued after it", async () => {
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

    expect(redelivered.map((message) => message.envelope)).toEqual([first, second]);
  });

  it("upstash re-LPUSHes a nacked payload to the head, so the tail-draining claim serves it last", async () => {
    const broker = installBroker();
    const { logger } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const first = makeQueueEnvelope();
    const second = makeQueueEnvelope({ id: objectIdHex(0xbeef2) });
    await queue.enqueue(first, "q:image");
    await queue.enqueue(second, "q:image");
    broker.pop([JSON.stringify(first), JSON.stringify(second)]);

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

  it("nack(id, 600) sends one immediate LPUSH, so the payload is claimable at once", async () => {
    const broker = installBroker();
    const { logger } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const envelope = makeQueueEnvelope();
    await queue.enqueue(envelope, "q:selfie");
    broker.pop([JSON.stringify(envelope)]);

    const [claimed] = await queue.claim("q:selfie", 1);
    if (claimed === undefined) {
      throw new Error("expected the enqueued payload to be claimable");
    }
    await queue.nack(claimed.messageId, 600);

    // The delayed sorted set a real backoff needs is never touched: the only
    // command the nack emits is the immediate re-push.
    expect(broker.commands).toHaveLength(3);
    expect(broker.commands[2]).toEqual(["LPUSH", "q:selfie", JSON.stringify(envelope)]);

    broker.pop([JSON.stringify(envelope)]);
    const redelivered = await queue.claim("q:selfie", 1);
    expect(redelivered.map((message) => message.envelope)).toEqual([envelope]);
  });

  // ---------------------------------------------------------------------------
  // P6 — characterization: one malformed payload costs the whole claimed batch
  // ---------------------------------------------------------------------------

  const MALFORMED_BATCHES: readonly {
    readonly label: string;
    readonly payload: (good: string) => readonly string[];
  }[] = [
    { label: "the second payload is not JSON", payload: (good) => [good, "{not-json"] },
    {
      label: "the second payload is not a §10.4 envelope",
      payload: (good) => [good, JSON.stringify({ v: 1 })],
    },
  ];

  it.each(MALFORMED_BATCHES)("drops the whole claimed batch when $label", async ({ payload }) => {
    const broker = installBroker();
    const { logger, sink } = makeLogger();
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const good = makeQueueEnvelope();
    broker.pop(payload(JSON.stringify(good)));

    await expect(queue.claim("q:image", 2)).rejects.toBeInstanceOf(UpstreamContractError);

    // One RPOP removed both payloads; nothing is re-LPUSHed, so the good
    // payload is gone until the (not yet existing, OP-136 I1) sweep re-enqueues it.
    expect(broker.commands).toHaveLength(1);
    expect(broker.commands[0]?.[0]).toBe("RPOP");
    expect(broker.commands.filter((command) => command[0] === "LPUSH")).toEqual([]);
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toHaveLength(1);
  });
});
