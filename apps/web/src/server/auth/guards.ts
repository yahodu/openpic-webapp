import type { Db } from "mongodb";
import { ObjectId } from "mongodb";

import type { AuthErrorCode } from "@openpic/contracts";

import type { AuthLike } from "@/server/auth";
import { appError } from "@/server/http/errors";
import type { RouteStage } from "@/server/http/define-route";
import { requestLogger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";

/**
 * Auth guards — one uniform enforcement point for every auth label (OP-86,
 * contract §0.3, ADR-0023).
 *
 * The story separates three concerns so each is independently testable:
 *
 *   - {@link evaluateAuth} is the pure decision table: given a label and the
 *     credential facts, it returns `{ allowed: true }` or a denial
 *     (`{ allowed: false, code, details? }`). It never throws and never touches
 *     the network, a clock or a database — `facts.now` is injected so a ban
 *     boundary is exact.
 *   - {@link resolvePrincipal} turns a real request (Better Auth cookie or
 *     mobile bearer token) into the typed {@link Principal} union the policy
 *     consumes, loading `userProfiles` for the user's profile fields.
 *   - {@link requireAuth} is the `defineRoute` pipeline stage that joins them:
 *     it resolves the principal, asks the table, publishes the principal id on
 *     `ctx.principal` and throws the catalogue `AppError` on a denial.
 *
 * The full credential union additionally carries `internal` and `provider`,
 * which are delegated to OP-87/OP-113 and deliberately have no decision rule
 * here.
 */

/** The identity labels this story owns. */
export type GuardLabel = "public" | "user" | "user:complete" | "attendee" | "admin";

/**
 * Every auth label an endpoint may declare (contract §0.3).
 *
 * `internal` and `provider` are delegated to later stories; `requireAuth`
 * refuses them until those stories land their own stages.
 */
export type AuthLabel = GuardLabel | "internal" | "provider";

/** The denial codes the decision table can produce (contract Appendix A.1). */
export type AuthDenyCode = AuthErrorCode | "forbidden";

/** A resolved Better Auth user plus the profile fields the policy needs. */
export interface UserPrincipal {
  readonly kind: "user";
  /** Better Auth user id, as a hex string. */
  readonly userId: string;
  readonly status: string;
  readonly platformRole: string;
  readonly accountCompletedAt: Date | null;
  readonly emailVerified: boolean;
  readonly phoneNumberVerified: boolean;
  readonly twoFactorEnabled: boolean;
  /**
   * Whether *this session* passed the second factor.
   *
   * Deliberately per-session: a session minted before 2FA was enabled (I6) or a
   * phone-OTP first-factor sign-in (I7) both carry `twoFactorEnabled` yet never
   * passed the second factor. See ADR-0023 §4.
   */
  readonly sessionTwoFactorVerified: boolean;
  readonly banned: boolean;
  readonly banReason: string | null;
  readonly banExpires: Date | null;
}

/** A resolved anonymous attendee session (OP-129 owns the real resolver). */
export interface AttendeePrincipal {
  readonly kind: "attendee";
  readonly sessionId: string;
  readonly eventId: string | null;
}

/** The credential a guard resolved for a request. */
export type Principal = UserPrincipal | AttendeePrincipal;

/** The inputs the pure decision table branches on. */
export interface GuardFacts {
  /** The resolved credential, or `null` when the request carried none. */
  readonly principal: Principal | null;
  /** The instant ban expiry is compared against; injected so it is exact. */
  readonly now: Date;
  /**
   * Set by the route to exempt it from the ban rule.
   *
   * `GET /me` and `POST /me/data-requests` set it so a banned user can still
   * read why they are banned (contract §0.3).
   */
  readonly allowBanned?: boolean;
}

/** The decision the pure table returns. */
export type AuthDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: AuthDenyCode;
      readonly details?: Record<string, unknown>;
    };

/** The verification flags `account_incomplete.details.missing` names. */
const COMPLETION_FLAGS = ["emailVerified", "phoneNumberVerified"] as const;

/** Where a client goes to finish account setup (`account_incomplete.verifyUrl`). */
const COMPLETE_ACCOUNT_URL = "/account/complete";

/** Where a client goes to enrol the second factor (`admin_2fa_required.setupUrl`). */
const TWO_FACTOR_SETUP_URL = "/settings/security/two-factor";

/** Where a client can contact support about a suspension. */
const SUPPORT_URL = "/support";

/** `forbidden` for a non-`active` profile (deletion states) carries no role. */
function forbidden(): AuthDecision {
  return { allowed: false, code: "forbidden" };
}

