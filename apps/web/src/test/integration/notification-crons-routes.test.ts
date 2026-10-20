import { beforeAll, describe, expect, it } from "vitest";

import { GET as digestFlushGET } from "@/app/api/v1/internal/cron/notification-digest-flush/route";
import { GET as dispatchRetryGET } from "@/app/api/v1/internal/cron/notification-dispatch-retry/route";
import { GET as quietHoursGET } from "@/app/api/v1/internal/cron/quiet-hours-release/route";
import { getConfig } from "@/server/config/env";
import { cronResultSchema } from "@/server/jobs/cron-job";

import { setupMongoTestEnv, MONGO_READY_HOOK_TIMEOUT_MS } from "../helpers/db";

/**
 * Integration / contract — the three notification crons are wired as bounded,
 * authenticated `/api/v1/internal/cron/**` routes (OP-96, contract §10.2;
 * ADR-0100).
 *
 * The job modules carry the behaviour (`notification-digest.test.ts`,
 * `notification-dispatch-retry.test.ts`, `notification-quiet-hours-release.test.ts`);
 * this spec pins only that each job is reachable at its documented route, behind
 * the internal cron guard, and returns the §10.2 `CronResult` envelope with its
 * own job name. It drives the route's exported `GET` directly (mirroring
 * `internal-cron-route.test.ts`) with a credential read back from the same
 * validated config the route reads, so the assertion is on the observable HTTP
 * status and body — never on an internal helper.
 *
 * Route ↔ job-name contract:
 *   - `.../cron/notification-digest-flush` → job `notification-digest-flush`
 *   - `.../cron/notification-dispatch-retry` → job `notification-dispatch-retry`
 *   - `.../cron/quiet-hours-release`        → job `quiet-hours-release`
 */

const APP_ORIGIN = "http://localhost:3000";

/** A valid `INTERNAL_API_SECRET` (>= 32 chars). */
const INTERNAL_SECRET = "test-internal-api-secret-0000000000000000";
/** A valid `CRON_SECRET` (>= 32 chars) Vercel Cron presents as a bearer. */
const CRON_SECRET = "test-cron-secret-0000000000000000000000";

/** The three route handlers and the §10.2 job name each must report. */
const ROUTES: readonly {
  readonly path: string;
  readonly job: string;
  readonly handler: (request: Request) => Promise<Response>;
}[] = [
  {
    path: "/api/v1/internal/cron/notification-digest-flush",
    job: "notification-digest-flush",
    handler: digestFlushGET,
  },
  {
    path: "/api/v1/internal/cron/notification-dispatch-retry",
    job: "notification-dispatch-retry",
    handler: dispatchRetryGET,
  },
  {
    path: "/api/v1/internal/cron/quiet-hours-release",
    job: "quiet-hours-release",
    handler: quietHoursGET,
  },
];

/** The error envelope a pipeline denial is projected onto. */
interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

beforeAll(async () => {
  await setupMongoTestEnv({
    APP_BASE_URL: APP_ORIGIN,
    ALLOWED_ORIGINS: APP_ORIGIN,
    RATE_LIMIT_PROVIDER: "memory",
    INTERNAL_API_SECRET: INTERNAL_SECRET,
    CRON_SECRET,
  });
}, MONGO_READY_HOOK_TIMEOUT_MS);

/** A `GET` to `path` with the given `authorization` header. */
function cronGet(path: string, authorization: string | null): Request {
  const url = new URL(path, APP_ORIGIN);
  return new Request(url, {
    method: "GET",
    headers: authorization === null ? {} : { authorization },
  });
}

describe("the notification cron routes are authenticated (§10.2)", () => {
  it.each(ROUTES)("$path rejects a missing credential with 401", async ({ path, handler }) => {
    const response = await handler(cronGet(path, null));

    expect(response.status).toBe(401);
    const envelope = (await response.json()) as unknown as ErrorEnvelope;
    expect(envelope.error.code).toBe("internal_auth_failed");
  });

  it.each(ROUTES)(
    "$path runs its job behind the cron secret and returns a $job CronResult",
    async ({ path, job, handler }) => {
      const { cron } = getConfig();

      const response = await handler(cronGet(path, `Bearer ${cron.secret}`));

      expect(response.status).toBe(200);
      const result = cronResultSchema.parse(await response.json());
      expect(result.job).toBe(job);
      expect(result.hasMore).toBe(false);
    }
  );
});
