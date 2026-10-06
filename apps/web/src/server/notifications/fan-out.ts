/**
 * Notification fan-out consumer — outbox → in-app feed + dispatch ledger
 * (OP-94, design §2/§5/§6/§7, schema §19.4–§19.5, ADR-0090, ADR-0092).
 *
 * The `notifications` consumer of the transactional outbox (OP-88): it claims
 * pending `domainEvents` rows, resolves recipients **at send time** (audience is
 * never stored), runs the pure {@link resolveChannel} per (recipient × enabled
 * group), writes the pre-rendered in-app feed row and the
 * `notificationDispatches` ledger — including every skip — and hands rendered
 * messages to an injected {@link MessageTransport}.
 *
 * Three properties are load-bearing:
 *
 *   1. **Dedupe by the unique index only.** The stored `dedupeKey` is the
 *      type's interpolated `dedupe.keyTemplate` suffixed with the resolved
 *      channel (the schema's unique index is per-tenant, so a shared key would
 *      make the `email` and `sms` legs of one event collide); a duplicate insert
 *      (E11000) becomes a `skipped`/`deduped` row and is never sent.
 *   2. **A read aggregated row is never resurrected.** A grouping type's feed
 *      row is upserted with `readAt: null` in the filter, so the next arrival
 *      after the user reads starts a fresh counter instead of reviving it.
 *   3. **Per-recipient isolation.** One provider failure leaves the event
 *      claimable (`markFailed`) while its peers are still delivered.
 *
 * Deliberately out of scope here (ADR-0090 "Out of scope"): the cron route and
 * the `after()` opportunistic trigger. The synchronous transactional entry
 * point {@link sendTransactionalNow} is *not* out of scope — OP-94 card §6 was
 * routed to OP-95, so it lives here alongside the async run (ADR-0096).
 */

import { createHash } from "node:crypto";

import type { Db, ObjectId as ObjectIdValue } from "mongodb";
import { ObjectId } from "mongodb";

import { TransportError } from "@/server/adapters/transport-error";
import { getAppEnv } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import {
  claimPendingEvents,
  markDone,
  markFailed,
  type DomainEventDocument,
} from "@/server/domain/domain-events";
import { getLogger } from "@/server/logging";
import type {
  MessageTransport,
  OutboundChannel,
  OutboundMessage,
} from "@/server/notifications/message-transport";
import {
  notificationTypeSchema,
  type ChannelGroup,
  type NotificationType,
} from "@/server/notifications/notification-types";
import {
  notificationTemplateSchema,
  type NotificationTemplate,
} from "@/server/notifications/notification-templates";
import { renderTemplate, type RenderVars } from "@/server/notifications/render-template";
import {
  DEFAULT_MOBILE_CANDIDATES,
  resolveChannel,
  type ChannelDecision,
  type ChannelGroupName,
  type GroupPreference,
  type ResolveContacts,
  type ResolveGroupPreferences,
  type ResolvePreferences,
  type ResolveProfile,
  type ResolvedChannel,
  type SkipReason,
} from "@/server/notifications/resolve-channel";
import { SEED_NOTIFICATION_TEMPLATES } from "@/server/notifications/notification-templates.values";
import { SEED_NOTIFICATION_TYPES } from "@/server/notifications/notification-types.values";
import { platformRepo } from "@/server/repos";
import { systemClock, type Clock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/** The Better Auth user collection (schema §13.1) — a literal, not `COLLECTIONS.users`. */
const BETTER_AUTH_USER = "user";

/** The MongoDB duplicate-key server error code. */
const DUPLICATE_KEY = 11000;

/** The active locale fallback (mirrors the renderer's `FALLBACK_LOCALE`). */
const FALLBACK_LOCALE = "en-IN";

/** The default per-user preferences when no `notificationPreferences` row exists. */
const DEFAULT_PREFS: ResolvePreferences = {
  global: { in_app: "on", email: "on", mobile: "on" },
  byType: {},
  byEvent: {},
  quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
  locale: FALLBACK_LOCALE,
};

/** The recipient roles the fan-out reads from the event membership layer. */
export type RecipientRole = "organizer" | "co_organizer";

/**
 * The injected recipient source (design §2).
 *
 * The membership data layer is not built out yet, so the fan-out reads
 * recipients through this port: production wires the real `eventMembers` /
 * `invitations` / `attendeeEventProfiles` reads, while a spec can inject a
 * deterministic source and exercise the Mongo + transport wiring without it.
 */
export interface RecipientRepository {
  listEventRoleMembers(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly roles: readonly RecipientRole[];
  }): Promise<readonly string[]>;
  listIdentifiedAttendeeUserIds(input: {
    readonly tenantId: string;
    readonly eventId: string;
  }): Promise<readonly string[]>;
  getBillingContactUserId(input: { readonly tenantId: string }): Promise<string | null>;
  listPlatformAdminUserIds(): Promise<readonly string[]>;
}

/** The input to {@link resolveRecipients} (ADR-0090). */
export interface ResolveRecipientsInput {
  readonly typeRow: NotificationType;
  readonly tenantId: string;
  readonly eventId: string | null;
  readonly actorUserId: string | null;
  readonly subjectUserId: string | null;
  readonly repository: RecipientRepository;
}

/** Seams for {@link runNotificationFanOut} (ADR-0090). */
export interface FanOutRunOptions {
  /** The database handle; defaults to the shared client. */
  readonly db?: Db;
  /** The clock; defaults to the system clock. */
  readonly clock?: Clock;
  /** The outbound transport the rendered messages are handed to. */
  readonly transport: MessageTransport;
  /** The recipient source. */
  readonly recipients: RecipientRepository;
  /** Maximum events claimed per run; defaults to 50. */
  readonly batch?: number;
  /** An identifier recorded on each claim. */
  readonly claimerId?: string;
}

/** The result of one fan-out run. */
export interface FanOutSummary {
  /** Events claimed this run. */
  readonly claimed: number;
  /** Events fully processed and marked `done`. */
  readonly processed: number;
  /** Events left `pending` because a retryable failure occurred. */
  readonly failed: number;
}

