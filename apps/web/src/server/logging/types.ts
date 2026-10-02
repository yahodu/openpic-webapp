/**
 * Public types for the structured logging port (US-003 / OP-71).
 *
 * Everything that business code is allowed to touch lives here — and only the
 * `Logger` port is exported for use outside `src/server/logging` (enforced by
 * the ESLint import-boundary rule). Transports are an implementation detail of
 * the port.
 */

/** The six structured log levels, ordered `trace < debug < info < warn < error < fatal`. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Fields a call site may attach to a log line.
 *
 * The well-known fields (`event`, `requestId`, `tenantId`, `userId`, `route`,
 * `durationMs`, `err`) are documented for discovery; any additional
 * string-keyed field is allowed and travels through unchanged.
 */
export interface LogFields {
  readonly event?: string;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly route?: string;
  readonly durationMs?: number;
  readonly err?: unknown;
  readonly [key: string]: unknown;
}

/** The JSON-safe projection of a thrown `Error` (see `serializeError`). */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

/** The canonical wire shape handed to every transport. */
export interface LogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly event?: string;
  readonly service?: string;
  readonly env?: string;
  readonly version?: string;
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly route?: string;
  readonly durationMs?: number;
  readonly err?: SerializedError;
  readonly [key: string]: unknown;
}

/**
 * The logging port.
 *
 * Call sites depend on this interface only. It never throws into business code:
 * a transport failure is reported out-of-band, never propagated.
 */
export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** Derive a logger whose bindings are merged over this one's, without mutating it. */
  child(bindings: LogFields): Logger;
  /** Await the flush of every underlying transport. */
  flush(): Promise<void>;
}

/** A destination for assembled log entries. */
export interface LogTransport {
  write(entry: LogEntry): void | Promise<void>;
  flush?(): void | Promise<void>;
}

/** A transport that records entries in memory, for tests and log-hygiene assertions. */
export interface MemoryTransport extends LogTransport {
  readonly entries: LogEntry[];
  clear(): void;
}

/** Construction options for `createLogger`. */
export interface LoggerConfig {
  readonly level: LogLevel;
  readonly transports: readonly LogTransport[];
  readonly base?: LogFields;
  readonly env?: string;
  readonly service?: string;
  readonly version?: string;
  readonly now?: () => Date;
  readonly reportError?: (error: unknown, transport?: LogTransport) => void;
}

/** Options for scoping a logger to a single inbound request. */
export interface RequestLoggerOptions {
  readonly route: string;
  readonly tenantId?: string;
  readonly userId?: string;
}

/** Options for the stdout (12-factor) transport. */
export interface StdoutJsonTransportOptions {
  readonly write?: (line: string) => void;
}

/** Options for the Better Stack ingest transport. */
export interface BetterStackTransportOptions {
  readonly sourceToken: string;
  readonly ingestHost?: string;
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly batchSize?: number;
}

/** Options for the fan-out transport. */
export interface CompositeTransportOptions {
  readonly reportError?: (error: unknown, transport?: LogTransport) => void;
}

/** A fan-out transport that isolates every member transport. */
export interface CompositeTransport extends LogTransport {
  write(entry: LogEntry): Promise<void>;
  flush?(): Promise<void>;
}
