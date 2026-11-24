import { describe, expect, it } from "vitest";

import * as auditLog from "./audit-log";

/**
 * Unit contract — the **system** actor of the `auditLogs` seam (schema §20.2,
 * ADR-0970 §D2, ADR-0975 §D3/§D5, ADR-0976).
 *
 * The member lane ([ADR-0970](docs/adr/ADR-0970-op101-member-audit-logs-write.md)
 * §D2, ADR-0971) writes `user` actors: a principal id plus salted SHA-256 digests
 * of the request's address and agent. The billing lane's two rows are written by
 * **jobs**, which have no HTTP request to fingerprint, so ADR-0975 §D3 widens the
 * same module with `systemAuditActor(id)`:
 *
 * ```
 * systemAuditActor(id: string): { kind: "system", id, ipHash: null, uaHash: null }
 * ```
 *
 * Both fingerprint keys stay **present and null**, never absent. §9.9's reader
 * and the member pins (`AUDIT_ACTOR_KEYS` in `tenant-members.test.ts`) rely on
 * every row carrying the same four-key actor, and a system row with the keys
 * dropped would be indistinguishable from an unhashed user row — the ambiguity
 * this shape exists to prevent. So the key set is pinned here, not only the
 * values: `{ id, ipHash, kind, uaHash }`, exactly the four keys a member row
 * carries, with `kind: "system"` and both digests `null`.
 *
 * ## What is RED at this head, and what is a control
 *
 * `systemAuditActor` does not exist on the shipped module, so every case that
 * calls it is **RED by design** (the seam widening is the GREEN card's work):
 * the namespace access reports `auditLog.systemAuditActor is not a function`,
 * and `pnpm typecheck` reports `Property 'systemAuditActor' does not exist` —
 * a new-module RED this repo accepts (ADR-0976 §Evidence). The module is
 * imported as a namespace, not as a named binding, so the file still *loads*:
 * a named import of a missing export fails at link time and would red the whole
 * file for one symbol.
 *
 * The billing rows themselves are pinned end-to-end in
 * `src/test/integration/billing-crons.test.ts` (`A1`–`A6`): the row's `action`,
 * `target`, `before`/`after`, `reason` and its `at`/`expireAt` arithmetic are
 * observed there through `platformRepo(db).collection(COLLECTIONS.auditLogs)`.
 * These cases pin only the pure builder, where a drift reds with the numbers in
 * the message instead of inside an integration run.
 */
describe("systemAuditActor — the §20.2 actor a billing job transition writes", () => {
  /** The `actor` sub-document's four keys, the set every `auditLogs` row carries. */
  const AUDIT_ACTOR_KEYS = ["id", "ipHash", "kind", "uaHash"];

  it("returns kind system with the job id and both fingerprints present and null", () => {
    // Act
    const actor = auditLog.systemAuditActor("dunning");

    // Assert — `toEqual` with explicit `null`s: a dropped `ipHash`/`uaHash`
    // key is not equal to a `null` value, so absence reds here too.
    expect(actor).toEqual({
      kind: "system",
      id: "dunning",
      ipHash: null,
      uaHash: null,
    });
  });

  it("carries the caller's id verbatim, for the other downgrade job too", () => {
    // Act
    const actor = auditLog.systemAuditActor("scheduled-plan-changes");

    // Assert — a builder that hard-codes one job id reds on the other.
    expect(actor).toEqual({
      kind: "system",
      id: "scheduled-plan-changes",
      ipHash: null,
      uaHash: null,
    });
  });

  it("keeps the four-key actor set the member rows already pin", () => {
    // Act
    const actor = auditLog.systemAuditActor("dunning");

    // Assert — the member lane's `AUDIT_ACTOR_KEYS` (ADR-0971 `T1`/`T2`, still
    // green and untouched) names the same four keys, so the widening adds a
    // discriminator and no key.
    expect(Object.keys(actor).sort()).toEqual(AUDIT_ACTOR_KEYS);
    expect(actor).toHaveProperty("ipHash", null);
    expect(actor).toHaveProperty("uaHash", null);
  });
});
