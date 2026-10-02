import type { BetterStackTransportOptions, LogEntry, LogLevel, LogTransport } from "../types";

/** Default Better Stack (Logtail) ingest endpoint. */
const DEFAULT_INGEST_HOST = "https://in.logs.betterstack.com";

/** The level names the Better Stack ingest endpoint accepts. */
type BetterStackLevel = "debug" | "info" | "warn" | "error";

/** A single item in a Logtail batch. */
interface LogtailBatchItem {
  readonly dt: string;
  readonly level: BetterStackLevel;
  readonly message: string;
  readonly [key: string]: unknown;
}

/**
 * Map a port level onto the Better Stack level set.
 *
 * `fatal` is reported at the vendor-guaranteed `error` core level (there is no
 * distinct fatal level on ingest).
 */
function toBetterStackLevel(level: LogLevel): BetterStackLevel {
  switch (level) {
    case "trace":
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
    case "fatal":
      return "error";
  }
}

function toBatchItem(entry: LogEntry): LogtailBatchItem {
  return {
    ...entry,
    dt: entry.ts,
    level: toBetterStackLevel(entry.level),
    message: entry.msg,
  };
}

/**
 * Better Stack adapter.
 *
 * Buffers entries and, on `flush()`, POSTs a Logtail-shaped JSON batch to the
 * ingest host with a `Bearer` source token. The `fetch` implementation is
 * injectable (default: the global `fetch`, resolved at flush time) so the
 * MSW-served contract test can intercept the ingest endpoint.
 *
 * `flush()` rejects on a non-2xx response so the composite can report the
 * failure once; it never throws into business code by itself.
 *
 * @param options - Source token, optional ingest host and fetch override.
 * @returns A buffering transport.
 */
export function betterStackTransport(options: BetterStackTransportOptions): LogTransport {
  const ingestHost = options.ingestHost ?? DEFAULT_INGEST_HOST;
  const buffer: LogEntry[] = [];

  return {
    write(entry: LogEntry): void {
      buffer.push(entry);
    },

    async flush(): Promise<void> {
      if (buffer.length === 0) {
        return;
      }

      const batch = buffer.splice(0).map(toBatchItem);
      const fetchImpl = options.fetch ?? globalThis.fetch;

      const response = await fetchImpl(ingestHost, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.sourceToken}`,
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        throw new Error(`Better Stack ingest failed with status ${String(response.status)}`);
      }
    },
  };
}
