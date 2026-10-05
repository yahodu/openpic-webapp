import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { novuTriggerRequestSchema } from "@/server/adapters/novu/schemas";
import { novuTransport } from "@/server/adapters/novu/novu-transport";
import { UpstreamContractError } from "@/server/adapters/transport-error";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import { makeNovuTriggerResponse, makeOutboundMessage } from "@/test/factories/transport";

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
