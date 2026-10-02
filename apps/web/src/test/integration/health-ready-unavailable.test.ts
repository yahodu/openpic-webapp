import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../app/api/v1/health/ready/route";
import { setReadinessProbe } from "../../server/db/readiness";
import {
  createLogger,
  memoryTransport,
  setLogger,
  type MemoryTransport,
} from "../../server/logging";
import { makeEnv, toProcessEnv } from "../factories/env";
import { expectNoSecretsInLogs } from "../helpers/log-assertions";

/**
 * Integration contract — `GET /api/v1/health/ready` when the database is down.
 *
 * The readiness probe must FAIL SAFE: a rejected ping is a `503` with
 * `{ status: "unavailable" }`, never a 500 that leaks internals, and the
 * failure is reported once at `warn`.
 *
 * The connection string is a credential-bearing secret and must never reach a
 * log transport, so `MONGODB_URI` is set to a distinctive sentinel value and
 * the emitted entries are asserted to contain neither the full URI nor its
 * user/password. The ping is stubbed with the readiness probe seam, so this
 * spec needs no reachable database.
 */
const SENTINEL_URI = "mongodb://sentinel-user:sentinel-secret@db.sentinel.internal:27017/openpic";
const SENTINEL_USER = "sentinel-user";
const SENTINEL_SECRET = "sentinel-secret";

let sink: MemoryTransport;

beforeEach(() => {
  Object.assign(process.env, toProcessEnv(makeEnv({ APP_ENV: "test", MONGODB_URI: SENTINEL_URI })));

  sink = memoryTransport();
  setLogger(
    createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "test-sha",
    })
  );

  // Simulate the driver's ping rejecting (database unreachable).
  setReadinessProbe(() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:27017")));
});

afterEach(() => {
  setReadinessProbe(undefined);
});

describe("GET /api/v1/health/ready — database unavailable", () => {
  it("I5: returns 503 with { status: 'unavailable' } when the ping rejects", async () => {
    const response = await GET(new Request("http://localhost/api/v1/health/ready"));

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("I5: warns without leaking the connection string", async () => {
    await GET(new Request("http://localhost/api/v1/health/ready"));

    const warn = sink.entries.find((entry) => entry.level === "warn");
    expect(warn).toBeDefined();

    const serialized = JSON.stringify(warn);
    expect(serialized).not.toContain(SENTINEL_URI);
    expect(serialized).not.toContain(SENTINEL_USER);
    expect(serialized).not.toContain(SENTINEL_SECRET);
    expectNoSecretsInLogs(sink);
  });
});
