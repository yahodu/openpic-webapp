import { PLATFORM_SETTINGS_DEFAULTS } from "@/server/settings/platform-settings";

/**
 * Domain-event fixtures (OP-88, schema §18.3, contract §7.7).
 *
 * `makeDomainEventInput` is deliberately a **plain, un-parsed builder**: U1/U2
 * must be able to hand `emitDomainEvent` an *invalid* input (an unknown
 * `eventKey`, a contact-bearing payload) to prove the boundary rejects it, and
 * a factory that parsed its own output could not produce one (mirrors
 * `makeNotificationType`).
 */

/** The structural shape of the argument `emitDomainEvent` accepts. */
export interface DomainEventInputFixture {
  /** The catalogue `typeKey` or a registered analytics-only event key. */
  readonly eventKey: string;
  /** The tenant the event belongs to. */
  readonly tenantId: string;
  /** Who caused the event. */
  readonly actorRef: { readonly kind: string; readonly id: string };
  /** What the event is about. */
  readonly subjectRef: { readonly kind: string; readonly id: string };
  /** Minimal, resolvable identifiers — never contact details, tokens or vectors. */
  readonly payload: Record<string, unknown>;
  /** Optional replay guard; a duplicate is silently dropped. */
  readonly dedupeKey?: string;
}

/**
 * Build a valid `emitDomainEvent` input.
 *
 * @param overrides - Fields to replace on the baseline (including `payload`).
 * @returns A domain-event input fixture.
 */
export function makeDomainEventInput(
  overrides: Partial<DomainEventInputFixture> = {}
): DomainEventInputFixture {
  return {
    eventKey: "collab.invite.accepted",
    tenantId: "t_1",
    actorRef: { kind: "user", id: "user_1" },
    subjectRef: { kind: "invitation", id: "inv_1" },
    payload: { inviteId: "inv_1", eventId: "ev_1", role: "co_organizer" },
    ...overrides,
  };
}

/**
 * Build a complete, schema-valid `platformSettings` document for a fake or real
 * database.
 *
 * The domain-event writer reads `retention.domainEventDays` from the singleton,
 * so a unit spec can seed a shortened window and observe the computed
 * `expireAt` without a replica set.
 *
 * @param overrides - Top-level fields to replace (e.g. a whole `retention`
 *   block). A shallow merge, so a nested override must be supplied complete.
 * @returns A `platformSettings` document fixture.
 */
export function makePlatformSettingsDocument(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    _id: "singleton",
    ...PLATFORM_SETTINGS_DEFAULTS,
    ...overrides,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedByUserId: null,
  };
}
