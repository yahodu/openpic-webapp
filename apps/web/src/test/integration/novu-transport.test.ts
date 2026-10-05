import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { novuTriggerRequestSchema } from "@/server/adapters/novu/schemas";
import { novuTransport } from "@/server/adapters/novu/novu-transport";
import { runWorkflowUpsert } from "@/server/adapters/novu/upsert-workflows";
import { UpstreamContractError } from "@/server/adapters/transport-error";
import {
  createLogger,
  memoryTransport,
  type Logger,
  type LogEntry,
  type MemoryTransport,
} from "@/server/logging";
import type { OutboundMessage } from "@/server/notifications/message-transport";
import {
  makeCanonicalTransportWorkflows,
  makeNovuTriggerResponse,
  makeNovuWorkflowList,
  makeOutboundMessage,
} from "@/test/factories/transport";

import { server } from "./setup";

/**
 * I1–I4 — the Novu `MessageTransport` adapter against a mocked Novu API.
 *
 * I1: an email send POSTs the pass-through trigger body (validated by the
 *     request Zod schema) with the API-key header, and returns the provider
 *     message id taken from the response transaction id.
 * I2: a response whose shape changed raises `UpstreamContractError` and is
 *     logged at `error` (a contract break is never retryable).
 * I3: a 503 from Novu is a retryable failure.
 * I4: a request that outlives the configured timeout is aborted, and the
 *     failure is a retryable timeout.
 */

const NOVU_BASE_URL = "https://api.novu.co";
const NOVU_API_KEY = "test-novu-api-key";
const TRIGGER_URL = `${NOVU_BASE_URL}/v1/events/trigger`;
const CONTRACT_VIOLATION_EVENT = "transport.upstream_contract_violation";

/** Build a logger wired to a memory sink so a test can inspect emitted entries. */
function installLogger(): { readonly logger: Logger; readonly sink: MemoryTransport } {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "trace",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    base: { requestId: "req-transport-test" },
  });
  return { logger, sink };
}

describe("novuTransport (MSW)", () => {
  it("I1: posts the expected trigger body with the API-key header and returns the transaction id", async () => {
    // Arrange
    let authorization: string | null = null;
    let body: unknown = undefined;
    server.use(
      http.post(TRIGGER_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        body = await request.json();
        return HttpResponse.json(makeNovuTriggerResponse({ transactionId: "txn-abc-123" }));
      })
    );

    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY });
    const message = makeOutboundMessage({
      channel: "email",
      to: { userId: "user-1", email: "ada@example.com" },
      subject: "Welcome to OpenPic",
      html: "<p>Hello Ada</p>",
      text: "Hello Ada",
    });

    // Act
    const receipt = await transport.send(message);

    // Assert
    expect(authorization).toBe(`ApiKey ${NOVU_API_KEY}`);

    const parsed = novuTriggerRequestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).toMatchObject({
      name: "transport-email",
      to: { subscriberId: "user-1", email: "ada@example.com" },
      payload: { subject: "Welcome to OpenPic", html: "<p>Hello Ada</p>", text: "Hello Ada" },
    });

    expect(receipt).toEqual({ providerMessageId: "txn-abc-123" });
  });

  it("I2: a changed response shape raises UpstreamContractError and logs it at error", async () => {
    // Arrange
    const { logger, sink } = installLogger();
    server.use(
      http.post(TRIGGER_URL, () =>
        HttpResponse.json({ data: { acknowledged: true, status: "processed" } })
      )
    );

    const transport = novuTransport({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Act
    const send = transport.send(makeOutboundMessage());

    // Assert
    await expect(send).rejects.toBeInstanceOf(UpstreamContractError);

    const entry = sink.entries.find((logged) => logged.event === CONTRACT_VIOLATION_EVENT);
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
  });

  it("I3: a 503 from Novu is a retryable failure", async () => {
    // Arrange
    server.use(http.post(TRIGGER_URL, () => new HttpResponse(null, { status: 503 })));

    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY });

    // Act
    const send = transport.send(makeOutboundMessage());

    // Assert
    await expect(send).rejects.toMatchObject({ retryable: true, status: 503 });
  });

  it("I4: a request that outlives the configured timeout is aborted as a retryable timeout", async () => {
    // Arrange
    let aborted = false;
    server.use(
      http.post(TRIGGER_URL, ({ request }) => {
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            resolve(new HttpResponse(null, { status: 499 }));
          });
        });
      })
    );

    const transport = novuTransport({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      timeoutMs: 25,
    });

    // Act
    const send = transport.send(makeOutboundMessage());

    // Assert
    await expect(send).rejects.toMatchObject({ retryable: true, code: "timeout" });
    expect(aborted).toBe(true);
  });
});

