import type {
  CompositeTransport,
  CompositeTransportOptions,
  LogEntry,
  LogTransport,
} from "../types";

/**
 * Fan-out transport.
 *
 * Every member transport is isolated: a synchronous throw or an asynchronous
 * rejection from one transport never stops the others from receiving the
 * entry, and the composite never throws into business code. Each failure is
 * reported exactly once through the injected sink (default: a single
 * `[logging] ...` line on stderr).
 *
 * `write` invokes each transport synchronously (so in-memory test doubles see
 * the entry immediately) and returns a promise that settles once every
 * asynchronous write has settled.
 *
 * @param transports - The transports to fan out to, in order.
 * @param options - Optional failure sink.
 * @returns A transport that isolates its members.
 */
export function compositeTransport(
  transports: readonly LogTransport[],
  options: CompositeTransportOptions = {}
): CompositeTransport {
  const reportError = options.reportError ?? defaultReportError;

  return {
    write(entry: LogEntry): Promise<void> {
      const pending: Promise<void>[] = [];

      for (const transport of transports) {
        try {
          const result: void | Promise<void> = transport.write(entry);
          if (result instanceof Promise) {
            pending.push(
              result.then(
                () => undefined,
                (error: unknown) => {
                  reportError(error, transport);
                }
              )
            );
          }
        } catch (error: unknown) {
          reportError(error, transport);
        }
      }

      return Promise.all(pending).then(() => undefined);
    },

    async flush(): Promise<void> {
      await Promise.all(
        transports.map(async (transport) => {
          try {
            await transport.flush?.();
          } catch (error: unknown) {
            reportError(error, transport);
          }
        })
      );
    },
  };
}

/** Default failure sink: exactly one `[logging] ...` line per failure on stderr. */
function defaultReportError(error: unknown, _transport?: LogTransport): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[logging] transport failure: ${message}\n`);
}
