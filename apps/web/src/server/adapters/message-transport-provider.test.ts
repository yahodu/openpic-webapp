import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv, type EnvInput } from "@/test/factories/env";
import { makeNovuTriggerResponse, makeOutboundMessage } from "@/test/factories/transport";

/**
 * Unit contract — the config-driven `MessageTransport` factory
 * (`@/server/adapters/message-transport-provider`, OP-95 / ADR-0096; extended
 * by the OP-94 §1 follow-up, ADR-0105 / ADR-0106).
 *
 * `getMessageTransport()` maps the validated `MESSAGE_TRANSPORT` selector onto a
 * concrete adapter. Until this spec only the `memory` branch was ever executed
 * (ADR-0106 "Coverage gap"), so two properties of the non-memory branch are
 * pinned here against a mocked Novu origin (MSW, no live network):
 *
 *   U1  With a non-memory provider selected and a key configured, the returned
 *       transport POSTs the trigger to `<NOVU_BASE_URL>/v1/events/trigger`
 *       carrying `ApiKey <NOVU_API_KEY>` and returns the provider receipt.
 *
 *   U2  A non-memory provider selected with `NOVU_API_KEY` unset or blank is a
 *       misconfiguration that must fail closed at selection time, not at first
 *       send: the factory refuses to build a transport and names the missing
 *       key (never its value). This mirrors `getRateLimitConfig()`, which
 *       refuses a `redis` selection without Upstash credentials, and
 *       `getConfig()`, which refuses `memory` in production.
 *
 * ## Intended RED
 *
 * U2 is deliberately RED against the merged implementation at 49126f4, where
 * the branch builds `novuTransport({ apiKey: "" })` and only fails on the first
 * `send()`. The implementation must not be changed in the TEST lane; a GREEN
 * child is raised for `openpic-webapp-backend-coder` (see ADR-0107).
 *
 * `MESSAGE_TRANSPORT` accepts only `memory | ses` (`config/env.ts`
 * `PROVIDER_SPECS`), and `ses` is the documented non-memory selection outside
 * production; the provider factory maps it onto the Novu adapter.
 */

const NOVU_BASE_URL = "https://novu.example.test";
const NOVU_TRIGGER_URL = `${NOVU_BASE_URL}/v1/events/trigger`;

const ORIGINAL_ENV = process.env;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  process.env = ORIGINAL_ENV;
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  server.close();
});

/**
 * Import a fresh copy of the factory under a given environment, so the config
 * module's "parse once" cache cannot leak between the two selections.
 *
 * @param overrides - Environment overrides on top of a valid development env.
 * @returns The factory plus the `ConfigError` class the same env module raises.
 */
async function loadProvider(overrides: EnvInput): Promise<{
  readonly getMessageTransport: () => import("@/server/notifications/message-transport").MessageTransport;
  readonly ConfigError: new (keys: readonly string[]) => Error;
}> {
  const env = makeEnv({ APP_ENV: "development", MESSAGE_TRANSPORT: "ses", ...overrides });
  const clean = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  process.env = { ...clean } as unknown as NodeJS.ProcessEnv;

  const envModule = await import("@/server/config/env");
  const { getMessageTransport } = await import("@/server/adapters/message-transport-provider");
  return { getMessageTransport, ConfigError: envModule.ConfigError };
}

describe("getMessageTransport — non-memory provider (U1)", () => {
  it("POSTs the trigger to <NOVU_BASE_URL>/v1/events/trigger with the configured key", async () => {
    // Arrange
    let authorization: string | null = null;
    let body: unknown = undefined;
    server.use(
      http.post(NOVU_TRIGGER_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        body = await request.json();
        return HttpResponse.json(makeNovuTriggerResponse({ transactionId: "txn-factory-1" }));
      })
    );

    const { getMessageTransport } = await loadProvider({
      NOVU_BASE_URL,
      NOVU_API_KEY: "factory-novu-key",
    });

    // Act
    const transport = getMessageTransport();
    const receipt = await transport.send(
      makeOutboundMessage({
        channel: "email",
        to: { userId: "user-1", email: "ada@example.com" },
      })
    );

    // Assert
    expect(authorization).toBe("ApiKey factory-novu-key");
    expect(body).toMatchObject({
      name: "transport-email",
      to: { subscriberId: "user-1", email: "ada@example.com" },
    });
    expect(receipt).toEqual({ providerMessageId: "txn-factory-1" });
  });
});

describe("getMessageTransport — non-memory provider without a key (U2, intended RED)", () => {
  it.each([
    ["unset", undefined],
    ["blank", ""],
  ])("refuses to build a transport when NOVU_API_KEY is %s", async (_label, apiKey) => {
    // Arrange
    const { getMessageTransport, ConfigError } = await loadProvider({
      NOVU_BASE_URL,
      NOVU_API_KEY: apiKey,
    });

    // Act
    let thrown: unknown;
    try {
      getMessageTransport();
    } catch (error) {
      thrown = error;
    }

    // Assert
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(/NOVU_API_KEY/);
  });
});
