import { createHmac } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { isoDateTimeSchema } from "@openpic/contracts";

import { internalAuthStage } from "@/server/auth/internal-hmac";
import { defineRoute } from "@/server/http/define-route";
import { defineCronJob } from "@/server/jobs/cron-job";
import { createLogger, memoryTransport } from "@/server/logging";
import { fixedClock } from "@/server/runtime/clock";

import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration / contract — internal HMAC routes and the cron job framework
 * (OP-87, contract §0.3/§10.2).
 *
 * These specs drive the real `defineRoute` pipeline in-process with the
 * internal auth stage wired on, so the observable surface is the HTTP
 * status/body and the captured log line — never an internal helper.
 *
 * Contract expected of the implementation:
 *
 *   - `@/server/auth/internal-hmac` exports
 *     `internalAuthStage({ internalApiSecret, cronSecret, clock? }) -> RouteStage`.
 *     It reads the raw request body once, verifies
 *     `Authorization: Bearer <INTERNAL_API_SECRET>` + `X-Signature: sha256=<hex HMAC>`
 *     + `X-Timestamp` (±300 s) and throws the catalogue `AppError` on failure.
 *   - A correct HMAC request reaches the handler (`200`); a replay whose
 *     timestamp is past the skew is `401 stale_signature`.
 *   - `@/server/jobs/cron-job` `defineCronJob(...).run(...)` returns the §10.2
 *     `CronResult` and logs `cron.<name>.completed`.
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/internal/test/echo";
const INTERNAL_SECRET = "test-internal-secret-0000000000000000";
const CRON_SECRET = "test-cron-secret-000000000000000000";
const NOW = new Date("2026-01-02T03:04:05.000Z");

beforeAll(() => {
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: process.env.MONGO_TEST_URI ?? "mongodb://localhost:27017/openpic_test",
        RATE_LIMIT_PROVIDER: "memory",
      })
    )
  );
});

/** The epoch-seconds header value for an instant. */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** A `sha256=<hex>` signature header for a raw body. */
function signatureHeader(body: string): string {
  return `sha256=${createHmac("sha256", INTERNAL_SECRET).update(body, "utf8").digest("hex")}`;
}

/** A route guarded by the internal auth stage, returning `{ ok: true }`. */
function internalRoute() {
  return defineRoute({
    route: ROUTE,
    response: z.object({ ok: z.boolean() }),
    env: "test",
    auth: internalAuthStage({
      internalApiSecret: INTERNAL_SECRET,
      cronSecret: CRON_SECRET,
      clock: fixedClock(NOW),
    }),
    handler: () => ({ body: { ok: true } }),
  });
}

/** Build a POST request with a signed body at the given timestamp instant. */
function signedPost(body: string, signedAt: Date): Request {
  return new Request(new URL(ROUTE, APP_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${INTERNAL_SECRET}`,
      "content-type": "application/json",
      "x-signature": signatureHeader(body),
      "x-timestamp": timestampHeader(signedAt),
    },
    body,
  });
}

describe("internal HMAC routes over the pipeline (I1–I2)", () => {
  it("I1: a POST with a correct HMAC and fresh timestamp is 200", async () => {
    const route = internalRoute();
    const body = JSON.stringify({ ping: true });

    const response = await route(signedPost(body, NOW));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("I2: replaying the same request 10 minutes later is 401 stale_signature", async () => {
    const route = internalRoute();
    const body = JSON.stringify({ ping: true });
    const signedAt = new Date(NOW.getTime() - 600_000);

    const response = await route(signedPost(body, signedAt));

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("stale_signature");
  });

  it("I2: a tampered body under a valid bearer is 401 invalid_signature", async () => {
    const route = internalRoute();
    const signedBody = JSON.stringify({ ping: true });
    const request = signedPost(signedBody, NOW);
    const tampered = new Request(request, { body: JSON.stringify({ ping: false }) });

    const response = await route(tampered);

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("invalid_signature");
  });

  it("I2: a wrong bearer is 401 internal_auth_failed", async () => {
    const route = internalRoute();
    const body = JSON.stringify({ ping: true });
    const request = new Request(new URL(ROUTE, APP_ORIGIN), {
      method: "POST",
      headers: {
        authorization: "Bearer not-the-internal-secret",
        "content-type": "application/json",
        "x-signature": signatureHeader(body),
        "x-timestamp": timestampHeader(NOW),
      },
      body,
    });

    const response = await route(request);

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as { error: { code: string } };
    expect(envelope.error.code).toBe("internal_auth_failed");
  });
});

describe("cron job framework (I3)", () => {
  const CronResultSchema = z.object({
    job: z.string().min(1),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    scanned: z.number().int().nonnegative(),
    affected: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  });

  it("I3: a sample job run returns a valid CronResult and logs a summary", async () => {
    const transport = memoryTransport();
    const logger = createLogger({
      level: "info",
      transports: [transport],
      service: "openpic-web",
      env: "test",
    });

    const job = defineCronJob({
      name: "sample",
      defaultLimit: 500,
      maxLimit: 2000,
      run: () =>
        Promise.resolve({
          scanned: 12,
          affected: 4,
          skipped: 8,
          errors: 0,
          hasMore: true,
          details: { reenqueued: 4 },
        }),
    });

    const result = await job.run({
      requestedLimit: "5000",
      clock: fixedClock(NOW, 90),
      logger,
    });

    expect(CronResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      job: "sample",
      scanned: 12,
      affected: 4,
      skipped: 8,
      errors: 0,
      hasMore: true,
    });

    const entry = transport.entries.find(
      (candidate) => candidate.event === "cron.sample.completed"
    );
    expect(entry).toBeDefined();
    expect(entry?.level).toBe("info");
    expect(entry).toMatchObject({ job: "sample", scanned: 12, affected: 4, hasMore: true });
  });
});
