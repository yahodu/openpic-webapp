import { getConfig, type AppConfig } from "../config/env";
import { REQUEST_ID_HEADER, getRequestContext, newRequestId } from "../runtime/request-context";
import { redactEntry } from "./redaction";
import { serializeError } from "./serialize-error";
import { betterStackTransport } from "./transports/better-stack";
import { compositeTransport } from "./transports/composite";
import { stdoutJsonTransport } from "./transports/stdout-json";
import type {
  CompositeTransport,
  LogEntry,
  LogFields,
  LogLevel,
  LogTransport,
  Logger,
  LoggerConfig,
  RequestLoggerOptions,
} from "./types";

export type {
  BetterStackTransportOptions,
  CompositeTransport,
  CompositeTransportOptions,
  LogEntry,
  LogFields,
  LogLevel,
  LogTransport,
  Logger,
  LoggerConfig,
  MemoryTransport,
  RequestLoggerOptions,
  SerializedError,
  StdoutJsonTransportOptions,
} from "./types";
export { betterStackTransport } from "./transports/better-stack";
export { compositeTransport } from "./transports/composite";
export { memoryTransport } from "./transports/memory";
export { stdoutJsonTransport } from "./transports/stdout-json";

/**
 * Numeric ordering of the levels: `trace < debug < info < warn < error < fatal`.
 *
 * Level policy (OP-68): the operator sets the floor with `LOG_LEVEL`; a call at
 * or above the floor is emitted, anything below is dropped. Production floors
 * at `info` unless overridden, so `debug`/`trace` never reach a vendor by
 * accident.
 */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function defaultNow(): Date {
  return new Date();
}

/**
 * Build a process-facing logger.
 *
 * The logger never throws into business code: transport failures are isolated
 * by an internal composite and reported out-of-band.
 *
 * @param config - Level, transports, default bindings and standard fields.
 * @returns The `Logger` port.
 */
export function createLogger(config: LoggerConfig): Logger {
  const composite: CompositeTransport = compositeTransport(
    config.transports,
    config.reportError === undefined ? {} : { reportError: config.reportError }
  );
  const now = config.now ?? defaultNow;

  const standard: LogFields = {
    ...(config.service === undefined ? {} : { service: config.service }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.version === undefined ? {} : { version: config.version }),
  };

  const build = (bindings: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[config.level]) {
        return;
      }

      const callFields: LogFields = fields ?? {};
      const merged: Record<string, unknown> = {
        ...standard,
        ...bindings,
        ...callFields,
        ts: now().toISOString(),
        level,
        msg,
      };

      if (merged.err !== undefined) {
        merged.err = serializeError(merged.err, config.env);
      }

      const entry = redactEntry(merged, callFields) as unknown as LogEntry;
      void composite.write(entry);
    };

    return {
      trace: (msg, fields) => {
        emit("trace", msg, fields);
      },
      debug: (msg, fields) => {
        emit("debug", msg, fields);
      },
      info: (msg, fields) => {
        emit("info", msg, fields);
      },
      warn: (msg, fields) => {
        emit("warn", msg, fields);
      },
      error: (msg, fields) => {
        emit("error", msg, fields);
      },
      fatal: (msg, fields) => {
        emit("fatal", msg, fields);
      },
      child: (childBindings) => build({ ...bindings, ...childBindings }),
      flush: () => composite.flush?.() ?? Promise.resolve(),
    };
  };

  return build({ ...standard, ...(config.base ?? {}) });
}

/** Resolve a `LOG_TRANSPORTS` entry to an adapter, failing fast on the unknown. */
function resolveTransport(name: string, config: AppConfig): LogTransport {
  switch (name) {
    case "stdout":
      return stdoutJsonTransport();
    case "betterstack": {
      const sourceToken = config.logging.betterStackSourceToken;
      if (sourceToken === undefined || sourceToken === "") {
        throw new Error(
          "LOG_TRANSPORTS selects 'betterstack' but BETTERSTACK_SOURCE_TOKEN is not set."
        );
      }
      const ingestHost = config.logging.betterStackIngestHost;
      return betterStackTransport({
        sourceToken,
        ...(ingestHost === undefined ? {} : { ingestHost }),
      });
    }
    default:
      throw new Error(`Unknown LOG_TRANSPORTS value: ${name}`);
  }
}

/**
 * Build the process logger from validated configuration.
 *
 * Transport selection is data, not code: changing `LOG_TRANSPORTS` changes the
 * destination with zero call-site changes.
 *
 * @returns The configured process logger.
 */
export function createLoggerFromEnv(): Logger {
  const config = getConfig();
  const transports = config.logging.transports.map((name) => resolveTransport(name, config));

  return createLogger({
    level: config.logging.level,
    transports,
    service: "openpic-web",
    env: config.app.env,
  });
}

let processLogger: Logger | undefined;

/** Install the process-wide logger that {@link requestLogger} derives from. */
export function setLogger(logger: Logger): void {
  processLogger = logger;
}

/**
 * Return the process-wide logger, lazily building it from the environment.
 *
 * The port must never throw into business code, so a configuration failure
 * here degrades to a plain stdout logger and is reported once on stderr rather
 * than turning a request into a 500. `createLoggerFromEnv()` remains the
 * fail-fast boot path.
 */
export function getLogger(): Logger {
  processLogger ??= buildProcessLoggerSafely();
  return processLogger;
}

/** Build the process logger, falling back to stdout if config is unavailable. */
function buildProcessLoggerSafely(): Logger {
  try {
    return createLoggerFromEnv();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[logging] using stdout transport: ${message}\n`);
    return createLogger({
      level: "info",
      transports: [stdoutJsonTransport()],
      service: "openpic-web",
    });
  }
}

/**
 * Scope the process logger to one inbound request.
 *
 * Binds the correlation `requestId`: inside a request scope (OP-72) it is the
 * context's resolved id, so every line agrees with the echoed `x-request-id`;
 * outside a request scope it falls back to the inbound header (or a freshly
 * minted `req_` id) for direct callers such as tests and scripts.
 *
 * @param request - The inbound request.
 * @param options - Route and optional tenant/user bindings.
 * @returns A child logger for the request.
 */
export function requestLogger(request: Request, options: RequestLoggerOptions): Logger {
  const context = getRequestContext();
  const requestId = context?.requestId ?? request.headers.get(REQUEST_ID_HEADER) ?? newRequestId();

  return getLogger().child({
    requestId,
    route: options.route,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
}
