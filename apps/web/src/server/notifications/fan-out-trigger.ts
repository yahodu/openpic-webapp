import { getLogger } from "@/server/logging";

/**
 * The opportunistic fan-out drain (OP-94 §1 follow-up, ADR-0095).
 *
 * `emitDomainEvent` schedules this once per notifications-pending emit via
 * Next.js's `after()`, so a fresh event is delivered without waiting for the
 * next minute tick of the cron route. It deliberately lives outside
 * `@/server/domain/domain-events` so that writer gains no notification
 * dependency, and it resolves the fan-out with a dynamic `import` because
 * `fan-out` imports `domain-events` (a static import would cycle).
 *
 * The drain is a latency optimisation, never a correctness path: every failure
 * is swallowed and logged so it can never surface as an unhandled rejection
 * after the response. The cron route remains the durability guarantee.
 */
export async function runNotificationFanOutTrigger(): Promise<void> {
  try {
    const [{ runNotificationFanOut }, { getNotificationTransport }, { notificationRecipients }] =
      await Promise.all([
        import("@/server/notifications/fan-out"),
        import("@/server/services/notification-transport"),
        import("@/server/repos/notification-recipients"),
      ]);

    await runNotificationFanOut({
      transport: getNotificationTransport(),
      recipients: notificationRecipients,
    });
  } catch (error) {
    getLogger().error("opportunistic notification fan-out failed", {
      event: "notification.fan_out_trigger_failed",
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}
