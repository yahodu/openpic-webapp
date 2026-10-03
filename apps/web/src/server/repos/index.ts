/**
 * Repository layer barrel (OP-77, schema §10.2).
 *
 * Everything that reaches a MongoDB collection from application code goes
 * through here: `tenantRepo` for tenant-scoped collections, `platformRepo` for
 * the deliberate platform-scope exceptions, and — the single whitelisted
 * cross-tenant read — `crossTenantReads`. Read paths project stored documents
 * with `toDto` so internal identifiers never escape.
 */

export { collectionHandle, TenantScopeViolation } from "./collection";
export type { RepositoryCollection, TenantScope } from "./collection";

export { tenantRepo } from "./tenant";
export type { TenantRepository } from "./tenant";

export { platformRepo } from "./platform";
export type { PlatformRepository } from "./platform";

export { toDto } from "./dto";
export type { Dto, WithId } from "./dto";

export { crossTenantReads } from "./cross-tenant";
export type {
  AttendeeProfileDto,
  AttendeeProfilePage,
  AttendeeProfileSubject,
  CrossTenantPage,
  CrossTenantReads,
} from "./cross-tenant";
