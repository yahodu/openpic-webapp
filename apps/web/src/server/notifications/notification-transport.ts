import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { novuTransport } from "@/server/adapters/novu/novu-transport";
import { getNovuRuntimeConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import type { MessageTransport } from "@/server/notifications/message-transport";

/**
 * Select the outbound notification transport for a configured provider
 * (OP-94 §1 follow-up, ADR-0076, ADR-0095).
 *
 * This is the one place that may name the vendor adapter, so the service the
 * route depends on (`@/server/services/notification-transport`) can stay a
 * thin, adapter-free facade and the route never imports
 * `@/server/adapters/**` (the `eslint.config.mjs` import boundary).
 *
 *   - `memory` (development/test/e2e) → the in-process
 *     {@link memoryMessageTransport} outbox; nothing leaves the process.
 *   - anything else (staging/production sets a non-memory provider, enforced by
 *     `getConfig()`) → the Novu adapter, built from `getNovuRuntimeConfig()`.
 *
 * @param provider - The `MESSAGE_TRANSPORT` value.
 * @returns The selected {@link MessageTransport} port.
 */
export function selectNotificationTransport(provider: string): MessageTransport {
  if (provider === "memory") {
    return memoryMessageTransport();
  }

  const novu = getNovuRuntimeConfig();
  return novuTransport({
    baseUrl: novu.baseUrl,
    apiKey: novu.apiKey,
    logger: getLogger(),
  });
}
