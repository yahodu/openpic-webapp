import { createAuthMiddleware } from "better-auth/api";

/**
 * Internal shared surface for the auth hook decomposition (OP-85 follow-up).
 *
 * `index.ts` used to hold the whole Better Auth configuration, including every
 * policy branch of one global `hooks.before` / `hooks.after`. The policy
 * branches now live in focused modules (`rate-limit-hook.ts`, `callback-url.ts`,
 * `phone-hook.ts`, `two-factor.ts`) and this file carries only what those
 * modules share: the hook-context type, the structural internal-adapter view,
 * the OTP constants and the request-body reader.
 */

/**
 * A hook that only exists so {@link AuthHookContext} can be derived from Better
 * Auth's own inference instead of reaching into its (unexported) middleware
 * generics. It is referenced solely in a `typeof` query, hence the `_` prefix.
 */
const _hookContextProbe = createAuthMiddleware(async (ctx) => {
  await Promise.resolve();
  return ctx;
});

/**
 * The exact context Better Auth hands a `before` / `after` hook.
 *
 * Capturing it by inference keeps every hook module aligned with the installed
 * library version without importing internal types that are not part of its
 * public API.
 */
export type AuthHookContext = Awaited<ReturnType<typeof _hookContextProbe>>;

/**
 * The `internalAdapter` surface the hooks use, kept structural so a hook module
 * depends only on the methods it actually calls.
 */
export interface InternalAdapterLike {
  updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
  consumeVerificationValue(identifier: string): Promise<{ value?: string | null } | null>;
  deleteSession(token: string): Promise<unknown>;
}

/** OTP length for every channel (email, SMS, two-factor). */
export const OTP_LENGTH = 6;

/** Lifetime of a one-time code, in milliseconds. */
export const OTP_TTL_MS = 5 * 60 * 1000;

/** Lifetime of a pending two-factor challenge (Better Auth's default), seconds. */
export const TWO_FACTOR_COOKIE_MAX_AGE_SECONDS = 600;

/**
 * Read a hook request body as a plain record.
 *
 * Better Auth types `ctx.body` as `any`; every policy branch treats a missing
 * or non-object body as an empty one rather than failing.
 *
 * @param ctx - The hook context.
 * @returns The body as a record, or an empty record.
 */
export function bodyOf(ctx: AuthHookContext): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null
    ? (ctx.body as Record<string, unknown>)
    : {};
}
