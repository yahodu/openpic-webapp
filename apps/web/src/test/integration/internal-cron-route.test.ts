import { createHmac } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/v1/internal/cron/sample/route";
import { getConfig } from "@/server/config/env";
import { cronResultSchema } from "@/server/jobs/cron-job";

import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration / contract — the AUTHENTICATED surface of the shipped sample cron
 * route (OP-87 follow-up, contract §0.3/§10.2, ADR-0028).
 *
 * `internal-hmac.test.ts` drives `defineRoute` with a hand-built auth stage on a
 * synthetic path, and `apps/web/e2e/internal-cron.spec.ts` only ever presents a
 * WRONG or missing credential (the real `CRON_SECRET` is generated per-run by
 * the e2e launcher and never reaches the browser context). Neither pins what
 * happens when a caller presents a VALID credential to the real route module:
 * `apps/web/src/app/api/v1/internal/cron/sample/route.ts` could wire the auth
 * stage to the wrong secret, drop the `CRON_SECRET` cron exception, or call the
 * wrong job, and every existing spec would stay green.
 *
 * This file therefore imports the route's exported `GET`/`POST` handlers
 * directly and drives them in-process with credentials read back from the same
 * validated configuration the route reads (`getConfig()`), so the assertion is
 * on the observable HTTP status and §10.2 `CronResult` body — never on an
 * internal helper.
 */

const APP_ORIGIN = "http://localhost:3000";
const ROUTE = "/api/v1/internal/cron/sample";

/** A valid `INTERNAL_API_SECRET` (>= 32 chars) the signed POSTs are built from. */
const INTERNAL_SECRET = "test-internal-api-secret-0000000000000000";
/** A valid `CRON_SECRET` (>= 32 chars) Vercel Cron presents as a bearer. */
const CRON_SECRET = "test-cron-secret-0000000000000000000000";

beforeAll(() => {
  // The route reads its secrets through `getConfig()` per request, so the test
  // environment must carry the same fixed secrets it signs with. `getConfig()`
  // caches on its first call, which happens inside a request here — after this
  // hook has populated the environment.
  Object.assign(
    process.env,
    toProcessEnv(
      makeEnv({
        APP_ENV: "test",
        APP_BASE_URL: APP_ORIGIN,
        ALLOWED_ORIGINS: APP_ORIGIN,
        MONGODB_URI: process.env.MONGO_TEST_URI ?? "mongodb://localhost:27017/openpic_test",
        RATE_LIMIT_PROVIDER: "memory",
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        CRON_SECRET,
      })
    )
  );
});

/** The epoch-seconds header value for an instant. */
function timestampHeader(at: Date): string {
  return String(Math.floor(at.getTime() / 1000));
}

/** A `sha256=<hex>` signature header for a raw body. */
function signatureHeader(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** A `GET` to the sample route with the given bearer, optionally `?limit=`. */
function cronGet(authorization: string, limit?: string): Request {
  const url = new URL(ROUTE, APP_ORIGIN);
  if (limit !== undefined) {
    url.searchParams.set("limit", limit);
  }
  return new Request(url, { method: "GET", headers: { authorization } });
}

/** A `POST` to the sample route carrying a signed raw body at `signedAt`. */
function signedPost(body: string, secret: string, signedAt: Date): Request {
  return new Request(new URL(ROUTE, APP_ORIGIN), {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-signature": signatureHeader(secret, body),
      "x-timestamp": timestampHeader(signedAt),
    },
    body,
  });
}

/** The error envelope a pipeline denial is projected onto. */
interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

describe("the authenticated sample cron route (§10.2)", () => {
  it("I5: GET with the real CRON_SECRET bearer is 200 and a valid sample CronResult", async () => {
    const { cron } = getConfig();

    const response = await GET(cronGet(`Bearer ${cron.secret}`));

    expect(response.status).toBe(200);
    const result = cronResultSchema.parse(await response.json());
    expect(result.job).toBe("sample");
    expect(result.scanned).toBeGreaterThanOrEqual(0);
    expect(result.affected).toBeGreaterThanOrEqual(0);
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.hasMore).toBe(false);
  });

  it("I6: a signed POST with the internal secret is 200 and a valid CronResult", async () => {
    const { internal } = getConfig();
    const body = JSON.stringify({ source: "manual" });

    const response = await POST(signedPost(body, internal.apiSecret, new Date()));

    expect(response.status).toBe(200);
    const result = cronResultSchema.parse(await response.json());
    expect(result.job).toBe("sample");
  });

  it("I6: the same signed POST with a tampered body is 401 invalid_signature", async () => {
    const { internal } = getConfig();
    const body = JSON.stringify({ source: "manual" });
    const signed = signedPost(body, internal.apiSecret, new Date());
    // Re-wrap the signed request with a different body: the signature header is
    // copied verbatim, so the recomputed HMAC no longer matches.
    const tampered = new Request(signed, { body: JSON.stringify({ source: "attacker" }) });

    const response = await POST(tampered);

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("invalid_signature");
  });

  // The sample job is inert (`run` ignores its resolved limit), so the clamped
  // value is NOT observable in the returned CronResult. This pins only the
  // no-crash contract: every malformed or extreme `?limit=` still reaches the
  // handler and yields a 200 rather than a 500 from `clampLimit`.
  it.each(["abc", "-1", "0", "999999999999"])(
    "I7: GET with ?limit=%s still returns 200 (no crash)",
    async (limit) => {
      const { cron } = getConfig();

      const response = await GET(cronGet(`Bearer ${cron.secret}`, limit));

      expect(response.status).toBe(200);
      const result = cronResultSchema.parse(await response.json());
      expect(result.job).toBe("sample");
    }
  );
});
