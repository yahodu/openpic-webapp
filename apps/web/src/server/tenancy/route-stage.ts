import { ObjectId, type Db } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import type { RouteStage } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { requestLogger } from "@/server/logging";
import { platformRepo } from "@/server/repos";

import { asTenantRole } from "./permissions";
import { ensureTenantForUser } from "./provisioning";

/**
 * The reusable `defineRoute` tenant stage (OP-100, contract §0.4 + §2.1).
 *
 * Every organizer-side resource lives under `/tenants/{tenantId}/…` and the
 * segment accepts two things: the literal alias **`current`** and a workspace id.
 * The stage takes over both, once, so no handler ever has to:
 *
 *   1. resolve `current` → `userProfiles.primaryTenantId` (never by querying
 *      `tenants` with the string `current`);
 *   2. verify the caller holds an **active** `tenantMembers` row for the
 *      resolved workspace;
 *   3. echo the resolved id in `X-Tenant-Id`, so a client (and the logs) can see
 *      which workspace the request actually hit;
 *   4. publish `ctx.tenantId`/`ctx.tenantRole` for the handler.
 *
 * A denial is always `404 not_found`, never `403` (contract §0.4): a non-member
 * must not be able to tell an existing foreign workspace from an unknown id, or
 * the endpoint becomes a cross-tenant existence oracle. The denial is logged
 * `warn` as `tenancy.access_denied` (low volume), the successful resolution
 * `debug` as `tenancy.resolved`.
 *
 * Nested routes that grant access through event membership rather than
 * `tenantMembers` (contract §0.4, §4.3) do not reimplement resolution: they
 * extend this stage with an {@link TenantAdmission} seam, so the alias, the
 * header and the single denial log stay here (ADR-0260, ADR-0644).
 */

/** The literal alias the tenant stage resolves (contract §0.4). */
export const CURRENT_TENANT_ALIAS = "current";

/** The response header carrying the resolved workspace id (contract §0.4). */
export const TENANT_ID_HEADER = "X-Tenant-Id";

/** A 24-hex ObjectId, the only accepted explicit `{tenantId}` shape. */
const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** The facts an {@link TenantAdmission} seam receives from the stage. */
export interface TenantAdmissionContext {
  /** The database the stage resolved against. */
  readonly db: Db;
  /** The inbound request, so the seam can read the route's own path segments. */
  readonly request: Request;
  /** The workspace the stage already resolved (`current` or an explicit id). */
  readonly tenantId: ObjectId;
  /** The authenticated principal, as the hex string the stage read. */
  readonly userId: string;
  /** Deny with the uniform, logged `404 not_found`. Never returns. */
  readonly deny: (reason: string) => never;
}

/**
 * A route-specific admission seam (contract §0.4, ADR-0644).
 *
 * A nested route whose contract grants access through something other than
 * `tenantMembers` — the event member list admits a co-organizer holding no
 * workspace row (§4.3) — supplies this seam instead of reimplementing tenancy
 * resolution. Aliasing inside the stage is unaffected: `current` is resolved,
 * the resolved id is echoed in `X-Tenant-Id`, and every denial is the one
 * logged `404`. The seam owns only its own admission predicate; it returns when
 * the caller is admitted and denies through the supplied `deny` otherwise.
 */
export type TenantAdmission = (context: TenantAdmissionContext) => Promise<void>;

/** Options accepted by {@link tenantStage}. */
export interface TenantStageOptions {
  /**
   * Set on a tenant-scoped **write** so the first write by a caller with no
   * workspace provisions one (caller = `owner`) before the write applies
   * (ADR-0260 D3). A read must never set it — reading must not create a
   * billable workspace (I4).
   */
  readonly provisionOnMissing?: boolean;
  /** The database to resolve against; defaults to the process database. */
  readonly db?: Db;
  /**
   * Replace the `tenantMembers` check with a route-specific admission seam
   * (ADR-0644). When set, the stage still resolves the workspace and echoes it,
   * but the caller is admitted by the seam rather than by workspace membership;
   * `ctx.tenantRole` is left unset because the admission is not a workspace
   * role.
   */
  readonly admission?: TenantAdmission;
}

/** The `userProfiles` field alias resolution reads (schema §13.2). */
interface ProfileDocument {
  readonly primaryTenantId?: unknown;
}

/** The `tenantMembers` field the membership check reads (schema §13.4). */
interface TenantMembershipDocument {
  readonly role?: unknown;
}

