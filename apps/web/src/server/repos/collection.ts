import type { Collection, Db, Document } from "mongodb";

import { getLogger } from "../logging";
import { getRequestContext } from "../runtime/request-context";

/**
 * The tenant-scoped collection adapter (OP-77, schema §10.2).
 *
 * Every repository handle is built through {@link collectionHandle}, which
 * structurally injects the scope: a filter is merged with `tenantId`, an
 * aggregate pipeline is prefixed with a `tenantId` `$match`, inserts are
 * stamped and upserts set `tenantId` on insert. The scope is captured in the
 * closure, so a call site cannot forget it — there is no code path that reaches
 * the driver without it.
 *
 * A caller that explicitly supplies a *different* `tenantId` is a programming
 * error and is refused loudly (a {@link TenantScopeViolation}) rather than
 * silently overridden. The refusal is logged once at `error` with the
 * collection name and nothing tenant-identifying (conventions §5.3).
 */

/** The result of a rejected cross-scope operation. */
export class TenantScopeViolation extends Error {
  /**
   * @param collection - The collection the out-of-scope operation targeted.
   */
  constructor(collection: string) {
    super(
      `tenant scope violation on collection "${collection}": the supplied tenantId does not match the repository scope`
    );
    this.name = "TenantScopeViolation";
  }
}

/** The tenant a repository is bound to. */
export interface TenantScope {
  readonly tenantId: string;
}

/**
 * The subset of the MongoDB `Collection` API a repository handle exposes.
 *
 * Return types are the driver's own, so callers keep full type information
 * (cursors, `UpdateResult`, `InsertOneResult`) while the arguments pass through
 * the scope transform.
 */
export interface RepositoryCollection {
  find(filter?: Document, options?: Document): ReturnType<Collection["find"]>;
  findOne(filter?: Document, options?: Document): ReturnType<Collection["findOne"]>;
  findOneAndUpdate(
    filter: Document,
    update: Document | Document[],
    options?: Document
  ): ReturnType<Collection["findOneAndUpdate"]>;
  updateOne(
    filter: Document,
    update: Document | Document[],
    options?: Document
  ): ReturnType<Collection["updateOne"]>;
  updateMany(
    filter: Document,
    update: Document | Document[],
    options?: Document
  ): ReturnType<Collection["updateMany"]>;
  deleteOne(filter?: Document, options?: Document): ReturnType<Collection["deleteOne"]>;
  deleteMany(filter?: Document, options?: Document): ReturnType<Collection["deleteMany"]>;
  insertOne(doc: Document, options?: Document): ReturnType<Collection["insertOne"]>;
  insertMany(docs: Document[], options?: Document): ReturnType<Collection["insertMany"]>;
  countDocuments(filter?: Document, options?: Document): ReturnType<Collection["countDocuments"]>;
  aggregate(pipeline: Document[], options?: Document): ReturnType<Collection["aggregate"]>;
}

