import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../app/api/v1/health/ready/route";
import { closeMongoClient } from "../../server/db/mongo";
import { createLogger, memoryTransport, setLogger } from "../../server/logging";
import { makeEnv, toProcessEnv } from "../factories/env";

/**
 * Integration contract — `GET /api/v1/health/ready` against a real database.
 *
 * The readiness probe is the dependency-aware sibling of the liveness probe:
 * it pings MongoDB and answers:
 *
 *   200 { status: "ok" }        when the database answers
 *   503 { status: "unavailable" } when it does not (see the unavailable spec)
 *
 * It must carry the same wire hygiene as every JSON response — a JSON content
 * type and `Cache-Control: no-store` — so an orchestrator never caches a
 * readiness decision.
 *
 * This spec runs against the `MongoMemoryReplSet` from the integration
 * `globalSetup` (the singleton client reads `MONGODB_URI`), proving that the
 * probe really reaches the driver and that a live database yields 200.
 */
beforeAll(() => {
  const uri = process.env.MONGO_TEST_URI;
  if (!uri) {
    throw new Error(
      "MONGO_TEST_URI is not set — the integration globalSetup must start a MongoMemoryReplSet"
    );
  }

  Object.assign(process.env, toProcessEnv(makeEnv({ APP_ENV: "test", MONGODB_URI: uri })));
});

beforeEach(() => {
  const sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );
});

afterAll(async () => {
  await closeMongoClient();
});

describe("GET /api/v1/health/ready", () => {
  it("I4: returns 200 with { status: 'ok' } when the database answers", async () => {
    const response = await GET(new Request("http://localhost/api/v1/health/ready"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