/** The stored in-app feed row (schema §19.4). */
interface FeedRow {
  readonly userId: ObjectIdValue;
  readonly tenantId: string;
  readonly eventId: ObjectIdValue | null;
  readonly typeKey: string;
  readonly severity: string;
  readonly titleKey: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, unknown>;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly actionTarget: {
    readonly kind: string;
    readonly id: string;
    readonly state: string;
  } | null;
  readonly actions: readonly FeedAction[];
  readonly readAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expireAt: Date;
}

/** One renderable in-app action (schema §19.4). */
interface FeedAction {
  readonly key: string;
  readonly label: string;
  readonly style: string;
  readonly state: "available" | "unavailable";
}

/** Per-recipient facts the coordinator loads once. */
interface RecipientContext {
  readonly userId: string;
  readonly prefs: ResolvePreferences;
  readonly profile: ResolveProfile;
  readonly contacts: ResolveContacts;
}

/** Shared immutable facts for one claimed event. */
interface EventContext {
  readonly event: DomainEventDocument;
  readonly typeRow: NotificationType;
  readonly templates: ReadonlyMap<string, readonly NotificationTemplate[]>;
  readonly eventId: string | null;
  readonly tenantId: string;
  readonly now: Date;
  readonly notificationExpireAt: Date;
  readonly dispatchExpireAt: Date;
}

/** True for a plain (non-array) object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === DUPLICATE_KEY
  );
}

/** Coerce a stored `userId` into the driver's `_id` value. */
function toObjectId(value: string): ObjectIdValue {
  return new ObjectId(value);
}

/** A 24-hex id as an `ObjectId`, or `null` when it is not a valid ObjectId. */
function asObjectId(value: unknown): ObjectIdValue | null {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) return null;
  return new ObjectId(value);
}

/** A SHA-256 hex digest of a destination (the dispatch `contactHash`). */
function contactHashOf(destination: string): string {
  return createHash("sha256").update(destination).digest("hex");
}

/** Narrow an unknown value to a stored group-preference scope. */
function asGroupPreferences(value: unknown): ResolveGroupPreferences {
  if (!isRecord(value)) return {};
  const result: Partial<Record<"in_app" | "email" | "mobile", GroupPreference>> = {};
  for (const group of ["in_app", "email", "mobile"] as const) {
    const candidate = value[group];
    if (candidate === "on" || candidate === "off") result[group] = candidate;
  }
  return result;
}

/** Narrow an unknown value to a `scope → group` preference map. */
function asScopeMap(value: unknown): Readonly<Record<string, ResolveGroupPreferences>> {
  if (!isRecord(value)) return {};
  const result: Record<string, ResolveGroupPreferences> = {};
  for (const [key, scope] of Object.entries(value)) {
    result[key] = asGroupPreferences(scope);
  }
  return result;
}

/** Narrow an unknown value to the quiet-hours window. */
function asQuietHours(value: unknown): ResolvePreferences["quietHours"] {
  if (!isRecord(value)) return DEFAULT_PREFS.quietHours;
  const { enabled, start, end, timeZone } = value;
  return {
    enabled: enabled === true,
    start: typeof start === "string" ? start : DEFAULT_PREFS.quietHours.start,
    end: typeof end === "string" ? end : DEFAULT_PREFS.quietHours.end,
    timeZone: typeof timeZone === "string" ? timeZone : DEFAULT_PREFS.quietHours.timeZone,
  };
}

/** Map a stored `notificationPreferences` row onto the resolver's input. */
function toPreferences(doc: Record<string, unknown> | null): ResolvePreferences {
  if (doc === null) return DEFAULT_PREFS;
  return {
    global: asGroupPreferences(doc.global),
    byType: asScopeMap(doc.byType),
    byEvent: asScopeMap(doc.byEvent),
    quietHours: asQuietHours(doc.quietHours),
    locale: typeof doc.locale === "string" ? doc.locale : FALLBACK_LOCALE,
  };
}

/**
 * Resolve the user ids an event should reach (design §2, ADR-0090).
 *
 * Audiences are derived at send time: `organizer`/`co_organizer` share one
 * `listEventRoleMembers` call, `attendee_identified` reads identified attendees,
 * `billing_contact` reads the tenant billing contact and `platform_admin` the
 * platform admins. `attendee_anonymous` is deliberately unreachable. A
 * `subjectUserId` is always included, the `actorUserId` is always removed, and
 * the result is deduped preserving first-seen order.
 *
 * @param input - The type row, scope, actor/subject ids and the recipient port.
 * @returns The recipient user ids, in first-seen order.
 */
export async function resolveRecipients(input: ResolveRecipientsInput): Promise<readonly string[]> {
  const { typeRow, tenantId, eventId, actorUserId, subjectUserId, repository } = input;

  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null): void => {
    if (id === null || id.length === 0 || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };

  let roleMembersLoaded = false;

  for (const audience of typeRow.audiences) {
    switch (audience) {
      case "organizer":
      case "co_organizer": {
        if (eventId === null || roleMembersLoaded) break;
        roleMembersLoaded = true;
        const roles: RecipientRole[] = [];
        if (typeRow.audiences.includes("organizer")) roles.push("organizer");
        if (typeRow.audiences.includes("co_organizer")) roles.push("co_organizer");
        for (const id of await repository.listEventRoleMembers({ tenantId, eventId, roles })) {
          add(id);
        }
        break;
      }
      case "attendee_identified": {
        if (eventId === null) break;
        for (const id of await repository.listIdentifiedAttendeeUserIds({ tenantId, eventId })) {
          add(id);
        }
        break;
      }
      case "billing_contact": {
        add(await repository.getBillingContactUserId({ tenantId }));
        break;
      }
      case "platform_admin": {
        for (const id of await repository.listPlatformAdminUserIds()) {
          add(id);
        }
        break;
      }
      default:
        // `attendee_anonymous` is deliberately unreachable (design §2).
        break;
    }
  }

  add(subjectUserId);

  if (actorUserId !== null) {
    seen.delete(actorUserId);
    const index = ordered.indexOf(actorUserId);
    if (index >= 0) ordered.splice(index, 1);
  }

  return ordered;
}

