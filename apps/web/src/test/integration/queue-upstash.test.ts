/**
 * I1 + I2 — the Upstash queue adapter over the Redis REST protocol, and
 * `enqueueWork` writing `processing.queueRef` (OP-122).
 *
 * I1 pins the adapter against MSW (`apps/web/src/test/integration/setup.ts`
 * intercepts every outbound request; an unhandled one is a failure, never a live
 * network). The contract §10.4 message is a **pointer**, so the wire command
 * carries the envelope and nothing else, and the adapter parses the Upstash
 * response with Zod — a response whose shape changed is a contract violation
 * logged at `error` (`queue.upstream_contract_violation`, mirroring the
 * `payments.upstream_contract_violation` drift signal), not a silent success.
 *
 * I2 pins the durability rule of schema §18.1/§18.2: MongoDB holds the job
 * state, the broker is transport, so a failed enqueue must **never** fail the
 * user request — the item stays `queued` for the sweep to re-enqueue and the
 * failure is a `warn`, and `processing.queueRef` is the only place a broker id
 * ever appears.
 */
import { ObjectId } from "mongodb";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { memoryWorkQueue } from "@/server/adapters/memory-queue";
import { TransportError, UpstreamContractError } from "@/server/adapters/transport-error";
import { createUpstashQueue } from "@/server/adapters/upstash-queue";
import { COLLECTIONS } from "@/server/db/collections";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import { enqueueWork } from "@/server/queue/enqueue-work";
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

/** The drift event an unparseable Upstash response is logged as. */
const DRIFT_EVENT = "queue.upstream_contract_violation";

const TENANT_ID = objectIdHex(0x7e4a2);
const EVENT_ID = objectIdHex(0xe7e7f);

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

/** One captured Upstash REST call. */
interface CapturedCommand {
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: unknown;
}

/** How the mocked Upstash endpoint answers. */
type MockMode = "ok" | "changed-shape" | "not-json" | "server-error";

/**
 * Install the Upstash REST mock and record every command it receives.
 *
 * @param mode - The response shape to answer with.
 * @returns The captured commands, in call order.
 */
function installUpstashMock(mode: MockMode): { readonly captured: CapturedCommand[] } {
  const captured: CapturedCommand[] = [];

  server.use(
    http.post(UPSTASH_URL, async ({ request }) => {
      captured.push({
        method: request.method,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        body: await request.json(),
      });

      if (mode === "changed-shape") {
        return HttpResponse.json({ result: { pushed: "1" } });
      }
      if (mode === "not-json") {
        return HttpResponse.text("<html>bad gateway</html>");
      }
      if (mode === "server-error") {
        return HttpResponse.json({ error: "internal" }, { status: 500 });
      }
      return HttpResponse.json({ result: 1 });
    })
  );

  return { captured };
}

/** Read the Upstash command array out of a captured body, failing loudly. */
function commandOf(captured: CapturedCommand | undefined): readonly unknown[] {
  if (captured === undefined) {
    throw new Error("expected the adapter to call the Upstash REST endpoint");
  }
  if (!Array.isArray(captured.body)) {
    throw new Error(
      `expected the Upstash REST body to be a command array, got ${typeof captured.body}`
    );
  }
  return captured.body;
}

describe("upstashQueue (I1, contract §10.4)", () => {
  it("enqueues one LPUSH carrying the pointer envelope onto the physical queue key", async () => {
    const { logger } = makeLogger();
    const mock = installUpstashMock("ok");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const envelope = makeQueueEnvelope();

    const result = await queue.enqueue(envelope, "q:selfie");

    expect(queue.provider).toBe("upstash");
    const captured = mock.captured[0];
    expect(captured?.method).toBe("POST");
    expect(captured?.authorization).toBe(`Bearer ${UPSTASH_TOKEN}`);
    expect(captured?.contentType).toContain("application/json");

    const command = commandOf(captured);
    expect(command).toHaveLength(3);
    expect(command[0]).toBe("LPUSH");
    expect(command[1]).toBe("q:selfie");
    expect(JSON.parse(String(command[2]))).toEqual(envelope);
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it("mints a distinct message id for every enqueue", async () => {
    const { logger } = makeLogger();
    installUpstashMock("ok");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });

    const first = await queue.enqueue(makeQueueEnvelope(), "q:selfie");
    const second = await queue.enqueue(makeQueueEnvelope({ id: objectIdHex(0xbeef4) }), "q:selfie");

    expect(first.messageId).not.toBe(second.messageId);
  });

  it("refuses a changed Upstash response shape and logs the drift at error", async () => {
    const { logger, sink } = makeLogger();
    installUpstashMock("changed-shape");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });

    await expect(queue.enqueue(makeQueueEnvelope(), "q:selfie")).rejects.toBeInstanceOf(
      UpstreamContractError
    );

    const drift = sink.entries.filter((entry) => entry.event === DRIFT_EVENT);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.level).toBe("error");
    expect(drift[0]?.provider).toBe("upstash");
    expect(drift[0]?.operation).toBe("enqueue");
    expect(drift[0]?.queueKey).toBe("q:selfie");
    expect(JSON.stringify(sink.entries)).not.toContain(UPSTASH_TOKEN);
  });

  it("refuses a response that is not JSON as a contract violation, not a success", async () => {
    const { logger, sink } = makeLogger();
    installUpstashMock("not-json");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });

    await expect(queue.enqueue(makeQueueEnvelope(), "q:selfie")).rejects.toBeInstanceOf(
      UpstreamContractError
    );
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toHaveLength(1);
  });

  it("classifies a 5xx as a retryable transport failure, not a contract violation", async () => {
    const { logger, sink } = makeLogger();
    installUpstashMock("server-error");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });

    const failure = await queue
      .enqueue(makeQueueEnvelope(), "q:selfie")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({ retryable: true });
    expect(sink.entries.filter((entry) => entry.event === DRIFT_EVENT)).toEqual([]);
  });
});