/**
 * I6–I18 — the OP-92 RED-pins follow-up (ADR-0074).
 *
 * §2 the memory outbox (`memoryMessageTransport`) records every rendered
 *    `OutboundMessage` and returns a provider message id; it is a distinct port
 *    from the logging memory sink (`memoryTransport`, whose `entries` hold log
 *    lines).
 * §5 the workflow upsert engine creates exactly the three transport workflows —
 *    one active step each, channel matching the name — and is idempotent on a
 *    second run. A failure is logged at `error` and surfaced as a non-zero exit.
 * §6 `OutboundMessage.headers` (`List-Unsubscribe`, `List-Unsubscribe-Post`) are
 *    passed through into the trigger body at `payload.headers`; a message
 *    without headers omits the path entirely.
 * security_and_logging_requirements: a successful send logs `transport.sent` at
 *    `info` with `channel`/`provider`/`messageId`; no entry on any path may carry
 *    `html`, `text`, or a contact value.
 */

const WORKFLOWS_URL = `${NOVU_BASE_URL}/v1/workflows`;

/** The subset of the trigger body the header pins navigate. */
interface TriggerBody {
  readonly name: string;
  readonly to: Record<string, string>;
  readonly payload: Record<string, unknown>;
}

/** Recursively collect every key name on a value graph. */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectKeys(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      key,
      ...collectKeys(nested),
    ]);
  }
  return [];
}

/**
 * Assert that no entry on the whole sink carries a rendered body or a contact.
 *
 * Values are checked as canaries, and the key names are checked so a leaked
 * contact cannot hide behind the port's value redaction (which preserves the
 * key and masks the value).
 */
function expectNoSensitiveContent(entries: readonly LogEntry[]): void {
  const serialized = JSON.stringify(entries);
  expect(serialized).not.toContain("ultra-secret-html-body-9f2");
  expect(serialized).not.toContain("ultra-secret-text-body-9f2");
  expect(serialized).not.toContain("leak-canary-9f2@example.com");
  expect(serialized).not.toContain("+15550000092");

  const keys = collectKeys(entries).map((key) => key.toLowerCase());
  expect(keys).not.toContain("html");
  expect(keys).not.toContain("text");
  expect(keys).not.toContain("email");
  expect(keys).not.toContain("phonee164");
}

/** A rendered message whose body and contacts must never reach a log sink. */
function makeSensitiveMessage(): OutboundMessage {
  return makeOutboundMessage({
    channel: "email",
    subject: "Sensitive send",
    html: "<p>ultra-secret-html-body-9f2</p>",
    text: "ultra-secret-text-body-9f2",
    to: {
      userId: "user-9f2",
      email: "leak-canary-9f2@example.com",
      phoneE164: "+15550000092",
    },
  });
}

