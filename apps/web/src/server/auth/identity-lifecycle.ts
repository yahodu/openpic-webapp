import { ObjectId } from "mongodb";

import type { BetterAuthOptions } from "better-auth";

import { getLogger } from "@/server/logging";
import type { Clock } from "@/server/runtime/clock";

import {
  handleContactChanged,
  handleContactVerified,
  handleSessionCreated,
  handleSessionsRevoked,
  handleTwoFactorToggled,
  handleUserCreated,
  type ClaimAttendeeSession,
  type ContactChangedEvent,
  type EmitDomainEvent,
  type IdentityHookDeps,
  type SessionsRevokedEvent,
  type TwoFactorToggledEvent,
} from "./identity-hooks";

/**
 * Better Auth lifecycle-hook wiring (OP-89, contract §1.1, ADR-0038 §1, ADR-0040
 * §5).
 *
 * Better Auth owns `/api/auth/**`, so the only sanctioned seam between auth and
 * the app is its own hook system. This module adapts the library's database
 * hooks into the plain-input policy handlers in `identity-hooks.ts`:
 *
 *   - `databaseHooks.user.create.after` → {@link handleUserCreated};
 *   - `databaseHooks.session.create.after` → {@link handleSessionCreated},
 *     which also reads the raw unclaimed `op_att` cookie and hands it to the
 *     injectable claim seam.
 *
 * Every adapter never throws: a lifecycle failure logs `identity_hook.failed`
 * and the auth request proceeds, so a hook bug can never fail a sign-in.
 */

/** The subset of Better Auth's endpoint context the adapters read. */
interface HookRequestView {
  readonly headers?: { get(name: string): string | null } | undefined;
}

/** The seams the wiring passes through to the policy handlers. */
export interface IdentityHookWiring {
  /** The database the hooks read and write. */
  readonly db: IdentityHookDeps["db"];
  /** The outbox door; defaults to `emitDomainEvent` inside the handlers. */
  readonly emit?: EmitDomainEvent;
  /** The attendee-session claim seam; defaults to the no-op placeholder. */
  readonly claim?: ClaimAttendeeSession;
  /** The clock; defaults to the system clock inside the handlers. */
  readonly clock?: Clock;
}

/** Read a request header from the hook context, treating blank as absent. */
function headerOf(ctx: HookRequestView | null, name: string): string | null {
  const value = ctx?.headers?.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

/** Read one cookie value from the raw `cookie` header, or `null`. */
function cookieOf(ctx: HookRequestView | null, name: string): string | null {
  const header = ctx?.headers?.get("cookie");
  if (typeof header !== "string" || header === "") {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Resolve the client IP from the trusted-proxy headers, or `null`. */
function clientIpOf(ctx: HookRequestView | null): string | null {
  const forwarded = headerOf(ctx, "x-forwarded-for");
  if (forwarded !== null) {
    const [first] = forwarded.split(",");
    const value = first?.trim();
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return headerOf(ctx, "x-real-ip");
}

/** Run one adapter, logging (never re-throwing) a lifecycle failure. */
async function safeRun(kind: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    getLogger().error("identity hook failed", {
      event: "identity_hook.failed",
      hook: kind,
      err: error,
    });
  }
}

/** Project the wiring onto the handler deps, dropping absent seams. */
function toHookDeps(wiring: IdentityHookWiring): IdentityHookDeps {
  return {
    db: wiring.db,
    ...(wiring.emit === undefined ? {} : { emit: wiring.emit }),
    ...(wiring.claim === undefined ? {} : { claim: wiring.claim }),
    ...(wiring.clock === undefined ? {} : { clock: wiring.clock }),
  };
}

/**
 * The endpoint-facing seam the section 4-6 cards call after their own write
 * (ADR-0043 §3).
 *
 * Better Auth exposes no `after` hook that carries the transition for a contact
 * change, a 2FA toggle or a revoke-all, so those surfaces are injected: the
 * owning endpoint card calls the matching method once, after it has persisted
 * its own write. Each method delegates to the policy handler and is wrapped in
 * {@link safeRun}, so a hook failure can never fail the endpoint.
 */
export interface IdentityLifecycleSeams {
  contactChanged(event: ContactChangedEvent): Promise<void>;
  twoFactorToggled(event: TwoFactorToggledEvent): Promise<void>;
  sessionsRevoked(event: SessionsRevokedEvent): Promise<void>;
}

/**
 * Build the injectable section 4-6 surface seam.
 *
 * @param wiring - The database plus optional outbox/claim/clock seams.
 * @returns The three delegating methods the endpoint cards call.
 */
export function createIdentityLifecycleSeams(wiring: IdentityHookWiring): IdentityLifecycleSeams {
  const deps = toHookDeps(wiring);
  return {
    contactChanged: async (event) => {
      await safeRun("contact.changed", () => handleContactChanged(event, deps));
    },
    twoFactorToggled: async (event) => {
      await safeRun("2fa.toggled", () => handleTwoFactorToggled(event, deps));
    },
    sessionsRevoked: async (event) => {
      await safeRun("sessions.revoked", () => handleSessionsRevoked(event, deps));
    },
  };
}

/**
 * Build the Better Auth `databaseHooks` that run the identity lifecycle.
 *
 * @param wiring - The database plus optional outbox/claim/clock seams.
 * @returns The `databaseHooks` block to hand to `betterAuth()`.
 */
export function createIdentityDatabaseHooks(
  wiring: IdentityHookWiring
): NonNullable<BetterAuthOptions["databaseHooks"]> {
  const deps = toHookDeps(wiring);

  return {
    user: {
      create: {
        after: async (user, context) => {
          await safeRun("user.created", async () => {
            const userId = typeof user.id === "string" ? user.id : "";
            if (!ObjectId.isValid(userId)) {
              return;
            }
            await handleUserCreated(
              {
                userId,
                email: typeof user.email === "string" ? user.email : "",
                phoneNumber: typeof user.phoneNumber === "string" ? user.phoneNumber : null,
                acceptLanguage: headerOf(context, "accept-language"),
                timeZone: headerOf(context, "x-time-zone"),
              },
              deps
            );
          });
        },
      },
      update: {
        after: async (user) => {
          await safeRun("contact.verified", async () => {
            const userId = typeof user.id === "string" ? user.id : "";
            if (!ObjectId.isValid(userId)) {
              return;
            }
            await handleContactVerified({ userId }, deps);
          });
        },
      },
    },
    session: {
      create: {
        after: async (session, context) => {
          await safeRun("session.created", async () => {
            const userId = typeof session.userId === "string" ? session.userId : "";
            if (!ObjectId.isValid(userId)) {
              return;
            }
            await handleSessionCreated(
              {
                userId,
                sessionId: typeof session.id === "string" ? session.id : "",
                device: {
                  userAgent: headerOf(context, "user-agent"),
                  ip: clientIpOf(context),
                  acceptLanguage: headerOf(context, "accept-language"),
                },
                attendeeSessionToken: cookieOf(context, "op_att"),
              },
              deps
            );
          });
        },
      },
    },
  };
}