describe("enqueueWork (I2, schema §18.1/§18.2)", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await startTestApp({ prefix: "op122-queue" });
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

  it("puts a selfie on q:selfie at high priority and records the broker id in queueRef only", async () => {
    const { logger } = makeLogger();
    const queue = memoryWorkQueue();
    const { id } = await seedWorkItem();

    const result = await enqueueWork({
      db: app.db,
      queue,
      collection: COLLECTIONS.eventImages,
      logger,
      clock: fixedClock(FIXTURE_ENQUEUED_AT),
      work: {
        kind: "selfie",
        id,
        tenantId: TENANT_ID,
        eventId: EVENT_ID,
        spaceKey: FIXTURE_SPACE_KEY,
        traceId: FIXTURE_TRACE_ID,
      },
    });

    expect(result.enqueued).toBe(true);
    const processing = await readProcessing(id);
    expect(processing.status).toBe("queued");
    expect(processing.queueRef).toEqual({
      queueKey: "q:selfie",
      provider: "memory",
      messageId: queue.outbox[0]?.messageId,
    });
    expect(queue.outbox[0]?.envelope).toEqual({
      v: 1,
      kind: "selfie",
      id,
      tenantId: TENANT_ID,
      eventId: EVENT_ID,
      priority: "high",
      spaceKey: FIXTURE_SPACE_KEY,
      enqueuedAt: FIXTURE_ENQUEUED_AT,
      attempt: 0,
      traceId: FIXTURE_TRACE_ID,
    });
  });

  it("puts an event image on q:image at normal priority", async () => {
    const { logger } = makeLogger();
    const queue = memoryWorkQueue();
    const { id } = await seedWorkItem();

    await enqueueWork({
      db: app.db,
      queue,
      collection: COLLECTIONS.eventImages,
      logger,
      clock: fixedClock(FIXTURE_ENQUEUED_AT),
      work: {
        kind: "event_image",
        id,
        tenantId: TENANT_ID,
        eventId: EVENT_ID,
        spaceKey: FIXTURE_SPACE_KEY,
        traceId: FIXTURE_TRACE_ID,
      },
    });

    expect(queue.outbox[0]?.queueKey).toBe("q:image");
    expect(queue.outbox[0]?.envelope.priority).toBe("normal");
    expect((await readProcessing(id)).queueRef).toEqual({
      queueKey: "q:image",
      provider: "memory",
      messageId: queue.outbox[0]?.messageId,
    });
  });

  it("leaves the item queued, logs a warning and never throws when the enqueue fails", async () => {
    const { logger, sink } = makeLogger();
    installUpstashMock("server-error");
    const queue = createUpstashQueue({ url: UPSTASH_URL, token: UPSTASH_TOKEN, logger });
    const { id } = await seedWorkItem();

    const result = await enqueueWork({
      db: app.db,
      queue,
      collection: COLLECTIONS.eventImages,
      logger,
      clock: fixedClock(FIXTURE_ENQUEUED_AT),
      work: {
        kind: "selfie",
        id,
        tenantId: TENANT_ID,
        eventId: EVENT_ID,
        spaceKey: FIXTURE_SPACE_KEY,
        traceId: FIXTURE_TRACE_ID,
      },
    });

    expect(result.enqueued).toBe(false);
    const processing = await readProcessing(id);
    expect(processing.status).toBe("queued");
    expect(processing.queueRef).toBeNull();

    const warning = sink.entries.find((entry) => entry.event === "queue.enqueue_failed");
    expect(warning?.level).toBe("warn");
    expect(warning?.queueKey).toBe("q:selfie");
    expect(warning?.kind).toBe("selfie");
  });
});
