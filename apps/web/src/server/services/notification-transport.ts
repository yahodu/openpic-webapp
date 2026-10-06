import { getMessageTransport } from "@/server/adapters/message-transport-provider";
import type { MessageTransport } from "@/server/notifications/message-transport";

/**
 * Resolve the outbound notification transport from configuration (OP-94 §1
 * follow-up, ADR-0076, ADR-0105).
 *
 * The route and the opportunistic `after()` trigger depend on this service,
 * never on `@/server/adapters/**` directly (the route-handler import boundary
 * in `eslint.config.mjs`). It re-exposes the config-driven
 * {@link getMessageTransport} factory — the same transport the synchronous OTP
 * path uses — so the fan-out cron drains through the identical provider
 * selection (`memory` in development/test/e2e, Novu in staging/production).
 *
 * @returns The configured {@link MessageTransport} port.
 */
export function getNotificationTransport(): MessageTransport {
  return getMessageTransport();
}
