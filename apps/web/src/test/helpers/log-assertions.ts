import { expect } from "vitest";

import type { LogEntry, MemoryTransport } from "../../server/logging";

/**
 * Shared log-hygiene helpers.
 *
 * `expectNoSecretsInLogs` is the security control for OP-71's redaction list
 * (CONVENTIONS §5.3) and is meant to be reused by every later story that emits
 * logs (auth, payments, webhooks, media): capture with a `memoryTransport()`
 * and assert the captured entries carry nothing sensitive.
 */

/** Sensitive value shapes that must never survive redaction. */
const SENSITIVE_VALUE_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "Bearer token", pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/ },
  { name: "opat_ token", pattern: /opat_[A-Za-z0-9_-]{6,}/ },
  { name: "email address", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "E.164 phone number", pattern: /\+[1-9]\d{7,14}\b/ },
];

/**
 * Assert that no captured entry contains a secret-shaped value.
 *
 * The whole entry graph is serialized and scanned, so a leak anywhere —
 * message, nested object or array — fails the calling test and names the exact
 * offending value in the assertion message.
 *
 * @param transport - The memory transport whose captured entries are checked.
 */
export function expectNoSecretsInLogs(transport: MemoryTransport): void {
  const serialized = JSON.stringify(transport.entries);

  for (const { name, pattern } of SENSITIVE_VALUE_PATTERNS) {
    const match = pattern.exec(serialized);
    expect(match?.[0], `${name} leaked into logs`).toBeUndefined();
  }
}

/**
 * Build a valid `LogEntry` fixture for transport-level tests that must emit an
 * already-assembled entry without going through `createLogger`.
 *
 * @param overrides - Fields to override on the default entry.
 * @returns A complete log entry.
 */
export function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: "2026-01-02T03:04:05.000Z",
    level: "info",
    msg: "hello",
    event: "test.event",
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    requestId: "req-test-1",
    ...overrides,
  };
}