/**
 * Expand a type's `dedupe.keyTemplate` into the concrete key the dispatch
 * ledger's unique index enforces (U3, design §6).
 *
 * @param template - The `{name}` template, or `null` for "no dedupe".
 * @param vars - The values to interpolate (the event payload plus `typeKey`).
 * @returns The interpolated key, or `null` when the template is `null`.
 * @throws When the template references a variable that was not supplied.
 */
export function interpolateDedupeKey(
  template: string | null,
  vars: Readonly<Record<string, string | number>>
): string | null {
  if (template === null) return null;

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`dedupe key template references unsupplied variable "${name}"`);
    }
    return String(value);
  });
}

/** Build the `{name}` substitution source for a type's dedupe template. */
function dedupeVars(
  typeKey: string,
  payload: Record<string, unknown>
): Record<string, string | number> {
  const vars: Record<string, string | number> = { typeKey };
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number") vars[key] = value;
  }
  return vars;
}

/**
 * The declared variables of a template, taken from the payload superset.
 *
 * A declared variable the event payload does not carry is rendered as an empty
 * string. The event payload is a projection of the domain event, and a shared
 * type's copy may legitimately declare a value only one dispatch path can
 * supply — e.g. `auth.otp.*` copy declares `code`, which the synchronous path
 * renders (`sendTransactionalNow`) while an async fan-out event carries no code.
 * The renderer itself stays strict (`renderTemplate` still throws on a missing
 * value); the fan-out, which owns the payload projection, supplies the empty
 * default so one template can serve both paths.
 */
function renderVarsFor(
  template: NotificationTemplate | undefined,
  typeKey: string,
  payload: Record<string, unknown>
): RenderVars {
  const vars: Record<string, string | number> = {};
  if (template === undefined) return vars;

  const source: Record<string, string | number> = { typeKey };
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" || typeof value === "number") source[key] = value;
  }
  for (const declared of template.variables) {
    vars[declared] = source[declared] ?? "";
  }
  return vars;
}

/** Select the template a render will use: exact locale, else `en-IN`. */
function selectTemplate(
  templates: readonly NotificationTemplate[],
  locale: string
): NotificationTemplate | undefined {
  return (
    templates.find((candidate) => candidate.locale === locale) ??
    templates.find((candidate) => candidate.locale === FALLBACK_LOCALE)
  );
}

/** Build the in-app action target + actions for an actionable type (schema §19.4). */
function buildActions(
  typeRow: NotificationType,
  subjectRef: { readonly kind: string; readonly id: string }
): { readonly actionTarget: FeedRow["actionTarget"]; readonly actions: readonly FeedAction[] } {
  if (!typeRow.actionable) return { actionTarget: null, actions: [] };

  const actionTarget = { kind: subjectRef.kind, id: subjectRef.id, state: "open" };

  // An invitation is the only actionable target in v1 (design §7): accepting or
  // rejecting delegates to the `invitations` document, which owns the outcome.
  const actions: readonly FeedAction[] =
    actionTarget.kind === "invitation"
      ? [
          { key: "accept", label: "Accept", style: "primary", state: "available" },
          { key: "reject", label: "Reject", style: "danger", state: "available" },
        ]
      : [];

  return { actionTarget, actions };
}

/** True when the type's in-app feed row aggregates instead of inserting fresh. */
function isAggregating(typeRow: NotificationType): boolean {
  return typeRow.throttle.strategy === "digest" || typeRow.throttle.strategy === "coalesce";
}

/** The increment a grouping row carries: the event's `count`, else one. */
function groupIncrement(payload: Record<string, unknown>): number {
  const count = payload.count;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 1;
}