/** True for a plain document (the shapes we merge into / stamp). */
function isRecord(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an optional value into a document, so spreads are always safe. */
function asDocument(value: unknown): Document {
  return isRecord(value) ? value : {};
}

/** Emit the security log line for a refused cross-scope operation. */
function reportScopeViolation(collection: string): void {
  const context = getRequestContext();
  getLogger().error("tenant scope violation", {
    event: "tenancy.scope_violation",
    collection,
    ...(context === undefined ? {} : { requestId: context.requestId }),
  });
}

/**
 * Log and refuse an operation that would escape (or strip) the tenant scope.
 *
 * @param collection - The collection name (log-safe).
 * @throws TenantScopeViolation always.
 */
function refuseScope(collection: string): never {
  reportScopeViolation(collection);
  throw new TenantScopeViolation(collection);
}

/**
 * Refuse an operation whose supplied `tenantId` differs from the scope.
 *
 * @param tenantId - The scope the repository is bound to.
 * @param collection - The collection name (log-safe).
 * @param supplied - The `tenantId` the caller supplied, if any.
 * @throws TenantScopeViolation when a different tenant is supplied.
 */
function assertTenant(tenantId: string, collection: string, supplied: unknown): void {
  if (supplied !== undefined && supplied !== tenantId) {
    refuseScope(collection);
  }
}

/** A filter is refused when it names a foreign tenant, then stamped with the scope. */
function scopeFilter(
  scope: TenantScope | undefined,
  collection: string,
  filter: unknown
): Document {
  const base = asDocument(filter);
  if (scope === undefined) {
    return base;
  }
  assertTenant(scope.tenantId, collection, base.tenantId);
  return { ...base, tenantId: scope.tenantId };
}

/** True when an `$unset` operand names the tenant field (string, array or document form). */
function unsetNamesTenant(value: unknown): boolean {
  if (typeof value === "string") {
    return value === "tenantId";
  }
  if (Array.isArray(value)) {
    return value.includes("tenantId");
  }
  if (isRecord(value)) {
    return Object.prototype.hasOwnProperty.call(value, "tenantId");
  }
  return false;
}

/**
 * True when an `$rename` operand touches the tenant field: `tenantId` is the
 * source key (the field is moved away) or any destination value (the scope is
 * overwritten with another field's value).
 */
function renameTouchesTenant(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(value, "tenantId") ||
    Object.values(value).some((destination) => destination === "tenantId")
  );
}

/**
 * An update document must not move a row into (or create it in) another tenant,
 * strip the tenant field, or overwrite it with another field's value.
 *
 * `$set`/`$setOnInsert` are inspected for a foreign `tenantId`; operators that
 * can remove or rename the tenant field (`$unset` naming `tenantId`, `$rename`
 * naming it as source or destination) are refused outright, before the driver
 * is reached.
 */
function assertUpdateScope(
  tenantId: string | undefined,
  collection: string,
  update: unknown
): Document | Document[] {
  if (tenantId === undefined) {
    return Array.isArray(update) ? (update as Document[]) : asDocument(update);
  }
  if (Array.isArray(update)) {
    assertPipelineScope(tenantId, collection, update);
    return update as Document[];
  }
  const base = asDocument(update);
  const set: unknown = base.$set;
  if (isRecord(set)) {
    assertTenant(tenantId, collection, set.tenantId);
  }
  const setOnInsert: unknown = base.$setOnInsert;
  if (isRecord(setOnInsert)) {
    assertTenant(tenantId, collection, setOnInsert.tenantId);
  }
  if (unsetNamesTenant(base.$unset)) {
    refuseScope(collection);
  }
  if (renameTouchesTenant(base.$rename)) {
    refuseScope(collection);
  }
  return base;
}

/**
 * An update *pipeline* (`Document[]`) must not move a row into another tenant in
 * any stage, strip the tenant field, or replace the whole document, and must
 * reach the driver unchanged (array and order preserved).
 *
 * `$set` and its alias `$addFields` are inspected on every stage for a foreign
 * `tenantId`. Operators that can remove or overwrite the tenant field
 * (`$unset` naming `tenantId`, `$replaceWith`, `$replaceRoot`) are refused
 * outright. `$project` (an alias namespace of `$unset` in the update pipeline)
 * is deliberately not covered here (out of scope — no spec pins it).
 */
function assertPipelineScope(tenantId: string, collection: string, pipeline: unknown[]): void {
  for (const stage of pipeline) {
    if (!isRecord(stage)) {
      continue;
    }
    const set: unknown = stage.$set;
    if (isRecord(set)) {
      assertTenant(tenantId, collection, set.tenantId);
    }
    const addFields: unknown = stage.$addFields;
    if (isRecord(addFields)) {
      assertTenant(tenantId, collection, addFields.tenantId);
    }
    if (unsetNamesTenant(stage.$unset)) {
      refuseScope(collection);
    }
    if (
      Object.prototype.hasOwnProperty.call(stage, "$replaceWith") ||
      Object.prototype.hasOwnProperty.call(stage, "$replaceRoot")
    ) {
      refuseScope(collection);
    }
  }
}