/** True when the principal is a banned user whose ban has not yet expired. */
function isUnbanned(principal: UserPrincipal, now: Date): boolean {
  if (!principal.banned) {
    return true;
  }
  if (principal.banExpires === null) {
    // A missing expiry is a permanent ban.
    return false;
  }
  // Inclusive boundary: at the expiry instant the ban is over.
  return principal.banExpires.getTime() <= now.getTime();
}

/**
 * Decide whether `facts` satisfies `label` (contract §0.3).
 *
 * The order is fixed so the first matching rule wins: suspension, deletion,
 * ban, then the label's own requirements. A denial is a stable `code` plus any
 * documented `details`; the transport turns it into the Appendix A status.
 *
 * @param label - The guard label the endpoint declared.
 * @param facts - The resolved credential and the injected clock.
 * @returns `{ allowed: true }` or a coded denial.
 */
export function evaluateAuth(label: GuardLabel, facts: GuardFacts): AuthDecision {
  if (label === "public") {
    return { allowed: true };
  }

  const { principal } = facts;

  // An attendee session satisfies only the attendee label; every user label
  // needs a user session, and a missing credential is `authentication_required`.
  if (principal === null) {
    return { allowed: false, code: "authentication_required" };
  }
  if (principal.kind === "attendee") {
    if (label === "attendee") {
      return { allowed: true };
    }
    return { allowed: false, code: "authentication_required" };
  }

  const user = principal;

  if (user.status === "suspended") {
    return {
      allowed: false,
      code: "account_suspended",
      details: { reason: "suspended", supportUrl: SUPPORT_URL },
    };
  }

  if (user.status === "deletion_pending" || user.status === "deleted") {
    return forbidden();
  }

  if (facts.allowBanned !== true && !isUnbanned(user, facts.now)) {
    return {
      allowed: false,
      code: "account_banned",
      details: {
        banReason: user.banReason,
        banExpires: user.banExpires === null ? null : user.banExpires.toISOString(),
      },
    };
  }

  if (label === "user:complete" && user.accountCompletedAt === null) {
    const missing = COMPLETION_FLAGS.filter((flag) => !user[flag]);
    return {
      allowed: false,
      code: "account_incomplete",
      details: { missing, verifyUrl: COMPLETE_ACCOUNT_URL },
    };
  }

  if (label === "admin") {
    if (user.platformRole !== "admin") {
      return { allowed: false, code: "forbidden", details: { requiredRole: "admin" } };
    }
    if (!user.twoFactorEnabled || !user.sessionTwoFactorVerified) {
      return {
        allowed: false,
        code: "admin_2fa_required",
        details: { setupUrl: TWO_FACTOR_SETUP_URL },
      };
    }
  }

  return { allowed: true };
}

/** A structural view of the `userProfiles` fields the resolver reads (schema §13.2). */
interface UserProfileDocument {
  readonly status?: unknown;
  readonly platformRole?: unknown;
  readonly accountCompletedAt?: unknown;
}

/** The `userProfiles` collection name. */
const USER_PROFILES_COLLECTION = "userProfiles";

/** The Better Auth session endpoint the resolver reads the credential from. */
const GET_SESSION_PATH = "/api/auth/get-session";

/**
 * A port for resolving anonymous attendee sessions (OP-129 owns the real one).
 *
 * Until OP-129 lands, the default resolver never resolves an attendee, so the
 * `attendee` label behaves exactly as `user` for a real request.
 */
export interface AttendeeSessionResolver {
  resolve(request: Request): Promise<AttendeePrincipal | null>;
}

/** The default attendee resolver: no attendee sessions exist yet. */
export const noAttendeeSessions: AttendeeSessionResolver = {
  resolve: () => Promise.resolve(null),
};

/** Options accepted by {@link resolvePrincipal}. */
export interface ResolvePrincipalOptions {
  /** The configured Better Auth instance (its HTTP handler). */
  readonly auth: AuthLike;
  /** The database holding `userProfiles`. */
  readonly database: Db;
  /** Attendee-session port; defaults to the OP-129 stub. */
  readonly attendeeResolver?: AttendeeSessionResolver;
}

/** Read a value as a string, or `null`. */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Read a value as a boolean, defaulting to `false`. */
function asBoolean(value: unknown): boolean {
  return value === true;
}

/** Read a value as a `Date`, or `null`. */
function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** True when the value is a plain object we can read fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Forward the credential-carrying headers onto the internal session request. */
function credentialHeaders(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    headers.set("authorization", authorization);
  }
  return headers;
}

