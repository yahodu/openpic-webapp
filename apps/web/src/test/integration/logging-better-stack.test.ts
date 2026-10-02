import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { betterStackTransport, createLogger, memoryTransport } from "../../server/logging";
import { server } from "./setup";

/**
 * Integration — the Better Stack adapter against a mocked ingest endpoint.
 *
 * I1: MSW intercepts `POST https://in.logs.betterstack.com`; the request must
 *     carry `Authorization: Bearer <sourceToken>` and a JSON body that parses
 *     as a Logtail batch (an array of `{ dt, level, message }` items).
 * I2: a 500 from ingest is swallowed — `flush()` still resolves, the other
 *     transports still received the entry, and the failure is reported exactly
 *     once to stderr as `[logging] ...`.
 */

const BatchItemSchema = z.object({
  dt: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
});

const BatchSchema = z.array(BatchItemSchema).min(1);

const INGEST_URL = "https://in.logs.betterstack.com";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Better Stack ingest (MSW)", () => {
  it("POSTs a Logtail batch with the bearer token to the ingest endpoint", async () => {
    let authorization: string | null = null;
    let body: unknown = undefined;

    server.use(
      http.post(INGEST_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        body = await request.json();
        return new HttpResponse(null, { status: 202 });
      })
    );

    const logger = createLogger({
      level: "info",
      transports: [betterStackTransport({ sourceToken: "source-token-123" })],
    });

    logger.info("user signed in", { event: "auth.login.success", requestId: "req-1" });
    await logger.flush();

    expect(authorization).toBe("Bearer source-token-123");

    const parsed = BatchSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data[0]).toMatchObject({ level: "info", message: "user signed in" });
    }
  });

  it("swallows an ingest 500, reports once to stderr, and keeps serving other transports", async () => {
    server.use(
      http.post(INGEST_URL, () => new HttpResponse(null, { status: 500 }))
    );

    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const sink = memoryTransport();

    try {
      const logger = createLogger({
        level: "info",
        transports: [sink, betterStackTransport({ sourceToken: "source-token-123" })],
      });

      expect(() => {
        logger.info("upstream will fail", { event: "e", requestId: "req-2" });
      }).not.toThrow();

      await expect(logger.flush()).resolves.toBeUndefined();

      expect(sink.entries.map((entry) => entry.msg)).toEqual(["upstream will fail"]);

      const reports = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("[logging]"));
      expect(reports).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });
});