/** Load and validate the `notificationTypes` row for an event key. */
async function loadTypeRow(db: Db, typeKey: string): Promise<NotificationType | null> {
  const raw = await platformRepo(db).collection(COLLECTIONS.notificationTypes).findOne({ typeKey });
  if (raw === null) return null;

  const parsed = notificationTypeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Load the active templates for a type, grouped by routing channel. */
async function loadTemplates(
  db: Db,
  typeKey: string
): Promise<Map<string, readonly NotificationTemplate[]>> {
  const rows = await platformRepo(db)
    .collection(COLLECTIONS.notificationTemplates)
    .find({ typeKey, active: true })
    .toArray();

  const byChannel = new Map<string, NotificationTemplate[]>();
  for (const raw of rows) {
    const parsed = notificationTemplateSchema.safeParse(raw);
    if (!parsed.success) continue;
    const list = byChannel.get(parsed.data.channel);
    if (list === undefined) {
      byChannel.set(parsed.data.channel, [parsed.data]);
    } else {
      list.push(parsed.data);
    }
  }
  return byChannel;
}

/** Load the contact, profile and preference facts for one recipient. */
async function loadRecipientContext(db: Db, userId: string): Promise<RecipientContext> {
  const objectId = toObjectId(userId);

  // The three reads are independent; issue them together.
  const [user, profileDoc, prefsDoc] = await Promise.all([
    platformRepo(db).collection(BETTER_AUTH_USER).findOne({ _id: objectId }),
    platformRepo(db).collection(COLLECTIONS.userProfiles).findOne({ userId: objectId }),
    platformRepo(db).collection(COLLECTIONS.notificationPreferences).findOne({ userId: objectId }),
  ]);

  const userRecord = isRecord(user) ? user : {};
  const contacts: ResolveContacts = {
    email: typeof userRecord.email === "string" ? userRecord.email : null,
    emailVerified: userRecord.emailVerified === true,
    phoneNumber: typeof userRecord.phoneNumber === "string" ? userRecord.phoneNumber : null,
    phoneNumberVerified: userRecord.phoneNumberVerified === true,
  };

  const capabilities =
    isRecord(profileDoc) && isRecord(profileDoc.contactCapabilities)
      ? profileDoc.contactCapabilities
      : {};
  const whatsappCapable = capabilities.whatsappCapable;
  const profile: ResolveProfile = {
    userId,
    contactCapabilities: {
      whatsappCapable: whatsappCapable === true ? true : whatsappCapable === false ? false : null,
      whatsappCheckedAt:
        capabilities.whatsappCheckedAt instanceof Date ? capabilities.whatsappCheckedAt : null,
    },
  };

  return {
    userId,
    contacts,
    profile,
    prefs: toPreferences(isRecord(prefsDoc) ? prefsDoc : null),
  };
}

/** Persist a pre-rendered in-app feed row, aggregating when the type groups. */
async function writeFeedRow(
  db: Db,
  ctx: EventContext,
  userId: string,
  title: string,
  body: string
): Promise<void> {
  const { typeRow } = ctx;
  const { actionTarget, actions } = buildActions(typeRow, ctx.event.subjectRef);
  const data: Record<string, unknown> = { ...ctx.event.payload };

  const base = {
    userId: toObjectId(userId),
    tenantId: ctx.tenantId,
    eventId: asObjectId(ctx.eventId),
    typeKey: typeRow.typeKey,
    severity: typeRow.severity,
    titleKey: typeRow.typeKey,
    title,
    body,
    data,
    actionTarget,
    actions,
    readAt: null,
    expireAt: ctx.notificationExpireAt,
  };

  if (isAggregating(typeRow)) {
    const groupKey =
      typeof ctx.event.payload.eventId === "string" ? ctx.event.payload.eventId : null;
    await platformRepo(db)
      .collection(COLLECTIONS.notifications)
      .findOneAndUpdate(
        { userId: toObjectId(userId), typeKey: typeRow.typeKey, groupKey, readAt: null },
        {
          $inc: { groupCount: groupIncrement(ctx.event.payload) },
          $set: { title, body, data, updatedAt: ctx.now },
          $setOnInsert: {
            tenantId: ctx.tenantId,
            eventId: base.eventId,
            typeKey: typeRow.typeKey,
            severity: typeRow.severity,
            titleKey: typeRow.typeKey,
            actionTarget,
            actions,
            readAt: null,
            groupKey,
            expireAt: ctx.notificationExpireAt,
            createdAt: ctx.now,
          },
        },
        { upsert: true }
      );
    return;
  }

  const row: FeedRow = {
    ...base,
    groupKey: null,
    groupCount: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await platformRepo(db).collection(COLLECTIONS.notifications).insertOne(row);
}

/** The dispatch-ledger row (schema §19.5). */
interface DispatchRow {
  readonly userId: ObjectIdValue;
  readonly tenantId: string;
  readonly eventId: ObjectIdValue | null;
  readonly typeKey: string;
  readonly channelGroup: string;
  readonly channel: ResolvedChannel;
  readonly status: "queued" | "sent" | "failed" | "skipped";
  readonly skipReason: SkipReason | null;
  readonly contactHash: string | null;
  readonly templateVersion: number | null;
  readonly dedupeKey: string | null;
  readonly providerRef: {
    readonly provider: string;
    readonly env: string;
    readonly messageId: string;
  } | null;
  readonly attempts: number;
  readonly lastError: {
    readonly retryable: boolean;
    readonly code: string;
    readonly status?: number;
  } | null;
  readonly queuedAt: Date;
  readonly sentAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly failedAt: Date | null;
  readonly notificationId: ObjectIdValue | null;
  readonly expireAt: Date;
}

/** The base dispatch row every attempt starts from. */
function dispatchBase(
  ctx: EventContext,
  userId: string,
  group: ChannelGroup,
  channel: ResolvedChannel,
  extras: Partial<DispatchRow>
): DispatchRow {
  return {
    userId: toObjectId(userId),
    tenantId: ctx.tenantId,
    eventId: asObjectId(ctx.eventId),
    typeKey: ctx.typeRow.typeKey,
    channelGroup: group.group,
    channel,
    status: "queued",
    skipReason: null,
    contactHash: null,
    templateVersion: null,
    dedupeKey: null,
    providerRef: null,
    attempts: 0,
    lastError: null,
    queuedAt: ctx.now,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    notificationId: null,
    expireAt: ctx.dispatchExpireAt,
    ...extras,
  };
}

/** The channel a group would target, used for a skip recorded before candidate selection. */
function groupChannel(group: ChannelGroup): ResolvedChannel {
  if (group.group !== "mobile") return group.group;
  // Mirror the resolver's default candidate order so a recorded skip names the
  // same first candidate `resolveChannel` would have tried.
  return group.candidates?.[0] ?? DEFAULT_MOBILE_CANDIDATES[0];
}

/** Persist a skip row and log `notification.skipped`. */
async function writeSkip(
  db: Db,
  ctx: EventContext,
  userId: string,
  group: ChannelGroup,
  channel: ResolvedChannel,
  reason: SkipReason,
  extra: Partial<DispatchRow> = {}
): Promise<void> {
  const row = dispatchBase(ctx, userId, group, channel, {
    status: "skipped",
    skipReason: reason,
    ...extra,
  });
  await platformRepo(db).collection(COLLECTIONS.dispatches).insertOne(row);

  getLogger().info("notification.skipped", {
    event: "notification.skipped",
    typeKey: ctx.typeRow.typeKey,
    channel,
    reason,
    contactHashPrefix: row.contactHash?.slice(0, 8) ?? null,
  });
}

/** Persist the queued row for an outbound digest, deferring the actual send. */
async function writeDigestQueued(
  db: Db,
  ctx: EventContext,
  userId: string,
  group: ChannelGroup,
  channel: ResolvedChannel
): Promise<void> {
  const row = dispatchBase(ctx, userId, group, channel, { status: "queued" });
  await platformRepo(db).collection(COLLECTIONS.dispatches).insertOne(row);

  getLogger().info("notification.digested", {
    event: "notification.digested",
    typeKey: ctx.typeRow.typeKey,
    channel,
  });
}

/** Classify an error thrown while rendering or sending into a dispatch lastError. */
function classifyError(error: unknown): { retryable: boolean; code: string; status?: number } {
  if (error instanceof TransportError) {
    return {
      retryable: error.retryable,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { retryable: false, code: "render_error" };
}

/** The composed stored `dedupeKey`: interpolated key + resolved channel suffix. */
function composeDedupeKey(
  typeRow: NotificationType,
  eventKey: string,
  payload: Record<string, unknown>,
  channel: ResolvedChannel
): string | null {
  const interpolated = interpolateDedupeKey(
    typeRow.dedupe.keyTemplate,
    dedupeVars(eventKey, payload)
  );
  return interpolated === null ? null : `${interpolated}:${channel}`;
}

/** Build the outbound message for a resolved channel. */
function buildOutboundMessage(
  channel: OutboundChannel,
  userId: string,
  destination: string,
  subject: string,
  body: string
): OutboundMessage {
  if (channel === "email") {
    return {
      channel: "email",
      to: { userId, email: destination },
      subject,
      html: body,
      text: body,
    };
  }
  return {
    channel,
    to: { userId, phoneE164: destination },
    subject,
    text: body,
  };
}

/** The environment label stored on a provider ref. */
function transportEnv(): string {
  return getAppEnv();
}

/** Deliver one outbound group for one recipient (design §5/§6, ADR-0090). */
async function dispatchOutbound(
  options: FanOutRunOptions,
  ctx: EventContext,
  context: RecipientContext,
  group: ChannelGroup,
  decision: ChannelDecision
): Promise<{ readonly retryableFailure: boolean }> {
  const db = options.db ?? getDb();
  const { userId, contacts, prefs } = context;

  // Every decision is persisted. A skip before candidate selection (opt-out,
  // no verified contact, suppression) still records the group's target channel.
  if (decision.kind === "skip") {
    await writeSkip(db, ctx, userId, group, groupChannel(group), decision.reason);
    return { retryableFailure: false };
  }
  if (decision.kind === "defer") {
    await writeSkip(db, ctx, userId, group, groupChannel(group), decision.reason);
    return { retryableFailure: false };
  }
  if (decision.kind === "digest") {
    // Outbound digest accumulation: a queued row is recorded, the bucket flush is
    // the (out-of-scope) digest cron. The in-app feed row is written elsewhere.
    await writeDigestQueued(db, ctx, userId, group, groupChannel(group));
    return { retryableFailure: false };
  }

  const channel = decision.channel;
  if (channel === "in_app") {
    // A `send` decision on an outbound group never resolves to `in_app`
    // (`in_app` groups are handled before this point).
    return { retryableFailure: false };
  }
  const destination = channel === "email" ? contacts.email : contacts.phoneNumber;
  const hash = destination === null ? null : contactHashOf(destination);
  const dedupeKey = composeDedupeKey(ctx.typeRow, ctx.event.eventKey, ctx.event.payload, channel);

  const templates = ctx.templates.get(group.group) ?? [];
  const template = selectTemplate(templates, prefs.locale);

  const queued = dispatchBase(ctx, userId, group, channel, {
    status: "queued",
    contactHash: hash,
    templateVersion: template?.version ?? null,
    dedupeKey,
  });

  let insertedId: ObjectIdValue;
  try {
    const result = await platformRepo(db).collection(COLLECTIONS.dispatches).insertOne(queued);
    insertedId = result.insertedId;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // Dedupe is enforced by the unique index; the losing attempt is recorded.
    await writeSkip(db, ctx, userId, group, channel, "deduped", {
      contactHash: hash,
      templateVersion: template?.version ?? null,
    });
    return { retryableFailure: false };
  }

  let rendered: { readonly subject: string; readonly body: string };
  try {
    if (template === undefined) {
      throw new Error(`no active template for ${ctx.typeRow.typeKey}/${group.group}`);
    }
    rendered = renderTemplate(
      [template],
      renderVarsFor(template, ctx.event.eventKey, ctx.event.payload),
      prefs.locale
    );
  } catch (error) {
    const failure = classifyError(error);
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: insertedId },
        { $set: { status: "failed", attempts: 1, failedAt: ctx.now, lastError: failure } }
      );
    getLogger().error("notification.dispatch_failed", {
      event: "notification.dispatch_failed",
      typeKey: ctx.typeRow.typeKey,
      channel,
      code: failure.code,
      contactHashPrefix: hash?.slice(0, 8) ?? null,
    });
    return { retryableFailure: failure.retryable };
  }

  if (destination === null) {
    // Defensive: the resolver only sends when a destination exists; a null here
    // is a contract violation, recorded rather than sent.
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: insertedId },
        {
          $set: {
            status: "failed",
            attempts: 1,
            failedAt: ctx.now,
            lastError: { retryable: false, code: "no_destination" },
          },
        }
      );
    return { retryableFailure: false };
  }

  const message = buildOutboundMessage(
    channel,
    userId,
    destination,
    rendered.subject,
    rendered.body
  );

  try {
    const receipt = await options.transport.send(message);
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: insertedId },
        {
          $set: {
            status: "sent",
            attempts: 1,
            sentAt: ctx.now,
            providerRef: {
              provider: "transport",
              env: transportEnv(),
              messageId: receipt.providerMessageId,
            },
          },
        }
      );
    getLogger().info("notification.dispatched", {
      event: "notification.dispatched",
      typeKey: ctx.typeRow.typeKey,
      channel,
      contactHashPrefix: hash?.slice(0, 8) ?? null,
    });
    return { retryableFailure: false };
  } catch (error) {
    const failure = classifyError(error);
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: insertedId },
        { $set: { status: "failed", attempts: 1, failedAt: ctx.now, lastError: failure } }
      );
    getLogger().error("notification.dispatch_failed", {
      event: "notification.dispatch_failed",
      typeKey: ctx.typeRow.typeKey,
      channel,
      code: failure.code,
      retryable: failure.retryable,
      contactHashPrefix: hash?.slice(0, 8) ?? null,
    });
    return { retryableFailure: failure.retryable };
  }
}