describe("memoryMessageTransport (§2 outbox)", () => {
  it("I6: records every OutboundMessage and returns a provider message id", async () => {
    // Arrange
    const transport = memoryMessageTransport();
    const message = makeOutboundMessage({ channel: "email", subject: "Recorded" });

    // Act
    const receipt = await transport.send(message);

    // Assert
    expect(receipt).toEqual({ providerMessageId: expect.any(String) });
    expect(receipt.providerMessageId.length).toBeGreaterThan(0);
    expect(transport.outbox).toEqual([message]);
  });

  it("I7: appends sends in order and mints a distinct id per send", async () => {
    // Arrange
    const transport = memoryMessageTransport();
    const first = makeOutboundMessage({ subject: "first" });
    const second = makeOutboundMessage({
      channel: "sms",
      subject: "second",
      to: { userId: "user-2", phoneE164: "+15550000002" },
    });

    // Act
    const firstReceipt = await transport.send(first);
    const secondReceipt = await transport.send(second);

    // Assert
    expect(transport.outbox).toEqual([first, second]);
    expect(firstReceipt.providerMessageId).not.toBe(secondReceipt.providerMessageId);
  });

  it("I8: is a separate port from the logging memory sink", async () => {
    // Arrange
    const outbox = memoryMessageTransport();
    const sink = memoryTransport();

    // Act
    await outbox.send(makeOutboundMessage());

    // Assert
    expect(outbox.outbox).toHaveLength(1);
    expect(sink.entries).toHaveLength(0);
  });
});

describe("runWorkflowUpsert (§5 workflows as code, MSW)", () => {
  it("I9: creates exactly the three transport workflows with one active matching step each", async () => {
    // Arrange
    let authorization: string | null = null;
    const posted: Record<string, unknown>[] = [];
    server.use(
      http.get(WORKFLOWS_URL, () => HttpResponse.json(makeNovuWorkflowList([]))),
      http.post(WORKFLOWS_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        const body = (await request.json()) as Record<string, unknown>;
        posted.push(body);
        return new HttpResponse(null, { status: 201 });
      })
    );
    const { logger } = installLogger();

    // Act
    const exitCode = await runWorkflowUpsert({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Assert
    expect(exitCode).toBe(0);
    expect(authorization).toBe(`ApiKey ${NOVU_API_KEY}`);
    expect(posted).toHaveLength(3);
    expect(posted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowId: "transport-email",
          name: "transport-email",
          active: true,
          steps: [{ active: true, template: { type: "email" } }],
        }),
        expect.objectContaining({
          workflowId: "transport-sms",
          name: "transport-sms",
          active: true,
          steps: [{ active: true, template: { type: "sms" } }],
        }),
        expect.objectContaining({
          workflowId: "transport-whatsapp",
          name: "transport-whatsapp",
          active: true,
          steps: [{ active: true, template: { type: "whatsapp" } }],
        }),
      ])
    );
  });

  it("I10: creates no workflows on a second run when all three already exist", async () => {
    // Arrange
    let postCount = 0;
    server.use(
      http.get(WORKFLOWS_URL, () =>
        HttpResponse.json(makeNovuWorkflowList(makeCanonicalTransportWorkflows()))
      ),
      http.post(WORKFLOWS_URL, () => {
        postCount += 1;
        return new HttpResponse(null, { status: 201 });
      })
    );
    const { logger } = installLogger();

    // Act
    const exitCode = await runWorkflowUpsert({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Assert
    expect(exitCode).toBe(0);
    expect(postCount).toBe(0);
  });

  it("I11: logs at error and exits non-zero when the workflow API fails", async () => {
    // Arrange
    server.use(http.get(WORKFLOWS_URL, () => new HttpResponse(null, { status: 500 })));
    const { logger, sink } = installLogger();

    // Act
    const exitCode = await runWorkflowUpsert({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
    });

    // Assert
    expect(exitCode).not.toBe(0);
    const entry = sink.entries.find(
      (logged) => logged.event === "transport.workflow_upsert_failed"
    );
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("error");
  });
});

