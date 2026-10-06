import { getConfig } from "@/server/config/env";
import type { MessageTransport } from "@/server/notifications/message-transport";
import { selectNotificationTransport } from "@/server/notifications/notification-transport";

/**
 * Resolve the outbound notification transport from configuration (OP-94 §1
 * follow-up, ADR-0076, ADR-0095).
 *
 * The route and the opportunistic `after()` trigger depend on this service,
 * never on `@/server/adapters/**` directly (the route-handler import boundary
 * in `eslint.config.mjs`). It reads `MESSAGE_TRANSPORT` through `getConfig()`
 * and delegates provider selection to the adapter-free registry, so this seam
 * stays free of a vendor dependency.
 *
 * `MESSAGE_TRANSPORT=memory` is refused by `getConfig()` in production, so a
 * deployed app can never silently drop notifications into a process-local
 * outbox.
 *
 * @returns The configured {@link MessageTransport} port.
 */
export function getNotificationTransport(): MessageTransport {
  return selectNotificationTransport(getConfig().transport.provider);
}