/** Load the profile fields from `userProfiles`, defaulting the missing profile. */
async function loadProfile(database: Db, userId: string): Promise<UserProfileDocument> {
  let objectId: ObjectId;
  try {
    objectId = new ObjectId(userId);
  } catch {
    return {};
  }
  const profile = await database
    .collection<UserProfileDocument>(USER_PROFILES_COLLECTION)
    .findOne({ userId: objectId } as never);
  return profile ?? {};
}

/**
 * Resolve the principal for a request from its Better Auth session.
 *
 * The cookie and `Authorization: Bearer` headers are forwarded to Better Auth's
 * own `GET /api/auth/get-session` (never a hand-rolled session read, ADR-0020),
 * then `userProfiles` is loaded by user id. A missing profile resolves to the
 * permissive defaults so a user without a profile row is never locked out.
 *
 * @param request - The inbound request whose credential should be resolved.
 * @param options - The auth instance, database and optional attendee port.
 * @returns The typed principal, or `null` when the request carried none.
 */
export async function resolvePrincipal(
  request: Request,
  options: ResolvePrincipalOptions
): Promise<Principal | null> {
  const sessionRequest = new Request(new URL(GET_SESSION_PATH, request.url), {
    method: "GET",
    headers: credentialHeaders(request),
  });

  const response = await options.auth.handler(sessionRequest);
  if (!response.ok) {
    return resolveAttendee(request, options);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !isRecord(payload.user) || !isRecord(payload.session)) {
    return resolveAttendee(request, options);
  }

  const user = payload.user;
  const session = payload.session;
  const userId = asString(user.id);
  if (userId === null) {
    return resolveAttendee(request, options);
  }

  const profile = await loadProfile(options.database, userId);
  const status = asString(profile.status) ?? "active";
  const platformRole = asString(profile.platformRole) ?? "client";

  return {
    kind: "user",
    userId,
    status,
    platformRole,
    accountCompletedAt: asDate(profile.accountCompletedAt),
    emailVerified: asBoolean(user.emailVerified),
    phoneNumberVerified: asBoolean(user.phoneNumberVerified),
    twoFactorEnabled: asBoolean(user.twoFactorEnabled),
    sessionTwoFactorVerified: asBoolean(session.twoFactorVerified),
    banned: asBoolean(user.banned),
    banReason: asString(user.banReason),
    banExpires: asDate(user.banExpires),
  };
}

/** Try the attendee-session port when no user session resolved. */
function resolveAttendee(
  request: Request,
  options: ResolvePrincipalOptions
): Promise<Principal | null> {
  return (options.attendeeResolver ?? noAttendeeSessions).resolve(request);
}

/** Options accepted by {@link requireAuth}. */
export interface RequireAuthOptions {
  /** The configured Better Auth instance (its HTTP handler). */
  readonly auth: AuthLike;
  /** The database holding `userProfiles`. */
  readonly database: Db;
  /** Set on the ban-exempt routes (`GET /me`, `POST /me/data-requests`). */
  readonly allowBanned?: boolean;
  /** Attendee-session port; defaults to the OP-129 stub. */
  readonly attendeeResolver?: AttendeeSessionResolver;
}

/**
 * Build the `defineRoute` auth stage for one label.
 *
 * On allow it publishes the user id on `ctx.principal` (the identity rate-limit
 * tier consumes it) and returns `undefined`. On denial it emits one `warn`
 * `auth.denied` log carrying the label and reason code — never the credential —
 * and throws the catalogue `AppError`.
 *
 * @param label - The label the route declares.
 * @param options - The auth instance, database and route flags.
 * @returns A pipeline stage.
 */
export function requireAuth(label: AuthLabel, options: RequireAuthOptions): RouteStage {
  return async (ctx, request) => {
    // `internal`/`provider` are delegated to OP-87/OP-113; refusing here keeps
    // an endpoint from silently believing it enforces them.
    if (label === "internal" || label === "provider") {
      throw appError("not_implemented", {
        message: `The '${label}' auth label is not implemented yet.`,
      });
    }

    const principal = await resolvePrincipal(request, {
      auth: options.auth,
      database: options.database,
      ...(options.attendeeResolver === undefined
        ? {}
        : { attendeeResolver: options.attendeeResolver }),
    });

    const decision = evaluateAuth(label, {
      principal,
      now: systemClock.now(),
      ...(options.allowBanned === true ? { allowBanned: true } : {}),
    });

    if (!decision.allowed) {
      requestLogger(request, { route: ctx.route }).warn("auth request denied", {
        event: "auth.denied",
        label,
        reason: decision.code,
      });
      throw appError(
        decision.code,
        decision.details === undefined ? {} : { details: decision.details }
      );
    }

    if (principal !== null && principal.kind === "user") {
      Object.assign(ctx, { principal: principal.userId });
    }

    return undefined;
  };
}
