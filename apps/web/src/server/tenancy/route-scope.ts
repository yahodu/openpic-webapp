import { ObjectId } from "mongodb";

import { getAuth } from "@/server/auth";
import { requireAuth } from "@/server/auth/guards";
import { getDb } from "@/server/db/mongo";
import type { HandlerContext } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";

import type { TenantRole } from "./permissions";

/**
 * Shared plumbing for the tenant-scoped routes (OP-101).
 *
 * Both the members listing and the member mutations run behind the same two
 * facts: the caller is an authenticated `user`, and the reusable `tenantStage`
 * has published the resolved workspace on the request context. These helpers
 * keep that boilerplate in one place so a handler reads as its own business
 * logic.
 */

/** The `user` auth stage, built per request so it reads validated config. */
export function userAuth(): ReturnType<typeof requireAuth> {
  return requireAuth("user", { auth: getAuth(), database: getDb() });
}

/** The resolved workspace scope, guaranteed by the tenant stage. */
export interface TenantScope {
  /** The resolved workspace id. */
  readonly tenantId: ObjectId;
  /** The caller's role in that workspace. */
  readonly role: TenantRole;
}

/**
 * Read the scope the tenant stage published, or fail loudly.
 *
 * The stage runs before every handler declared here, so a missing scope is a
 * programming error rather than a client-reachable state.
 *
 * @param ctx - The handler context.
 * @returns The resolved workspace id and the caller's role.
 */
export function requireTenantScope(ctx: HandlerContext): TenantScope {
  const { tenantId, tenantRole } = ctx;
  if (tenantId === undefined || tenantRole === undefined) {
    throw appError("internal_error");
  }
  return { tenantId: new ObjectId(tenantId), role: tenantRole };
}
