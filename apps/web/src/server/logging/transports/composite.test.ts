import { describe, expect, it, vi } from "vitest";

import { makeLogEntry } from "../../../test/helpers/log-assertions";
import { compositeTransport, memoryTransport, type LogTransport } from "../index";

/**
 * Contract under test — `compositeTransport`, the fan-out used by the logger.
 *
 * Every transport is isolated: one throwing or rejecting transport must never
 * stop the others from receiving the entry, and the composite must never throw
 * into business code. Each failure is reported exactly once through the
 * injected `reportError` sink (which defaults to a single stderr line).
 */

function throwing(error: Error): LogTransport {
  return {
    write() {
      throw error;
    },
  };
}

function rejecting(error: Error): LogTransport {
  return {
    write: () => Promise.reject(error),
  };
}

describe("compositeTransport", () => {
  it("delivers the entry to the remaining transports when one throws", async () => {
    const good = memoryTransport();
    const reports: unknown[] = [];
    const composite = compositeTransport([throwing(new Error("boom")), good], {
      reportError: (error) => {
        reports.push(error);
      },
    });

    await composite.write(makeLogEntry({ msg: "fan-out" }));

    expect(good.entries.map((entry) => entry.msg)).toEqual(["fan-out"]);
    expect(reports).toHaveLength(1);
  });

  it("delivers the entry to the remaining transports when one rejects", async () => {
    const good = memoryTransport();
    const reports: unknown[] = [];
    const composite = compositeTransport([good, rejecting(new Error("nope"))], {
      reportError: (error) => {
        reports.push(error);
      },
    });

    await composite.write(makeLogEntry({ msg: "async fan-out" }));

    expect(good.entries.map((entry) => entry.msg)).toEqual(["async fan-out"]);
    expect(reports).toHaveLength(1);
  });

  it("resolves without throwing when every transport fails, reporting each once", async () => {
    const reports: unknown[] = [];
    const composite = compositeTransport([throwing(new Error("a")), rejecting(new Error("b"))], {
      reportError: (error) => {
        reports.push(error);
      },
    });

    await expect(composite.write(makeLogEntry())).resolves.toBeUndefined();
    expect(reports).toHaveLength(2);
  });

  it("reports the failure to stderr once by default", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const composite = compositeTransport([throwing(new Error("kaboom"))]);

      await expect(composite.write(makeLogEntry())).resolves.toBeUndefined();

      expect(stderr).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("flushes every transport", async () => {
    const flushed: string[] = [];
    const first: LogTransport = {
      write: () => undefined,
      flush: () => {
        flushed.push("first");
        return Promise.resolve();
      },
    };
    const second: LogTransport = {
      write: () => undefined,
      flush: () => {
        flushed.push("second");
        return Promise.resolve();
      },
    };

    await compositeTransport([first, second]).flush?.();

    expect([...flushed].sort()).toEqual(["first", "second"]);
  });
});