describe("novuTransport email headers (§6)", () => {
  it("I12: posts List-Unsubscribe headers at payload.headers", async () => {
    // Arrange
    let body: TriggerBody | undefined;
    server.use(
      http.post(TRIGGER_URL, async ({ request }) => {
        body = (await request.json()) as TriggerBody;
        return HttpResponse.json(makeNovuTriggerResponse());
      })
    );
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY });
    const headers = {
      "List-Unsubscribe": "<mailto:unsubscribe@openpic.in>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };

    // Act
    await transport.send(makeOutboundMessage({ channel: "email", headers }));

    // Assert
    expect(body?.payload.headers).toEqual(headers);
  });

  it("I13: omits payload.headers when the message carries none", async () => {
    // Arrange
    let body: TriggerBody | undefined;
    server.use(
      http.post(TRIGGER_URL, async ({ request }) => {
        body = (await request.json()) as TriggerBody;
        return HttpResponse.json(makeNovuTriggerResponse());
      })
    );
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY });

    // Act
    await transport.send(makeOutboundMessage({ channel: "email" }));

    // Assert
    expect(body?.payload.headers).toBeUndefined();
  });
});

describe("novuTransport logging (security_and_logging_requirements)", () => {
  it("I14: a successful send logs transport.sent at info with channel, provider and messageId", async () => {
    // Arrange
    server.use(
      http.post(TRIGGER_URL, () =>
        HttpResponse.json(makeNovuTriggerResponse({ transactionId: "txn-log-1" }))
      )
    );
    const { logger, sink } = installLogger();
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY, logger });

    // Act
    const receipt = await transport.send(makeOutboundMessage({ channel: "email" }));

    // Assert
    const entry = sink.entries.find((logged) => logged.event === "transport.sent");
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("info");
    expect(entry).toMatchObject({
      channel: "email",
      provider: "novu",
      messageId: receipt.providerMessageId,
    });
  });

  it("I15: never logs the message body or contacts on a successful send", async () => {
    // Arrange
    server.use(http.post(TRIGGER_URL, () => HttpResponse.json(makeNovuTriggerResponse())));
    const { logger, sink } = installLogger();
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY, logger });

    // Act
    await transport.send(makeSensitiveMessage());

    // Assert
    expectNoSensitiveContent(sink.entries);
  });

  it("I16: never logs the message body or contacts on a contract violation", async () => {
    // Arrange
    server.use(http.post(TRIGGER_URL, () => HttpResponse.json({ data: { acknowledged: true } })));
    const { logger, sink } = installLogger();
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY, logger });

    // Act / Assert
    await expect(transport.send(makeSensitiveMessage())).rejects.toBeInstanceOf(
      UpstreamContractError
    );
    expectNoSensitiveContent(sink.entries);
  });

  it("I17: never logs the message body or contacts on a retryable failure", async () => {
    // Arrange
    server.use(http.post(TRIGGER_URL, () => new HttpResponse(null, { status: 503 })));
    const { logger, sink } = installLogger();
    const transport = novuTransport({ baseUrl: NOVU_BASE_URL, apiKey: NOVU_API_KEY, logger });

    // Act / Assert
    await expect(transport.send(makeSensitiveMessage())).rejects.toMatchObject({ retryable: true });
    expectNoSensitiveContent(sink.entries);
  });

  it("I18: never logs the message body or contacts on a timeout", async () => {
    // Arrange
    server.use(
      http.post(TRIGGER_URL, ({ request }) => {
        return new Promise<Response>((resolve) => {
          request.signal.addEventListener("abort", () => {
            resolve(new HttpResponse(null, { status: 499 }));
          });
        });
      })
    );
    const { logger, sink } = installLogger();
    const transport = novuTransport({
      baseUrl: NOVU_BASE_URL,
      apiKey: NOVU_API_KEY,
      logger,
      timeoutMs: 25,
    });

    // Act / Assert
    await expect(transport.send(makeSensitiveMessage())).rejects.toMatchObject({
      retryable: true,
      code: "timeout",
    });
    expectNoSensitiveContent(sink.entries);
  });
});
