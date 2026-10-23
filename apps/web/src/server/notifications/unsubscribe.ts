import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChannelGroup, NotificationType } from "@/server/notifications/notification-types";
import {
  humaniseKey,
  type GroupPreferences,
  type StoredPreferences,
} from "@/server/notifications/preferences";
import { systemClock, type Clock } from "@/server/runtime/clock";

/**
 * One-click unsubscribe — the signed token and the scope reducer (OP-99,
 * contract §7.5; design §19.6; ADR-0240, ADR-0241).
 *
 * The public unsubscribe surface is driven by one HMAC token, so its two
 * correctness-critical behaviours live here as pure functions rather than in the
 * route handler:
 *
 *   - {@link signUnsubscribeToken} mints an opaque token over
 *     `{ userId, scope, typeKey? }` with a `now + 90 days` expiry, and
 *     {@link verifyUnsubscribeToken} returns that signed payload back —
 *     `exp` stripped — for an untampered token inside the window, or a stable
 *     `"invalid" | "expired"` reason. The clock is injected (`Clock`), so both
 *     are deterministic under test.
 *   - {@link applyUnsubscribeScope} is the reducer: `"all"` mutes the `email`
 *     channel group of every opt-outable type, `"type"` mutes exactly one, and
 *     `"marketing"` writes no `byType` at all. It never mutes a transactional
 *     type, and it never mutates the document handed to it.
 *
 * ## The wire format (ADR-0240)
 *
 * ```
 * token   = base64url(payloadJson) + "." + lowercase hex HMAC-SHA256(base64url(payloadJson))
 * payload = { userId, scope, typeKey?, exp }   // exp = epoch seconds
 * ```
 *
 * The HMAC is compared in constant time (`timingSafeEqual`), so a tampered
 * token is rejected without a usable timing oracle. A token is valid while
 * `now < exp`; at exactly `exp` it is expired.
 *
 * ## Why `marketing` writes no `byType`, and why `all` never mutes a
 * transactional type
 *
 * The standing user story — _control marketing mail without losing security or
 * billing notices_ — is structural here: the reducer only ever writes the
 * `email` group of a type whose group is enabled, opt-outable and **not**
 * transactional, so no token can mute an OTP or a payment failure.
 * `{"scope": "all"}` is deliberately **not** written as a suppression row: a
 * `scope: "all"` suppression is the permanent "never contact" list, which is
 * exactly what an unsubscribe must not create (design §19.6).
 *
 * The surface is email-only: `mobile` and `in_app` are never touched, whatever
 * the token says.
 */

/** The scope an unsubscribe token may carry (contract §7.5). */
export type UnsubscribeScope = "type" | "marketing" | "all";

/** The signed payload of an unsubscribe token, expiry claim excluded (contract §7.5). */
export interface UnsubscribeTokenPayload {
  /** The Better Auth user id as a 24-hex string. */
  readonly userId: string;
  /** What the token authorises. */
  readonly scope: UnsubscribeScope;
  /** The muted type; present **iff** `scope` is `"type"`. */
  readonly typeKey?: string;
}

/** The on-the-wire payload: the signed payload plus its expiry claim. */
interface ExpiringUnsubscribeTokenPayload extends UnsubscribeTokenPayload {
  /** Epoch seconds at which the token stops being valid. */
  readonly exp: number;
}

/** The verifier's verdict: the signed payload, or why the token was rejected. */
export type UnsubscribeTokenVerdict =
  | { readonly valid: true; readonly payload: UnsubscribeTokenPayload }
  | { readonly valid: false; readonly reason: "invalid" | "expired" };

/** The reducer's result: the next document, what it muted, and what still delivers. */
export interface UnsubscribeApplication {
  /** The next stored document; a copy, so the input is never mutated. */
  readonly preferences: StoredPreferences;
  /** The sorted `typeKey`s whose `email` group is (or would be) set `off`. */
  readonly mutedTypeKeys: string[];
  /**
   * The sorted labels of the enabled transactional types that keep receiving
   * mail — how the `200` body says explicitly that critical notices are
   * unaffected (contract §7.5).
   */
  readonly stillReceiving: string[];
}

/** The contract's 90-day token lifetime (contract §7.5). */
export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 90;

/** Seconds in a day. */
const SECONDS_PER_DAY = 24 * 60 * 60;

