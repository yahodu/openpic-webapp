import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  memoryTransport,
  requestLogger,
  setLogger,
  type LogLevel,
  type LogTransport,
} from "./index";

/**
 * Contract under test — the `Logger` port (`src/server/logging`), US-003.
 *
 * `createLogger(config)` builds the process-facing logger:
 *   - `trace|debug|info|warn|error|fatal(msg, fields?)` emit one entry each,
 *     dropping anything below `config.level` (trace < debug < info < warn <
 *     error < fatal);
 *   - `child(bindings)` returns a new logger whose bindings are merged over
 *     the parent's WITHOUT mutating the parent;
 *   - `flush()` resolves only after every transport's `flush()` has settled;
 *   - the port NEVER throws into business code, whatever a transport does.
 *
 * `requestLogger(request, { route })` scopes a logger to one request, deriving
 * `requestId` from the `x-request-id` header (or generating one) and binding
 * `route`. `setLogger` installs the process-wide logger that `requestLogger`
 * derives from.
 */

const ALL_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

describe("createLogger — level policy", () => {
  it("drops entries below the configured level and keeps the rest", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "warn", transports: [sink] });

    logger.trace("at-trace", { event: "e", requestId: "r" });
    logger.debug("at-debug", { event: "e", requestId: "r" });
    logger.info("at-info", { event: "e", requestId: "r" });
    logger.warn("at-warn", { event: "e", requestId: "r" });
    logger.error("at-error", { event: "e", requestId: "r" });
    logger.fatal("at-fatal", { event: "e", requestId: "r" });

    expect(sink.entries.map((entry) => entry.msg)).toEqual(["at-warn", "at-error", "at-fatal"]);
  });

  it("emits every level when the configured level is trace", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "trace", transports: [sink] });

    logger.trace("at-trace", { event: "e", requestId: "r" });
    logger.debug("at-debug", { event: "e", requestId: "r" });
    logger.info("at-info", { event: "e", requestId: "r" });
    logger.warn("at-warn", { event: "e", requestId: "r" });
    logger.error("at-error", { event: "e", requestId: "r" });
    logger.fatal("at-fatal", { event: "e", requestId: "r" });

    expect(sink.entries.map((entry) => entry.level)).toEqual([...ALL_LEVELS]);
  });

  it("keeps a message whose level equals the configured level (boundary)", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "info", transports: [sink] });

    logger.debug("below", { event: "e", requestId: "r" });
    logger.info("at", { event: "e", requestId: "r" });

    expect(sink.entries.map((entry) => entry.msg)).toEqual(["at"]);
  });
});

describe("createLogger — standard fields", () => {
  it("includes service, env, version and every supplied field on the entry", () => {
    const sink = memoryTransport();
    const logger = createLogger({
      level: "info",
      transports: [sink],
      service: "openpic-web",
      env: "test",
      version: "abc123",
    });

    logger.info("request completed", {
      event: "http.request",
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      route: "/api/v1/health",
      durationMs: 42,
    });

    expect(sink.entries[0]).toMatchObject({
      level: "info",
      msg: "request completed",
      event: "http.request",
      service: "openpic-web",
      env: "test",
      version: "abc123",
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
      route: "/api/v1/health",
      durationMs: 42,
    });
  });

  it("stamps the timestamp from the injected clock", () => {
    const sink = memoryTransport();
    const logger = createLogger({
      level: "info",
      transports: [sink],
      now: () => new Date("2026-02-03T04:05:06.000Z"),
    });

    logger.info("x", { event: "e", requestId: "r" });

    expect(sink.entries[0]?.ts).toBe("2026-02-03T04:05:06.000Z");
  });
});

