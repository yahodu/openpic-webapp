import { getLogger } from "../logging";
import { closeMongoClient } from "./mongo";

/**
 * Graceful-shutdown hook for the Mongo client (OP-75, §5).
 *
 * Disposability: when the process is asked to stop, the pooled client must be
 * closed so in-flight work can drain and the connections are released. The hook
 * is registered by the Next.js instrumentation entry (`src/instrumentation.ts`)
 * and only for self-hosted runtimes — a serverless function's process is
 * frozen, not signalled.
 */

/** Signals that begin a graceful shutdown on a self-hosted process. */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

let registered = false;

/**
 * Register the shutdown handlers once per process.
 *
 * @returns A disposer that removes the handlers (used by tests).
 */
export function registerMongoShutdownHook(): () => void {
  if (registered) {
    return () => undefined;
  }
  registered = true;

  const onSignal = (signal: NodeJS.Signals): void => {
    getLogger().info("shutting down mongo client", { event: "db.shutdown", signal });
    void closeMongoClient().catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      getLogger().error("failed to close mongo client", { event: "db.shutdown.error", errorName });
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, onSignal);
  }

  return () => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.removeListener(signal, onSignal);
    }
    registered = false;
  };
}
