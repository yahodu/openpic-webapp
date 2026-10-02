import { describe, expect, it } from "vitest";

import { createLogger, memoryTransport } from "./index";

/**
 * Contract under test — error serialization on the `err` field.
 *
 * The port serializes an `Error` into `err: { name, message, code?, stack?,
 * cause? }`:
 *   - `code` is carried over from the error when present (an `AppError`'s
 *     stable machine code);
 *   - `cause` is walked recursively up to a depth of 5 — the 6th cause is
 *     dropped, bounding payload size;
 *   - in production the `stack` is omitted for non-5xx errors (4xx denial
 *     noise) but kept for 5xx; outside production the stack is always kept.
 */

class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status?: number; cause?: unknown }) {
    super(message);
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status ?? 500;
    if (options.cause !== undefined) {
      Object.assign(this, { cause: options.cause });
    }
  }
}

/** Build an `Error` whose `cause` chain is set without relying on lib es2022. */
function errorWithCause(message: string, cause?: unknown): Error {
  const error = new Error(message);
  return cause === undefined ? error : Object.assign(error, { cause });
}

describe("error serialization — shape", () => {
  it("includes name, message and code from an AppError", () => {
    const sink = memoryTransport();
    createLogger({ level: "error", transports: [sink] }).error("denied", {
      event: "e",
      requestId: "r",
      err: new AppError("not allowed", { code: "E_FORBIDDEN", status: 403 }),
    });

    expect(sink.entries[0]?.err).toMatchObject({
      name: "AppError",
      message: "not allowed",
      code: "E_FORBIDDEN",
    });
  });

  it("walks the cause chain up to depth 5", () => {
    const sink = memoryTransport();

    let deep: Error = new Error("deep-6");
    for (let depth = 5; depth >= 0; depth -= 1) {
      deep = errorWithCause(`level-${String(depth)}`, deep);
    }

    createLogger({ level: "error", transports: [sink] }).error("failed", {
      event: "e",
      requestId: "r",
      err: deep,
    });

    const err = sink.entries[0]?.err;
    expect(err?.message).toBe("level-0");
    expect(err?.cause?.message).toBe("level-1");
    expect(err?.cause?.cause?.message).toBe("level-2");
    expect(err?.cause?.cause?.cause?.message).toBe("level-3");
    expect(err?.cause?.cause?.cause?.cause?.message).toBe("level-4");
    expect(err?.cause?.cause?.cause?.cause?.cause?.message).toBe("level-5");
    expect(err?.cause?.cause?.cause?.cause?.cause?.cause).toBeUndefined();
  });

  it("preserves a cause chain shorter than the depth limit in full", () => {
    const sink = memoryTransport();

    const err = errorWithCause("outer", errorWithCause("inner"));

    createLogger({ level: "error", transports: [sink] }).error("failed", {
      event: "e",
      requestId: "r",
      err,
    });

    expect(sink.entries[0]?.err?.message).toBe("outer");
    expect(sink.entries[0]?.err?.cause?.message).toBe("inner");
  });
});

describe("error serialization — stack policy", () => {
  it("omits the stack for a 4xx error in production", () => {
    const sink = memoryTransport();
    createLogger({ level: "error", transports: [sink], env: "production" }).error("denied", {
      event: "e",
      requestId: "r",
      err: new AppError("not allowed", { code: "E_FORBIDDEN", status: 403 }),
    });

    expect(sink.entries[0]?.err?.stack).toBeUndefined();
  });

  it("keeps the stack for a 5xx error in production", () => {
    const sink = memoryTransport();
    createLogger({ level: "error", transports: [sink], env: "production" }).error("crashed", {
      event: "e",
      requestId: "r",
      err: new AppError("boom", { code: "E_INTERNAL", status: 500 }),
    });

    expect(typeof sink.entries[0]?.err?.stack).toBe("string");
  });

  it("keeps the stack for a 4xx error outside production", () => {
    const sink = memoryTransport();
    createLogger({ level: "error", transports: [sink], env: "development" }).error("denied", {
      event: "e",
      requestId: "r",
      err: new AppError("not allowed", { code: "E_FORBIDDEN", status: 403 }),
    });

    expect(typeof sink.entries[0]?.err?.stack).toBe("string");
  });
});