describe("createLogger — child loggers", () => {
  it("merges bindings into the child without mutating the parent", () => {
    const sink = memoryTransport();
    const parent = createLogger({
      level: "info",
      transports: [sink],
      base: { service: "openpic-web", requestId: "req-1" },
    });
    const child = parent.child({ tenantId: "tenant-1" });

    parent.info("from parent", { event: "a" });
    child.info("from child", { event: "b" });

    expect(sink.entries[0]).toMatchObject({
      msg: "from parent",
      service: "openpic-web",
      requestId: "req-1",
    });
    expect(sink.entries[0]?.tenantId).toBeUndefined();
    expect(sink.entries[1]).toMatchObject({
      msg: "from child",
      service: "openpic-web",
      requestId: "req-1",
      tenantId: "tenant-1",
    });
  });

  it("accumulates bindings across nested children", () => {
    const sink = memoryTransport();
    const root = createLogger({
      level: "info",
      transports: [sink],
      base: { requestId: "req-1" },
    });

    const grandchild = root.child({ tenantId: "tenant-1" }).child({ userId: "user-1" });
    grandchild.info("deep", { event: "e" });

    expect(sink.entries[0]).toMatchObject({
      requestId: "req-1",
      tenantId: "tenant-1",
      userId: "user-1",
    });
  });

  it("lets per-call fields override inherited bindings", () => {
    const sink = memoryTransport();
    const child = createLogger({
      level: "info",
      transports: [sink],
      base: { requestId: "req-1", tenantId: "tenant-1" },
    }).child({ userId: "user-1" });

    child.info("override", { event: "e", tenantId: "tenant-2" });

    expect(sink.entries[0]?.tenantId).toBe("tenant-2");
  });
});

describe("createLogger — flush", () => {
  it("resolves after every transport's flush has completed", async () => {
    let slowFlushed = false;
    let fastFlushed = false;

    const slow: LogTransport = {
      write: () => undefined,
      flush: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        slowFlushed = true;
      },
    };
    const fast: LogTransport = {
      write: () => undefined,
      flush: () => {
        fastFlushed = true;
        return Promise.resolve();
      },
    };

    const logger = createLogger({ level: "info", transports: [slow, fast] });
    await logger.flush();

    expect(fastFlushed).toBe(true);
    expect(slowFlushed).toBe(true);
  });

  it("does not resolve before a transport's flush has settled", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let flushed = false;
    const gated: LogTransport = {
      write: () => undefined,
      flush: () =>
        gate.then(() => {
          flushed = true;
        }),
    };

    const logger = createLogger({ level: "info", transports: [gated] });
    const pending = logger.flush();

    await Promise.resolve();
    expect(flushed).toBe(false);

    release();
    await pending;
    expect(flushed).toBe(true);
  });
});

describe("createLogger — never throws into business code", () => {
  it("swallows a synchronous transport failure", () => {
    const bad: LogTransport = {
      write() {
        throw new Error("transport down");
      },
    };
    const logger = createLogger({
      level: "info",
      transports: [bad],
      reportError: () => undefined,
    });

    expect(() => {
      logger.info("x", { event: "e", requestId: "r" });
    }).not.toThrow();
  });

  it("reports a rejected async transport write without surfacing it to the caller", async () => {
    const reports: unknown[] = [];
    const bad: LogTransport = {
      write: () => Promise.reject(new Error("boom")),
    };
    const logger = createLogger({
      level: "info",
      transports: [bad],
      reportError: (error) => {
        reports.push(error);
      },
    });

    logger.info("x", { event: "e", requestId: "r" });

    await vi.waitFor(() => {
      expect(reports).toHaveLength(1);
    });
  });
});

describe("createLogger — safe serialization", () => {
  it("serializes a circular reference instead of throwing", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "info", transports: [sink] });

    const circular: Record<string, unknown> = { event: "e", requestId: "r" };
    circular.self = circular;

    expect(() => {
      logger.info("circular", circular);
    }).not.toThrow();

    const entry = sink.entries[0];
    expect(entry).toBeDefined();
    expect(() => JSON.stringify(entry)).not.toThrow();
    expect(entry?.self).toBe("[Circular]");
  });
});

describe("requestLogger", () => {
  it("derives requestId from the x-request-id header and binds the route", () => {
    const sink = memoryTransport();
    setLogger(
      createLogger({
        level: "info",
        transports: [sink],
        service: "openpic-web",
        env: "test",
        version: "abc123",
      })
    );

    const request = new Request("http://localhost/api/v1/health", {
      headers: { "x-request-id": "req-9" },
    });
    requestLogger(request, { route: "/api/v1/health" }).info("hi", { event: "http.request" });

    expect(sink.entries[0]).toMatchObject({
      requestId: "req-9",
      route: "/api/v1/health",
      event: "http.request",
    });
  });

  it("generates a requestId when the header is absent", () => {
    const sink = memoryTransport();
    setLogger(createLogger({ level: "info", transports: [sink] }));

    const request = new Request("http://localhost/api/v1/health");
    requestLogger(request, { route: "/api/v1/health" }).info("hi", { event: "http.request" });

    const requestId = sink.entries[0]?.requestId;
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toBe("");
  });
});
