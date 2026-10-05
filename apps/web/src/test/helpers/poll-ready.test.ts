import { afterEach, describe, expect, it, vi } from "vitest";

import { MONGO_READY_RETRY_MS, MONGO_READY_TIMEOUT_MS, pollReady } from "./poll-ready";

/**
 * Unit contract — `src/test/helpers/poll-ready.ts`.
 *
 * OP-85 follow-up (reviewer finding, t_d025a82c / PR #155): the Mongo readiness
 * retry loop and its budget constants were duplicated between
 * `test/helpers/db.ts` (`waitForMongoReady`) and
 * `test/integration/global-setup.ts` (`waitForPrimary`). `pollReady` is the ONE
 * low-level poll both wrappers delegate to, so a change to the readiness budget
 * can never silently diverge between the worker suites and the setup process.
 *
 * The helper is dependency-light on purpose: `global-setup.ts` runs in the
 * Vitest setup process before `MONGODB_URI` exists, so this module must not
 * import `@/server/db/mongo` or `../factories/env`. It is a genuine readiness
 * probe (retry the real `ping`), never a fixed sleep, and fails loudly once the
 * budget is exhausted.
 */
describe("pollReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the first probe succeeds, without sleeping", async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => Promise.resolve());

    await expect(
      pollReady({
        ping,
        timeoutMs: MONGO_READY_TIMEOUT_MS,
        retryMs: MONGO_READY_RETRY_MS,
        timeoutMessage: () => "should not time out",
      })
    ).resolves.toBeUndefined();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries the probe until it succeeds, then resolves", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const ping = vi.fn(() => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(new Error("not ready")) : Promise.resolve();
    });

    const promise = pollReady({
      ping,
      timeoutMs: 1_000,
      retryMs: 100,
      timeoutMessage: () => "should not time out",
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it("waits the configured retry delay between probes", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const ping = vi.fn(() => {
      attempts += 1;
      return attempts < 2 ? Promise.reject(new Error("not ready")) : Promise.resolve();
    });

    const promise = pollReady({
      ping,
      timeoutMs: 1_000,
      retryMs: 100,
      timeoutMessage: () => "should not time out",
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(ping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("fails loudly with the supplied message once the budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cause = new Error("connection refused");
    const ping = vi.fn(() => Promise.reject(cause));

    const promise = pollReady({
      ping,
      timeoutMs: 300,
      retryMs: 100,
      timeoutMessage: (timeoutMs: number) =>
        `MongoDB replica set did not become ready within ${String(timeoutMs)}ms`,
    }).then(
      () => {
        throw new Error("pollReady resolved unexpectedly");
      },
      (error: unknown) => error as Error
    );

    await vi.advanceTimersByTimeAsync(1_000);

    const error = await promise;
    expect(error.message).toBe("MongoDB replica set did not become ready within 300ms");
    expect(error.cause).toBe(cause);
  });

  it("keeps the fail-loud message builder's timeout in sync with the budget used", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const ping = vi.fn(() => Promise.reject(new Error("not ready")));
    const timeoutMessage = vi.fn((timeoutMs: number) => `custom ${String(timeoutMs)}ms`);

    const promise = pollReady({
      ping,
      timeoutMs: 250,
      retryMs: 50,
      timeoutMessage,
    }).then(
      () => {
        throw new Error("pollReady resolved unexpectedly");
      },
      (error: unknown) => error as Error
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await promise;

    expect(timeoutMessage).toHaveBeenCalledWith(250);
    expect(error.message).toBe("custom 250ms");
  });

  it("pins the shared readiness budget and retry delay in one place", () => {
    expect(MONGO_READY_TIMEOUT_MS).toBe(30_000);
    expect(MONGO_READY_RETRY_MS).toBe(250);
  });
});