/**
 * Scope a write: merge `tenantId` into its filter and refuse a foreign tenant in
 * either the filter or the update document. The three update methods share this
 * two-step transform, so it lives here once.
 *
 * @param scope - The tenant scope, or undefined for a platform-scope handle.
 * @param collection - The collection name (log-safe).
 * @param filter - The caller's filter.
 * @param update - The caller's update document.
 * @returns The scoped filter and the validated update document.
 */
function scopeWrite(
  scope: TenantScope | undefined,
  collection: string,
  filter: unknown,
  update: unknown
): { filter: Document; update: Document | Document[] } {
  return {
    filter: scopeFilter(scope, collection, filter),
    update: assertUpdateScope(scope?.tenantId, collection, update),
  };
}

/** Stamp `tenantId` onto an upsert's `$setOnInsert` so a new row is born scoped. */
function stampUpsert(
  scope: TenantScope | undefined,
  update: Document | Document[],
  options: unknown
): Document | Document[] {
  if (
    scope === undefined ||
    Array.isArray(update) ||
    !isRecord(options) ||
    options.upsert !== true
  ) {
    return update;
  }
  const setOnInsert = isRecord(update.$setOnInsert) ? update.$setOnInsert : {};
  return { ...update, $setOnInsert: { ...setOnInsert, tenantId: scope.tenantId } };
}

/** Stamp `tenantId` onto a document about to be inserted. */
function stampInsert(scope: TenantScope | undefined, collection: string, doc: unknown): Document {
  const base = asDocument(doc);
  if (scope === undefined) {
    return base;
  }
  assertTenant(scope.tenantId, collection, base.tenantId);
  return { ...base, tenantId: scope.tenantId };
}

/** Prefix an aggregate pipeline with the scope `$match`. */
function scopePipeline(scope: TenantScope | undefined, pipeline: unknown): Document[] {
  const stages = Array.isArray(pipeline) ? (pipeline as Document[]) : [];
  if (scope === undefined) {
    return stages;
  }
  return [{ $match: { tenantId: scope.tenantId } }, ...stages];
}

/**
 * Build the scope-injecting handle for one collection.
 *
 * @param db - The database handle the driver work runs against.
 * @param name - The collection name.
 * @param scope - The tenant scope to enforce, or omitted for a platform-scope
 *   collection (no `tenantId` is injected).
 * @returns The collection handle.
 */
export function collectionHandle(db: Db, name: string, scope?: TenantScope): RepositoryCollection {
  const collection = db.collection(name);

  return {
    find(filter, options) {
      return collection.find(scopeFilter(scope, name, filter), options);
    },
    async findOne(filter, options) {
      return collection.findOne(scopeFilter(scope, name, filter), options);
    },
    async findOneAndUpdate(filter, update, options) {
      const scoped = scopeWrite(scope, name, filter, update);
      return collection.findOneAndUpdate(
        scoped.filter,
        stampUpsert(scope, scoped.update, options),
        options ?? {}
      );
    },
    async updateOne(filter, update, options) {
      const scoped = scopeWrite(scope, name, filter, update);
      return collection.updateOne(
        scoped.filter,
        stampUpsert(scope, scoped.update, options),
        options ?? {}
      );
    },
    async updateMany(filter, update, options) {
      const scoped = scopeWrite(scope, name, filter, update);
      return collection.updateMany(
        scoped.filter,
        stampUpsert(scope, scoped.update, options),
        options
      );
    },
    async deleteOne(filter, options) {
      return collection.deleteOne(scopeFilter(scope, name, filter), options);
    },
    async deleteMany(filter, options) {
      return collection.deleteMany(scopeFilter(scope, name, filter), options);
    },
    async insertOne(doc, options) {
      return collection.insertOne(stampInsert(scope, name, doc), options);
    },
    async insertMany(docs, options) {
      const list = Array.isArray(docs) ? docs : [];
      return collection.insertMany(
        list.map((doc) => stampInsert(scope, name, doc)),
        options
      );
    },
    async countDocuments(filter, options) {
      return collection.countDocuments(scopeFilter(scope, name, filter), options);
    },
    aggregate(pipeline, options) {
      return collection.aggregate(scopePipeline(scope, pipeline), options);
    },
  };
}
