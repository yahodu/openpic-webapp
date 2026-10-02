import pino from "pino";

import type { LogEntry, LogTransport, StdoutJsonTransportOptions } from "../types";

/**
 * The 12-factor default transport: one JSON line per entry on stdout, built on
 * `pino`.
 *
 * The sink is resolved at call time (see {@link defaultWrite}), so a test that
 * spies on `process.stdout.write` after construction still captures output.
 * `pino` is configured to emit the canonical {@link LogEntry} shape — a string
 * `level` label and the `msg` key — so the stream stays a line-delimited event
 * feed an aggregator can parse directly.
 *
 * @param options - Optional sink override (defaults to `process.stdout.write`).
 * @returns A transport that serializes each entry to a single JSON line.
 */
export function stdoutJsonTransport(options: StdoutJsonTransportOptions = {}): LogTransport {
  const writeLine = options.write ?? defaultWrite;

  const pinoLogger = pino(
    {
      base: null,
      timestamp: false,
      messageKey: "msg",
      formatters: { level: (label) => ({ level: label }) },
    },
    {
      write(chunk: string): void {
        writeLine(chunk);
      },
    }
  );

  return {
    write(entry: LogEntry): void {
      const { msg, level, ...fields } = entry;
      pinoLogger[level](fields, msg);
    },
  };
}

/** Write one line to stdout, resolved at call time so test spies are honoured. */
function defaultWrite(line: string): void {
  process.stdout.write(line);
}
