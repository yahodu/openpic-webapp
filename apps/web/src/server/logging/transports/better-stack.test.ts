import { describe, expect, it } from "vitest";
import { z } from "zod";

import { makeLogEntry } from "../../../test/helpers/log-assertions";
import { betterStackTransport, type LogLevel } from "../index";

/**
 * Contract under test — `betterStackTransport`, the Better Stack adapter.
 *
 * The adapter buffers entries and, on `flush()`, POSTs a Logtail-shaped JSON
 * batch to the ingest host with `Authorization: Bearer <sourceToken>`.
 *
 * Level mapping onto the Better Stack levels: trace -> debug, debug -> debug,
 * info -> info, warn -> warn, and both error and fatal -> error (fatal is
 * reported at the error-compatible core level the vendor guarantees).
 */

const BatchItemSchema = z.object({
  dt: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});

const BatchSchema = z.array(BatchItemSchema);

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function makeFetch(calls: CapturedRequest[], status = 202): FetchLike {
  return (input, init) => {
    calls.push({ url: input, init });
    return Promise.resolve(new Response(null, { status }));
  };
}

function parseBatch(calls: CapturedRequest[]): z.infer<typeof BatchSchema> {
  const body = calls[0]?.init?.body;
  return BatchSchema.parse(typeof body === "string" ? JSON.parse(body) : undefined);
}

const LEVEL_MAPPING_CASES: [LogLevel, string][] = [
  ["trace", "debug"],
  ["debug", "debug"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
  ["fatal", "error"],
];

describe("betterStackTransport — level mapping", () => {
  it.each(LEVEL_MAPPING_CASES)(
    "maps the %s level to the Better Stack level %s",
    async (level, expected) => {
      const calls: CapturedRequest[] = [];
      const transport = betterStackTransport({ sourceToken: "tok", fetch: makeFetch(calls) });

      await transport.write(makeLogEntry({ level }));
      await transport.flush?.();

      expect(parseBatch(calls)[0]?.level).toBe(expected);
    }
  );
});

describe("betterStackTransport — ingest request", () => {
  it("POSTs the batch to the default ingest host with the bearer token", async () => {
    const calls: CapturedRequest[] = [];
    const transport = betterStackTransport({ sourceToken: "tok-xyz", fetch: makeFetch(calls) });

    await transport.write(makeLogEntry());
    await transport.flush?.();

    expect(calls[0]?.url).toBe("https://in.logs.betterstack.com");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-xyz");
  });

  it("uses the configured ingest host when one is provided", async () => {
    const calls: CapturedRequest[] = [];
    const transport = betterStackTransport({
      sourceToken: "tok",
      ingestHost: "https://logs.internal.test",
      fetch: makeFetch(calls),
    });

    await transport.write(makeLogEntry());
    await transport.flush?.();

    expect(calls[0]?.url).toBe("https://logs.internal.test");
  });

  it("carries the entry message and an ISO timestamp in the batch item", async () => {
    const calls: CapturedRequest[] = [];
    const transport = betterStackTransport({ sourceToken: "tok", fetch: makeFetch(calls) });

    await transport.write(makeLogEntry({ msg: "user signed in" }));
    await transport.flush?.();

    const item = parseBatch(calls)[0];
    expect(item?.message).toBe("user signed in");
    expect(Number.isNaN(Date.parse(item?.dt ?? ""))).toBe(false);
  });

  it("rejects flush when the ingest request fails, so the composite can report it", async () => {
    const calls: CapturedRequest[] = [];
    const transport = betterStackTransport({
      sourceToken: "tok",
      fetch: makeFetch(calls, 500),
    });

    await transport.write(makeLogEntry());

    await expect(transport.flush?.()).rejects.toThrow();
  });
});