/** Run the fan-out for one recipient, isolating its failures from its peers. */
async function fanOutToRecipient(
  options: FanOutRunOptions,
  ctx: EventContext,
  userId: string
): Promise<{ readonly retryableFailure: boolean }> {
  const db = options.db ?? getDb();
  const context = await loadRecipientContext(db, userId);
  let retryableFailure = false;

  for (const group of ctx.typeRow.channelGroups) {
    if (!group.enabled) continue;

    const decision = resolveChannel({
      typeRow: ctx.typeRow,
      group,
      prefs: context.prefs,
      profile: context.profile,
      contacts: context.contacts,
      suppressions: [],
      now: ctx.now,
      eventId: ctx.eventId,
      throttleState: {},
    });

    if (group.group === "in_app") {
      // In-app aggregation is separate from digesting (design §6): a `digest`
      // decision still upserts the feed row; `in_app` never writes a dispatch.
      if (decision.kind === "send" || decision.kind === "digest") {
        const templates = ctx.templates.get("in_app") ?? [];
        const template = selectTemplate(templates, context.prefs.locale);
        if (template !== undefined) {
          const rendered = renderTemplate(
            [template],
            renderVarsFor(template, ctx.event.eventKey, ctx.event.payload),
            context.prefs.locale
          );
          await writeFeedRow(db, ctx, userId, rendered.subject, rendered.body);
        }
      }
      continue;
    }

    const result = await dispatchOutbound(options, ctx, context, group, decision);
    if (result.retryableFailure) retryableFailure = true;
  }

  return { retryableFailure };
}

