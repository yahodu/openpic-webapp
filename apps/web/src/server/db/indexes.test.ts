import { describe, expect, it } from "vitest";

import { COLLECTIONS } from "./collections";
import { INDEX_SPECS, TENANT_SCOPED_COLLECTIONS, type IndexSpec } from "./indexes";

/**
 * Unit contract — `src/server/db/indexes.ts` (OP-76, schema §21).
 *
 * The module owns the declarative, single-source-of-truth description of every
 * index the database must carry. `INDEX_SPECS` is consumed both by the one-off
 * bootstrap (`ensureIndexes`) and by these lint specs, so a mistake in the
 * schema is caught here instead of only in production.
 *
 * Two invariants are asserted (card U1, U2):
 *
 *   U1 — every COMPOUND index on a TENANT-SCOPED collection leads with
 *        `tenantId`, except an explicitly documented, enumerated exception
 *        list. A missing `tenantId` lead is a cross-tenant data-leak vector
 *        (conventions §8: "Every tenant-scoped query filter includes
 *        `tenantId`") because such an index cannot serve a tenant-scoped query;
 *        the exception list below is the *complete* set of indexes that
 *        legitimately cannot lead with `tenantId`.
 *
 *   U2 — every TTL index expires documents on the `expireAt` field with
 *        `expireAfterSeconds: 0`, i.e. the moment the stored timestamp passes.
 *        A TTL index on any other field, or with any other expiry, silently
 *        turns into unbounded data growth (or premature deletion).
 *
 * The exceptions list is deliberately a literal owned by the TEST, not a value
 * the production module can hand back: adding an exception to the code without
 * adding it here fails the suite.
 */

/**
 * The ONLY compound indexes on tenant-scoped collections allowed to lead with a
 * field other than `tenantId`.
 *
 * `event_images { eventId, assetId }` — the uniqueness invariant is "one copy
 * of an asset per event". It is expressed over the pair, and `eventId` already
 * uniquely identifies the event across tenants, so the pair is globally
 * unambiguous and cannot be reordered to lead with `tenantId` without changing
 * what it enforces.
 */
const DOCUMENTED_TENANT_SCOPE_EXCEPTIONS: readonly string[] = ["event_images_event_asset_unique"];

const TENANT_ID = "tenantId";
const EXPIRE_AT = "expireAt";

/** The field an index leads with, or `undefined` for an empty key list. */
function leadingKey(spec: IndexSpec): string | undefined {
  return spec.keys[0]?.[0];
}

/** A compound index has more than one key. */
function isCompound(spec: IndexSpec): boolean {
  return spec.keys.length > 1;
}

/** A spec is tenant-scoped when its collection is. */
function isTenantScoped(spec: IndexSpec): boolean {
  return TENANT_SCOPED_COLLECTIONS.has(spec.collection);
}

/** A compound index on a tenant-scoped collection that does NOT lead with tenantId. */
function violatesTenantPrefix(spec: IndexSpec): boolean {
  return isCompound(spec) && isTenantScoped(spec) && leadingKey(spec) !== TENANT_ID;
}

/** A TTL index declares `expireAfterSeconds`. */
function isTtl(spec: IndexSpec): boolean {
  return spec.expireAfterSeconds !== undefined;
}

describe("index spec lint — U1 tenant-scope prefix", () => {
  it("starts every compound index on a tenant-scoped collection with tenantId", () => {
    const undocumented = INDEX_SPECS.filter(violatesTenantPrefix)
      .map((spec) => spec.name)
      .filter((name) => !DOCUMENTED_TENANT_SCOPE_EXCEPTIONS.includes(name));

    expect(
      undocumented,
      `compound indexes on tenant-scoped collections must lead with '${TENANT_ID}', ` +
        `or be added to DOCUMENTED_TENANT_SCOPE_EXCEPTIONS in indexes.test.ts`
    ).toEqual([]);
  });

  it("has exactly the enumerated exceptions — no silent additions, none missing", () => {
    const violating = INDEX_SPECS.filter(violatesTenantPrefix)
      .map((spec) => spec.name)
      .sort();

    expect(violating).toEqual([...DOCUMENTED_TENANT_SCOPE_EXCEPTIONS].sort());
  });

  it("only lists exceptions that are compound indexes on a tenant-scoped collection", () => {
    for (const name of DOCUMENTED_TENANT_SCOPE_EXCEPTIONS) {
      const spec = INDEX_SPECS.find((candidate) => candidate.name === name);
      expect(spec, `documented exception '${name}' is not declared in INDEX_SPECS`).toBeDefined();
      expect(spec && isCompound(spec)).toBe(true);
      expect(spec && isTenantScoped(spec)).toBe(true);
    }
  });

  it("actually declares at least one compound tenant-scoped index (the lint is not vacuous)", () => {
    expect(INDEX_SPECS.filter((spec) => isCompound(spec) && isTenantScoped(spec))).not.toEqual([]);
  });

  it("scopes every §21 invariant collection as tenant-scoped", () => {
    const tenantScoped: readonly string[] = [
      COLLECTIONS.events,
      COLLECTIONS.eventOrganizers,
      COLLECTIONS.subscriptions,
      COLLECTIONS.dispatches,
      COLLECTIONS.eventImages,
      COLLECTIONS.accessLinks,
    ];

    for (const collection of tenantScoped) {
      expect(
        TENANT_SCOPED_COLLECTIONS.has(collection),
        `expected '${collection}' to be tenant-scoped`
      ).toBe(true);
    }
  });
});