/** The scope vocabulary, in contract order. */
const SCOPES: readonly UnsubscribeScope[] = ["type", "marketing", "all"];

/** The one channel group an unsubscribe may ever write (design §19.6). */
const EMAIL_GROUP = "email";

/** The options both token functions accept: the secret and an injected clock. */
export interface UnsubscribeTokenOptions {
  /** The `UNSUBSCRIBE_SIGNING_SECRET` the token is signed with. */
  readonly secret: string;
  /** The clock the expiry is measured against; defaults to the wall clock. */
  readonly now?: Clock;
}

/** True for a member of the scope vocabulary. */
function isUnsubscribeScope(value: unknown): value is UnsubscribeScope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

/** The HMAC-SHA256 of one encoded segment, lowercase hex (ADR-0240 wire format). */
function signatureHex(secret: string, encoded: string): string {
  return createHmac("sha256", secret).update(encoded, "utf8").digest("hex");
}

/** Constant-time compare that never short-circuits on a length mismatch. */
function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Mint an unsubscribe token (contract §7.5; ADR-0240).
 *
 * @param payload - The signed payload (`{ userId, scope, typeKey? }`).
 * @param options - The signing secret and an optional injected clock.
 * @returns The `base64url(payload).signature` token.
 */
export function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  options: UnsubscribeTokenOptions
): string {
  const clock = options.now ?? systemClock;
  const exp =
    Math.floor(clock.now().getTime() / 1000) + UNSUBSCRIBE_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
  const encoded = Buffer.from(
    JSON.stringify({
      userId: payload.userId,
      scope: payload.scope,
      ...(payload.typeKey === undefined ? {} : { typeKey: payload.typeKey }),
      exp,
    }),
    "utf8"
  ).toString("base64url");

  return `${encoded}.${signatureHex(options.secret, encoded)}`;
}

/**
 * Decode and shape-check the payload segment of a token.
 *
 * @param encoded - The base64url payload segment.
 * @returns The typed payload, or `null` when the segment is not a valid payload.
 */
function decodeUnsubscribePayload(encoded: string): ExpiringUnsubscribeTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const { userId, scope, typeKey, exp } = record;
  if (typeof userId !== "string" || userId === "") {
    return null;
  }
  if (!isUnsubscribeScope(scope)) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  if (typeKey !== undefined && typeof typeKey !== "string") {
    return null;
  }

  return { userId, scope, ...(typeKey === undefined ? {} : { typeKey }), exp };
}

/**
 * Verify an unsubscribe token and return its signed payload (contract §7.5).
 *
 * Never throws: a malformed, truncated or tampered token is
 * `{ valid: false, reason: "invalid" }` and a correctly-signed token at or past
 * its expiry is `{ valid: false, reason: "expired" }`. The signature is
 * recomputed over the token's own payload segment and compared in constant time
 * before the payload is even parsed, so a tampered token cannot probe the
 * payload.
 *
 * @param token - The raw token from the request path.
 * @param options - The signing secret and an optional injected clock.
 * @returns `{ valid: true, payload }` — the signed payload exactly, `exp`
 *   stripped — or a coded rejection.
 */
export function verifyUnsubscribeToken(
  token: string,
  options: UnsubscribeTokenOptions
): UnsubscribeTokenVerdict {
  const clock = options.now ?? systemClock;
  const segments = token.split(".");
  if (segments.length !== 2) {
    return { valid: false, reason: "invalid" };
  }

  const encoded = segments[0] ?? "";
  const signature = segments[1] ?? "";
  if (encoded === "" || signature === "") {
    return { valid: false, reason: "invalid" };
  }

  if (!constantTimeEquals(signature, signatureHex(options.secret, encoded))) {
    return { valid: false, reason: "invalid" };
  }

  const payload = decodeUnsubscribePayload(encoded);
  if (payload === null) {
    return { valid: false, reason: "invalid" };
  }

  // Valid while `now < exp`; at exactly `exp` the token is expired.
  if (clock.now().getTime() >= payload.exp * 1000) {
    return { valid: false, reason: "expired" };
  }

  return {
    valid: true,
    payload: {
      userId: payload.userId,
      scope: payload.scope,
      ...(payload.typeKey === undefined ? {} : { typeKey: payload.typeKey }),
    },
  };
}

