import type { LogEntry, MemoryTransport } from "../types";

/**
 * In-memory transport for tests.
 *
 * Records every entry it receives, in order, so tests can assert on exactly
 * what the port produced. `clear()` resets the buffer so state does not leak
 * between tests.
 *
 * @returns A transport whose `entries` reflect everything written to it.
 */
export function memoryTransport(): MemoryTransport {
  const entries: LogEntry[] = [];

  return {
    entries,
    write(entry: LogEntry): void {
      entries.push(entry);
    },
    clear(): void {
      entries.length = 0;
    },
  };
}