/**
 * The `{tenantId}` segment of the matched path, or `""`.
 *
 * The tenant segment is located **by position** — the segment immediately
 * following the literal `tenants` — rather than by taking the last segment: on a
 * nested route such as `/tenants/{tenantId}/members` (or `…/members/{userId}`)
 * the last segment is `members` (or the target user id), not the workspace.
 * Taking the last segment there would make every nested request answer `404`.
 * A path with no `tenants` anchor yields `""`, which fails the id-shape check
 * below and denies with the same `404`.
 */
export function tenantIdFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments[segments.indexOf("tenants") + 1] ?? "";
}

/**
 * Build the tenant-resolution stage.
 *
 * @param options - The provisioning policy and the database seam.
 * @returns A `defineRoute` stage that resolves, authorises and echoes the
 *   workspace, then publishes it on the request context.
 */
export function tenantStage(options: TenantStageOptions = {}): RouteStage {
  return async (ctx, request) => {
    const db = options.db ?? getDb();
    const logger = requestLogger(request, { route: ctx.route });
    // The auth stage runs before this one and always publishes the principal.
    const userId = ctx.principal;
    if (userId === undefined) {
      throw appError("authentication_required");
    }

    /**
     * Deny with the uniform non-oracle `404`, logging why at warn level.
     *
     * The variable carries an explicit `never` return annotation (not just the
     * arrow's) so TypeScript's control-flow analysis treats a call as
     * terminating and the checks below narrow `primary`.
     */
    const deny: (reason: string) => never = (reason) => {
      logger.warn("tenant access denied", { event: "tenancy.access_denied", reason });
      throw appError("not_found");
    };

    const segment = tenantIdFromRequest(request);

    const userObjectId = new ObjectId(userId);
    let tenantId: ObjectId;

    const repo = platformRepo(db);

    if (segment === CURRENT_TENANT_ALIAS) {
      const profile = (await repo
        .collection(COLLECTIONS.userProfiles)
        .findOne({ userId: userObjectId })) as ProfileDocument | null;
      let primary = profile?.primaryTenantId instanceof ObjectId ? profile.primaryTenantId : null;

      // The alias never provisions on a read; the first tenant-scoped write
      // does, and then the write applies to the workspace it just created.
      if (primary === null && options.provisionOnMissing === true) {
        const provisioned = await ensureTenantForUser(userObjectId, { db });
        primary = provisioned.tenantId;
      }

      if (primary === null) {
        deny("unresolved_alias");
      }
      tenantId = primary;
    } else {
      if (!OBJECT_ID_HEX.test(segment)) {
        deny("malformed_tenant_id");
      }
      tenantId = new ObjectId(segment);
    }

    const resolved = tenantId.toHexString();

    if (options.admission !== undefined) {
      // The route's own relationship decides; no workspace role is published,
      // because an event actor commonly holds no `tenantMembers` row (§4.3).
      await options.admission({ db, request, tenantId, userId, deny });
      Object.assign(ctx, { tenantId: resolved });
    } else {
      const membership = (await repo.collection(COLLECTIONS.tenantMembers).findOne({
        tenantId,
        userId: userObjectId,
        status: "active",
      })) as TenantMembershipDocument | null;
      if (membership === null) {
        deny("not_a_member");
      }
      Object.assign(ctx, { tenantId: resolved, tenantRole: asTenantRole(membership.role) });
    }

    logger.debug("tenant resolved", { event: "tenancy.resolved", tenantId: resolved });

    return { [TENANT_ID_HEADER]: resolved };
  };
}

/**
 * The reusable tenant stage plus the §3.3 owner-only gate (OP-109, ADR-0460 §6).
 *
 * Every billing **mutation** is owner-only: an `admin` is a member but is not
 * authorised to spend the workspace's money. The check is folded into the
 * `tenant` slot rather than the handler because §0.9's idempotency stage runs
 * *before* the handler, so a handler-level check would answer
 * `400 idempotency_key_required` where §3.3 requires `403 forbidden`.
 *
 * @param options - The provisioning policy and the database seam.
 * @returns A stage that resolves the workspace and refuses a non-member
 *   (`404 not_found`) or a non-owner (`403 forbidden`).
 */
export function ownerOnlyTenant(options: TenantStageOptions = {}): RouteStage {
  const resolveTenant = tenantStage(options);
  return async (ctx, request) => {
    const headers = await resolveTenant(ctx, request);
    if (ctx.tenantRole !== "owner") {
      throw appError("forbidden");
    }
    return headers;
  };
}