/** The `email` channel group of a type, whether enabled or not, or `undefined`. */
function emailGroupOf(type: NotificationType): ChannelGroup | undefined {
  return type.channelGroups.find((group) => group.group === EMAIL_GROUP);
}

/**
 * Whether the unsubscribe surface may mute `type`'s `email` group.
 *
 * "Opt-outable" means the type is enabled, not transactional, and its **enabled**
 * `email` group carries `optOutAllowed: true` (ADR-0240 assumption #2). A
 * disabled group is never muted even when it advertises `optOutAllowed`.
 *
 * @param type - A catalogue type.
 * @returns `true` when a mute is allowed.
 */
function isEmailMuteable(type: NotificationType): boolean {
  const email = emailGroupOf(type);
  return (
    type.enabled &&
    !type.transactional &&
    email !== undefined &&
    email.enabled &&
    email.optOutAllowed
  );
}

/**
 * The `typeKey`s the scope mutes, sorted (contract §7.5).
 *
 * @param input - The catalogue, the scope and its optional `typeKey`.
 * @returns The sorted muted keys; empty for `"marketing"` and for a `"type"`
 *   scope that names a type the surface may not mute.
 */
function mutedTypeKeysOf(input: {
  readonly catalogue: readonly NotificationType[];
  readonly scope: UnsubscribeScope;
  readonly typeKey?: string | undefined;
}): string[] {
  if (input.scope === "marketing") {
    return [];
  }

  if (input.scope === "type") {
    const type = input.catalogue.find((candidate) => candidate.typeKey === input.typeKey);
    return type !== undefined && isEmailMuteable(type) ? [type.typeKey] : [];
  }

  return input.catalogue.filter(isEmailMuteable).map((type) => type.typeKey);
}

/**
 * The sorted labels of the enabled transactional types that keep receiving mail.
 *
 * The seed stores no copy (§19.1), so the label is `type.label ?? humaniseKey(
 * typeKey)` — the same projection the settings read uses.
 *
 * @param catalogue - The enabled catalogue.
 * @returns The sorted labels.
 */
function stillReceivingLabels(catalogue: readonly NotificationType[]): string[] {
  return catalogue
    .filter((type) => type.enabled && type.transactional)
    .filter((type) => emailGroupOf(type)?.enabled === true)
    .map((type) => type.label ?? humaniseKey(type.typeKey))
    .sort();
}

/** A shallow copy of a sparse scope map (`byType` / `byEvent`). */
function copyScope(
  scope: Readonly<Record<string, GroupPreferences>>
): Record<string, GroupPreferences> {
  const next: Record<string, GroupPreferences> = {};
  for (const [key, groups] of Object.entries(scope)) {
    next[key] = { ...groups };
  }
  return next;
}

/**
 * Apply an unsubscribe scope to a preferences document (contract §7.5).
 *
 * Pure: the input document is never mutated and every scope it does not own is
 * copied through untouched. `"all"` mutes the `email` group of every
 * opt-outable type, `"type"` mutes exactly one (and silently no-ops when that
 * type may not be muted), and `"marketing"` writes no `byType` at all — the
 * route owns the `marketingOptIn`/suppression write.
 *
 * @param input - The stored document, the catalogue and the scope to apply.
 * @returns The next document plus `mutedTypeKeys` and `stillReceiving`, sorted.
 */
export function applyUnsubscribeScope(input: {
  readonly preferences: StoredPreferences;
  readonly catalogue: readonly NotificationType[];
  readonly scope: UnsubscribeScope;
  readonly typeKey?: string | undefined;
}): UnsubscribeApplication {
  const mutedTypeKeys = mutedTypeKeysOf(input);

  const byType = copyScope(input.preferences.byType);
  for (const typeKey of mutedTypeKeys) {
    byType[typeKey] = { ...(byType[typeKey] ?? {}), [EMAIL_GROUP]: "off" };
  }

  return {
    preferences: {
      global: { ...input.preferences.global },
      byType,
      byEvent: copyScope(input.preferences.byEvent),
      quietHours: { ...input.preferences.quietHours },
      digest: { ...input.preferences.digest },
      locale: input.preferences.locale,
    },
    mutedTypeKeys: [...mutedTypeKeys].sort(),
    stillReceiving: stillReceivingLabels(input.catalogue),
  };
}