/**
 * Process one claimed outbox row: resolve the type and recipients, then fan out
 * to each recipient in isolation.
 *
 * @param options - The run seams.
 * @param event - The claimed `domainEvents` row.
 * @returns `{ retryableFailure }` — true when the event must stay claimable.
 */
async function processEvent(
  options: FanOutRunOptions,
  event: DomainEventDocument
): Promise<{ readonly retryableFailure: boolean }> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;

  const typeRow = await loadTypeRow(db, event.eventKey);
  if (!typeRow?.enabled) {
    // Absent or disabled type: the event is consumed with no recipients.
    return { retryableFailure: false };
  }

  const now = clock.now();
  const eventId = typeof event.payload.eventId === "string" ? event.payload.eventId : null;
  const actorUserId = event.actorRef.kind === "user" ? event.actorRef.id : null;
  const subjectUserId = event.subjectRef.kind === "user" ? event.subjectRef.id : null;

  // Settings and templates depend only on the type/event, not on recipients, so
  // fetch them together rather than serially.
  const [settings, templates] = await Promise.all([
    getPlatformSettings({ db, clock }),
    loadTemplates(db, event.eventKey),
  ]);

  const recipients = await resolveRecipients({
    typeRow,
    tenantId: event.tenantId,
    eventId,
    actorUserId,
    subjectUserId,
    repository: options.recipients,
  });

  const ctx: EventContext = {
    event,
    typeRow,
    templates,
    eventId,
    tenantId: event.tenantId,
    now,
    notificationExpireAt: addDays(now, settings.retention.notificationDays),
    dispatchExpireAt: addDays(now, settings.retention.dispatchDays),
  };

  let retryableFailure = false;
  for (const userId of recipients) {
    try {
      const result = await fanOutToRecipient(options, ctx, userId);
      if (result.retryableFailure) retryableFailure = true;
    } catch (error) {
      // Per-recipient isolation: an unexpected failure on one recipient must not
      // drop the rest. Treated as retryable so the event stays claimable.
      retryableFailure = true;
      getLogger().error("notification.fan_out_failed", {
        event: "notification.fan_out_failed",
        typeKey: typeRow.typeKey,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return { retryableFailure };
}

/**
 * Drain up to `batch` pending notification events (design §2–§5, ADR-0090).
 *
 * Claims pending outbox rows for the `notifications` consumer, fans each out to
 * its resolved recipients, and marks it `done` — or leaves it claimable via
 * `markFailed` when any recipient hit a retryable failure.
 *
 * @param options - Database/clock/transport/recipient seams.
 * @returns The run summary.
 */
export async function runNotificationFanOut(options: FanOutRunOptions): Promise<FanOutSummary> {
  const db = options.db ?? getDb();
  const clock = options.clock ?? systemClock;
  const batch = options.batch ?? 50;

  const claimed = await claimPendingEvents("notifications", batch, {
    db,
    clock,
    ...(options.claimerId === undefined ? {} : { claimerId: options.claimerId }),
  });

  let processed = 0;
  let failed = 0;

  for (const event of claimed) {
    const { retryableFailure } = await processEvent(options, event);
    if (retryableFailure) {
      await markFailed(event._id, "notifications", { db });
      failed += 1;
    } else {
      await markDone(event._id, "notifications", { db });
      processed += 1;
    }
  }

  return { claimed: claimed.length, processed, failed };
}

/* -------------------------------------------------------------------------- */
/* Synchronous transactional path (OP-95, ADR-0096)                           */
/* -------------------------------------------------------------------------- */

/** A Better Auth OTP channel — the two destinations an auth secret may travel. */
export type OtpChannel = "email" | "sms";

/** The facts {@link resolveOtpTarget} needs to pin an OTP channel. */
export interface OtpTargetInput {
  readonly channel: OtpChannel;
  readonly typeRow: NotificationType;
  readonly profile: ResolveProfile;
  readonly contacts: ResolveContacts;
}

/** The concrete routing target the synchronous path dispatches on. */
export interface OtpTarget {
  readonly typeKey: string;
  readonly channelGroup: ChannelGroupName;
  readonly channel: ResolvedChannel;
}

/**
 * The resolved-channel vocabulary the synchronous ledger persists (schema §19.5;
 * `body` is the OP-95 addition — retained only when the type permits it).
 */
export interface DispatchRecord {
  readonly typeKey: string;
  readonly channel: ResolvedChannel;
  readonly channelGroup: string;
  readonly status: "queued" | "sent" | "failed" | "skipped";
  readonly skipReason: string | null;
  readonly contactHash: string | null;
  readonly dedupeKey: string | null;
  readonly templateVersion: number | null;
  readonly body: string | null;
  readonly attempts: number;
  readonly lastError: {
    readonly retryable: boolean;
    readonly code: string;
    readonly status?: number;
  } | null;
  readonly queuedAt: Date;
  readonly sentAt: Date | null;
  readonly failedAt: Date | null;
  readonly expireAt: Date;
}

/** The pure inputs {@link buildDispatchRecord} folds into a ledger row. */
export interface DispatchRecordInput {
  readonly typeRow: NotificationType;
  readonly userId?: string | null;
  readonly tenantId?: string | null;
  readonly eventId?: string | null;
  readonly channel: ResolvedChannel;
  readonly channelGroup: string;
  readonly contactHash?: string | null;
  readonly dedupeKey?: string | null;
  readonly templateVersion?: number | null;
  readonly rendered?: { readonly subject: string; readonly body: string } | null;
  readonly now: Date;
  readonly expireAt: Date;
}

/** The synchronous send input (ADR-0096). */
export interface TransactionalSendInput {
  readonly db?: Db;
  readonly transport: MessageTransport;
  readonly clock?: Clock;
  readonly typeKey: string;
  readonly channel: OtpChannel;
  readonly destination: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly userId?: string | null;
}

/** The result of a synchronous send. */
export interface TransactionalSendResult {
  readonly dispatchId: string;
  readonly status: "sent";
  readonly providerMessageId: string;
}

/** A default preference set: only the exhaustion of a channel matters for an OTP. */
const OTP_PREFS: ResolvePreferences = {
  global: { in_app: "on", email: "on", mobile: "on" },
  byType: {},
  byEvent: {},
  quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" },
  locale: FALLBACK_LOCALE,
};

/** The routing group a Better Auth OTP channel targets. */
function otpGroupName(channel: OtpChannel): ChannelGroupName {
  return channel === "email" ? "email" : "mobile";
}

/**
 * Pin a Better Auth OTP channel to the concrete `(typeKey, group, channel)` the
 * synchronous path dispatches (U1, design §4.1).
 *
 * It reuses the real {@link resolveChannel} against the seeded OTP type row — it
 * is not a re-implementation of the resolver. The `auth.otp.mobile.requested`
 * type declares `mobileCandidates: ["sms"]`, so a `whatsappCapable` user still
 * gets `sms`; WhatsApp must never carry an auth secret.
 *
 * @param input - The requested channel, the type row and the recipient facts.
 * @returns The pinned target; `channelGroup`/`channel` are the resolver's.
 * @throws When the resolver does not return a `send` (naming the skip reason).
 */
export function resolveOtpTarget(input: OtpTargetInput): OtpTarget {
  const groupName = otpGroupName(input.channel);
  const group = input.typeRow.channelGroups.find((candidate) => candidate.group === groupName);
  if (group === undefined) {
    throw new Error(`notification type ${input.typeRow.typeKey} has no ${groupName} routing group`);
  }

  const decision = resolveChannel({
    typeRow: input.typeRow,
    group,
    prefs: OTP_PREFS,
    profile: input.profile,
    contacts: input.contacts,
    suppressions: [],
    now: new Date(0),
    eventId: null,
    throttleState: {},
  });

  if (decision.kind !== "send") {
    const detail = decision.kind === "skip" ? decision.reason : decision.kind;
    throw new Error(`OTP send for ${input.typeRow.typeKey} skipped: ${detail}`);
  }

  return { typeKey: input.typeRow.typeKey, channelGroup: group.group, channel: decision.channel };
}

/**
 * Build the metadata-only dispatch ledger row (U2, schema §19.5).
 *
 * The rendered body is stamped onto the row **only** when the type's
 * `retainBody` is `true`. Every `auth.otp.*` type is `retainBody: false`, so the
 * one-time code can never reach the durable ledger (contract §0.13).
 *
 * @param input - The recipient/rendered facts and the instants.
 * @returns The ledger row (status `queued`).
 */
export function buildDispatchRecord(input: DispatchRecordInput): DispatchRecord {
  return {
    typeKey: input.typeRow.typeKey,
    channel: input.channel,
    channelGroup: input.channelGroup,
    status: "queued",
    skipReason: null,
    contactHash: input.contactHash ?? null,
    dedupeKey: input.dedupeKey ?? null,
    templateVersion: input.templateVersion ?? null,
    body: input.typeRow.retainBody ? (input.rendered?.body ?? null) : null,
    attempts: 0,
    lastError: null,
    queuedAt: input.now,
    sentAt: null,
    failedAt: null,
    expireAt: input.expireAt,
  };
}

/** The contact facts for the requested OTP channel only. */
function otpContacts(channel: OtpChannel, destination: string): ResolveContacts {
  return {
    email: channel === "email" ? destination : null,
    emailVerified: channel === "email",
    phoneNumber: channel === "sms" ? destination : null,
    phoneNumberVerified: channel === "sms",
  };
}

/** A seeded OTP type row, used when the catalogue has not been seeded. */
function seededTypeRow(typeKey: string): NotificationType | null {
  return SEED_NOTIFICATION_TYPES.find((type) => type.typeKey === typeKey) ?? null;
}

/**
 * Guard the sanctioned seed-catalogue fallback against silence (OP-95
 * follow-up F2, ADR-0100; the fallback itself is the E1 resolution, ADR-0098 §6).
 *
 * Production must never serve the compile-time seed behind an empty or
 * schema-invalid stored catalogue; outside production the fallback is kept but
 * recorded at warn level so an operator can see the miss. The environment is
 * read at call time through the uncached {@link getAppEnv} — the memoised
 * `getConfig()` would pin the boot-time answer.
 *
 * @param typeKey - The notification type whose stored row was absent/invalid.
 * @param collection - The catalogue collection the fallback stands in for.
 * @throws When the process runs in production.
 */
function guardSeededCatalogueFallback(typeKey: string, collection: string): void {
  if (getAppEnv() === "production") {
    throw new Error(
      `notification catalogue fallback is not permitted in production: ${typeKey} (${collection})`
    );
  }
  getLogger().warn("notification.catalogue_fallback", {
    event: "notification.catalogue_fallback",
    typeKey,
    collection,
  });
}

/** The active seeded templates for a type, grouped by routing channel. */
function seededTemplates(typeKey: string): Map<string, readonly NotificationTemplate[]> {
  const byChannel = new Map<string, NotificationTemplate[]>();
  for (const template of SEED_NOTIFICATION_TEMPLATES) {
    if (template.typeKey !== typeKey || !template.active) continue;
    const list = byChannel.get(template.channel);
    if (list === undefined) {
      byChannel.set(template.channel, [template]);
    } else {
      list.push(template);
    }
  }
  return byChannel;
}

/**
 * Send one transactional message synchronously (design §5/§8.2; ADR-0096).
 *
 * The synchronous sibling of {@link runNotificationFanOut}: resolve → render →
 * persist one metadata-only dispatch row → hand the rendered message to the
 * injected {@link MessageTransport} — with no outbox claim or delay, and never
 * an in-app feed row. A transport failure marks the row `failed` (carrying the
 * classified `lastError`) and rethrows so the caller can map it to a retryable
 * response.
 *
 * @param input - Database/clock/transport seams and the rendered inputs.
 * @returns The dispatch id, `sent` status and the transport receipt id.
 * @throws When the type/template cannot be resolved or the transport fails.
 */
export async function sendTransactionalNow(
  input: TransactionalSendInput
): Promise<TransactionalSendResult> {
  const db = input.db ?? getDb();
  const clock = input.clock ?? systemClock;

  // The type row, its templates and the platform settings are independent
  // reads; issue them together instead of awaiting one after the other (OP-95
  // follow-up F3).
  const [storedType, storedTemplates, settings] = await Promise.all([
    loadTypeRow(db, input.typeKey),
    loadTemplates(db, input.typeKey),
    getPlatformSettings({ db, clock }),
  ]);

  if (storedType === null) {
    guardSeededCatalogueFallback(input.typeKey, COLLECTIONS.notificationTypes);
  }
  const typeRow = storedType ?? seededTypeRow(input.typeKey);
  if (typeRow?.enabled !== true) {
    throw new Error(`unknown or disabled notification type: ${input.typeKey}`);
  }

  const target = resolveOtpTarget({
    channel: input.channel,
    typeRow,
    profile: {
      userId: input.userId ?? "",
      contactCapabilities: { whatsappCapable: null, whatsappCheckedAt: null },
    },
    contacts: otpContacts(input.channel, input.destination),
  });

  // Validate the resolved channel *before* the dispatch insert (OP-95
  // follow-up F4): a non-deliverable target must not leave a permanently
  // `queued` orphan ledger row behind.
  if (target.channel !== "email" && target.channel !== "sms") {
    throw new Error(`OTP target resolved to a non-deliverable channel: ${target.channel}`);
  }

  const storedForGroup = storedTemplates.get(target.channelGroup);
  if (storedForGroup === undefined) {
    guardSeededCatalogueFallback(input.typeKey, COLLECTIONS.notificationTemplates);
  }
  const candidates =
    storedForGroup ?? seededTemplates(input.typeKey).get(target.channelGroup) ?? [];
  const template = selectTemplate(candidates, FALLBACK_LOCALE);
  if (template === undefined) {
    throw new Error(`no active template for ${input.typeKey}/${target.channelGroup}`);
  }

  const rendered = renderTemplate(
    [template],
    renderVarsFor(template, input.typeKey, input.payload),
    FALLBACK_LOCALE
  );

  const now = clock.now();
  const record = buildDispatchRecord({
    typeRow,
    userId: input.userId ?? null,
    channel: target.channel,
    channelGroup: target.channelGroup,
    contactHash: contactHashOf(input.destination),
    templateVersion: template.version,
    rendered,
    now,
    expireAt: addDays(now, settings.retention.dispatchDays),
  });

  const document = {
    ...record,
    userId: asObjectId(input.userId),
    tenantId: null,
    eventId: null,
  };
  const inserted = await platformRepo(db).collection(COLLECTIONS.dispatches).insertOne(document);
  const dispatchId = inserted.insertedId.toHexString();

  const message = buildOutboundMessage(
    target.channel,
    input.userId ?? "",
    input.destination,
    rendered.subject,
    rendered.body
  );

  try {
    const receipt = await input.transport.send(message);
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: inserted.insertedId },
        {
          $set: {
            status: "sent",
            attempts: 1,
            sentAt: now,
            providerRef: {
              provider: "transport",
              env: transportEnv(),
              messageId: receipt.providerMessageId,
            },
          },
        }
      );
    getLogger().info("notification.transactional_sent", {
      event: "notification.transactional_sent",
      typeKey: typeRow.typeKey,
      channel: target.channel,
      contactHashPrefix: record.contactHash?.slice(0, 8) ?? null,
    });
    return { dispatchId, status: "sent", providerMessageId: receipt.providerMessageId };
  } catch (error) {
    const failure = classifyError(error);
    await platformRepo(db)
      .collection(COLLECTIONS.dispatches)
      .updateOne(
        { _id: inserted.insertedId },
        { $set: { status: "failed", attempts: 1, failedAt: clock.now(), lastError: failure } }
      );
    getLogger().error("notification.transactional_failed", {
      event: "notification.transactional_failed",
      typeKey: typeRow.typeKey,
      channel: target.channel,
      code: failure.code,
      retryable: failure.retryable,
      contactHashPrefix: record.contactHash?.slice(0, 8) ?? null,
    });
    throw error;
  }
}