describe("index spec lint — U2 TTL indexes", () => {
  it("uses expireAfterSeconds: 0 on an expireAt key for every TTL index", () => {
    const ttlSpecs = INDEX_SPECS.filter(isTtl);

    for (const spec of ttlSpecs) {
      expect(spec.keys, `TTL index '${spec.name}' must key on ${EXPIRE_AT}`).toEqual([
        [EXPIRE_AT, 1],
      ]);
      expect(spec.expireAfterSeconds, `TTL index '${spec.name}' must expire immediately`).toBe(0);
    }
  });

  it("declares at least one TTL index (the lint is not vacuous)", () => {
    expect(INDEX_SPECS.some(isTtl)).toBe(true);
  });
});

describe("index spec lint — registry integrity", () => {
  it("names every index uniquely", () => {
    const names = INDEX_SPECS.map((spec) => spec.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(duplicates, "index names must be unique").toEqual([]);
  });

  it("declares an index backing every schema §21 uniqueness invariant", () => {
    const declared = new Set(INDEX_SPECS.map((spec) => spec.name));

    const required: readonly string[] = [
      "event_organizers_active_event_unique",
      "subscriptions_active_tenant_unique",
      "dispatches_tenant_dedupe_unique",
      "event_images_event_asset_unique",
      "access_links_active_slug_unique",
    ];

    for (const name of required) {
      expect(declared.has(name), `missing index declaration '${name}'`).toBe(true);
    }
  });
});

describe("index spec lint — plans catalogue uniqueness (OP-83 follow-up)", () => {
  // `plans` is platform-scope and (at RED time) is not yet a member of
  // `COLLECTIONS`; the literal is owned here so the spec fails loudly until the
  // registry declares the index, without the test depending on the production
  // registry's naming (the spec pins the invariant, not the index's name).
  const plansCollection = "plans" as string;

  it("declares a unique {key:1} index on the plans collection", () => {
    const hasPlanKeyIndex = INDEX_SPECS.some(
      (spec) =>
        spec.collection === plansCollection &&
        spec.unique === true &&
        spec.keys.length === 1 &&
        spec.keys.every(([field, direction]) => field === "key" && direction === 1)
    );

    expect(
      hasPlanKeyIndex,
      "plans must carry a unique {key:1} index so the database enforces one document per plan key (schema §14.1)"
    ).toBe(true);
  });
});

/**
 * OP-89 follow-up pins (ADR-0050) — the identity-lifecycle collections.
 *
 * These are **append-only** additions: the existing U1/U2 lints assert the
 * shape of *whatever* specs exist, so a regression that deletes one of these
 * declarations (or flips its options) fails nothing today. Each spec below
 * names a specific index the database must carry and asserts its exact shape,
 * so deleting it, renaming it, moving it to another collection, or changing
 * its keys/options turns this suite red.
 *
 * The invariants are the delivered contract of PR #162 / ADR-0043:
 *
 *   - `sessionDevices` supports the bounded new-device read and is TTL-bounded;
 *   - `contactChangeFanouts` (raw PII) is TTL-bounded (ADR-0040 §2);
 *   - `userProfiles.userId` is unique (ADR-0041 §4) and the DSR purge scan is
 *     backed by a partial `{status, deletionScheduledAt}` index (schema §13.2).
 */
describe("index spec pins — OP-89 identity lifecycle (ADR-0050)", () => {
  /** The declared spec with this exact name, or `undefined`. */
  function specNamed(name: string): IndexSpec | undefined {
    return INDEX_SPECS.find((candidate) => candidate.name === name);
  }

  it("declares the sessionDevices {userId:1, createdAt:-1} index backing the new-device read", () => {
    const spec = specNamed("session_devices_user_created");

    expect(spec, "missing index declaration 'session_devices_user_created'").toBeDefined();
    expect(spec?.collection).toBe(COLLECTIONS.sessionDevices);
    expect(spec?.keys).toEqual([
      ["userId", 1],
      ["createdAt", -1],
    ]);
  });

  it("bounds sessionDevices growth with a {expireAt:1} TTL that expires immediately", () => {
    const spec = specNamed("session_devices_expire_at_ttl");

    expect(spec, "missing index declaration 'session_devices_expire_at_ttl'").toBeDefined();
    expect(spec?.collection).toBe(COLLECTIONS.sessionDevices);
    expect(spec?.keys).toEqual([["expireAt", 1]]);
    expect(spec?.expireAfterSeconds).toBe(0);
  });

  it("TTL-bounds the raw-PII contactChangeFanouts collection", () => {
    const spec = specNamed("contact_change_fanouts_expire_at_ttl");

    expect(spec, "missing index declaration 'contact_change_fanouts_expire_at_ttl'").toBeDefined();
    expect(spec?.collection).toBe(COLLECTIONS.contactChangeFanouts);
    expect(spec?.keys).toEqual([["expireAt", 1]]);
    expect(spec?.expireAfterSeconds).toBe(0);
  });

  it("enforces one userProfiles row per user with a unique {userId:1} index", () => {
    const spec = specNamed("user_profiles_user_id_unique");

    expect(spec, "missing index declaration 'user_profiles_user_id_unique'").toBeDefined();
    expect(spec?.collection).toBe(COLLECTIONS.userProfiles);
    expect(spec?.keys).toEqual([["userId", 1]]);
    expect(spec?.unique).toBe(true);
  });

  it("backs the DSR purge scan with a partial {status:1, deletionScheduledAt:1} index", () => {
    const spec = specNamed("user_profiles_deletion_pending");

    expect(spec, "missing index declaration 'user_profiles_deletion_pending'").toBeDefined();
    expect(spec?.collection).toBe(COLLECTIONS.userProfiles);
    expect(spec?.keys).toEqual([
      ["status", 1],
      ["deletionScheduledAt", 1],
    ]);
    expect(spec?.partialFilterExpression).toEqual({ status: "deletion_pending" });
  });
});
