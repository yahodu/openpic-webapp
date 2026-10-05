/**
 * The config-driven `MessageTransport` factory (OP-95, design §8.2, ADR-0094).
 *
 * `createAuth` needs a transport to hand rendered OTP messages to. The
 * vendor-neutral `MessageTransport` port is the only contract callers know
 * (`docs/CONVENTIONS.md` §7 / ADR-0001), so this module maps the validated
 * `MESSAGE_TRANSPORT` selector onto a concrete adapter:
 *
 *   - `memory` — the in-memory outbox (`memoryMessageTransport`), the documented
 *     default and the only provider legal in `test`/`e2e`/`development`;
 *   - any other provider — not wired to an adapter in this repository yet (the
 *     Novu adapter is import-restricted to its own module and its credentials
 *     are not part of the validated `AppConfig` surface), so the factory raises
 *     a loud configuration error rather than silently dropping every OTP. A
 *     deploy that selects a real provider must inject its transport through
 *     `createAuth({ transport })` until that wiring lands.
 *
 * Importing this module is side-effect free.
 */
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { getConfig } from "@/server/config/env";
import type { MessageTransport } from "@/server/notifications/message-transport";

/**
 * Build the transport named by the validated `MESSAGE_TRANSPORT` config.
 *
 * @returns A `MessageTransport` for the configured provider.
 * @throws When the configured provider has no wired adapter yet.
 */
export function getMessageTransport(): MessageTransport {
  const config = getConfig();

  if (config.transport.provider === "memory") {
    return memoryMessageTransport();
  }

  throw new Error(
    `MESSAGE_TRANSPORT provider "${config.transport.provider}" is not wired to a ` +
      `MessageTransport adapter; inject one via createAuth({ transport }).`
  );
}
