import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv, type EnvInput } from "../../test/factories/env";

/**
 * Contract under test — transport selection from the environment.
 *
 * `createLoggerFromEnv()` builds the process logger from `getConfig()`:
 *   - `LOG_TRANSPORTS` is a comma list of transport names (`stdout`,
 *     `betterstack`) resolved to adapters — switching destinations is an env
 *     change, never a code change;
 *   - `LOG_LEVEL` becomes the level policy;
 *   - an unknown transport name fails fast with an error naming the value.
 */

type LoggingModule = typeof import("./index");

const ORIGINAL_ENV = process.env;

/** Import a fresh copy of the logging module under a replaced environment. */
async function loadLogging(env: EnvInput): Promise<LoggingModule> {
  vi.resetModules();

  const clean = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  process.env = { ...clean } as unknown as NodeJS.ProcessEnv;

  return import("./index");
}

/** Collect everything written to stdout while `run` executes. */
function captureStdout(run: () => void): string {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    run();
    return write.mock.calls.map((call) => String(call[0])).join("");
  } finally {
    write.mockRestore();
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("createLoggerFromEnv — transport selection", () => {
  it("writes a JSON line to stdout when LOG_TRANSPORTS=stdout", async () => {
    const { createLoggerFromEnv } = await loadLogging(
      makeEnv({ LOG_TRANSPORTS: "stdout", LOG_LEVEL: "info" })
    );

    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      createLoggerFromEnv().info("hello from env", { event: "e", requestId: "r" });
      output = write.mock.calls.map((call) => String(call[0])).join("");
    } finally {
      write.mockRestore();
    }

    expect(output).toContain("hello from env");

    const line = output
      .split("\n")
      .find((candidate) => candidate.includes("hello from env"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ level: "info", msg: "hello from env" });
  });

  it("honours LOG_LEVEL from the environment", async () => {
    const { createLoggerFromEnv } = await loadLogging(
      makeEnv({ LOG_TRANSPORTS: "stdout", LOG_LEVEL: "error" })
    );

    const output = captureStdout(() => {
      createLoggerFromEnv().info("should be dropped", { event: "e", requestId: "r" });
    });

    expect(output).not.toContain("should be dropped");
  });

  it("throws a configuration error naming an unknown transport", async () => {
    const { createLoggerFromEnv } = await loadLogging(makeEnv({ LOG_TRANSPORTS: "bogus" }));

    expect(() => createLoggerFromEnv()).toThrow(/bogus/);
  });

  it("fails fast naming BETTERSTACK_SOURCE_TOKEN when betterstack is selected without it", async () => {
    const { createLoggerFromEnv } = await loadLogging(makeEnv({ LOG_TRANSPORTS: "betterstack" }));

    expect(() => createLoggerFromEnv()).toThrow(/BETTERSTACK_SOURCE_TOKEN/);
  });
});
