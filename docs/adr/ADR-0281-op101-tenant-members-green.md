# ADR-0281 — OP-101 GREEN: tenant members — masking helpers, owner protection and soft removal

- **Status:** Accepted
- **Date:** 2026-10-23
- **Card:** OP-101 GREEN (`t_2e576e70`) · **RED predecessor:** `t_a0aa3cb0` ([ADR-0280](ADR-0280-op101-tenant-members-red.md)) · **Dependency:** OP-100 (`t_2d03b293`, merged as PR #256 / `5fd133d`)
- **Branch:** `wt/t_2e576e70` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_2e576e70`
- **Spec sources:** ADR-0280 (the executable contract); API contract §2.2 (tenant members), §0.13 (masked contact), §0.15 (never-return), §0.4 (tenancy in URLs); schema §13.3/§13.4; contract Appendix A.5 (`cannot_demote_owner`, `409`)

## Context

ADR-0280 pinned the RED contract for `GET`/`PATCH`/`DELETE /tenants/{t}/members`:
14 unit pins on the two new `@openpic/contracts` masking helpers and 17
integration pins on the member listing, the owner-only re-role/remove gate, the
owner protection, the no-oracle `404`s and the "removal takes effect on the next
request" rule. This card writes the minimum production code that turns those
pins green. No test was edited, added or weakened.

## Decision

### D1 — the implementation is exactly what ADR-0280 pinned

| Path                                                                   | What it adds                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/masking.ts`                                    | `maskEmail(address)` / `maskPhone(e164)` — fixed-width runs (3 bullets / 5 bullets) per ADR-0280 D2            |
| `packages/contracts/src/errors.ts`                                     | `cannot_demote_owner` appended to the closed `TENANCY_ERROR_CODES` set (append-only, ADR-0261 precedent)       |
| `apps/web/src/server/http/catalog.ts`                                  | the `cannot_demote_owner` transport row (`409`, non-retryable) in `TENANCY_ERROR_TRANSPORT`                    |
| `apps/web/src/server/tenancy/route-stage.ts`                           | `tenantIdFromRequest` now locates the tenant segment **by position** (the segment after the literal `tenants`) |
| `apps/web/src/server/tenancy/member-schema.ts`                         | the §2.2 member DTO, the `{ data: Member[] }` list envelope and the `{ userId, role }` mutation result         |
| `apps/web/src/server/tenancy/members.ts`                               | the three-collection read model (`tenantMembers` + `user` + `userProfiles`) and the masking projection         |
| `apps/web/src/server/tenancy/route-scope.ts`                           | the shared `userAuth()` / `requireTenantScope()` plumbing for the two member routes                            |
| `apps/web/src/app/api/v1/tenants/[tenantId]/members/route.ts`          | `GET` — the member listing                                                                                     |
| `apps/web/src/app/api/v1/tenants/[tenantId]/members/[userId]/route.ts` | `PATCH` (re-role) and `DELETE` (soft removal)                                                                  |

### D2 — the tenant segment is located by position, not by "last segment"

ADR-0280 recorded the implementation note: `tenantIdFromRequest` returned the
**last** path segment, which is the tenant only for `/tenants/:tenantId`. On
`/tenants/{t}/members` the last segment is `members`, so every nested request
would answer `404`. The fix anchors on the literal `tenants` segment and returns
the one that follows it — the same value for the OP-100 route, the correct one
for the nested routes — with a fallback to the last segment when no `tenants`
anchor exists. This is behaviour-preserving for every OP-100 route (the full
integration suite is green: 66 files, 479 tests).

### D3 — `tenantMembers`, `user` and `userProfiles` are read through `platformRepo`

`tenantMembers` is a **subject-scoped** join collection (one row per tenant ×
user, schema §13.4; ADR-0060) and the Better Auth `user` / `userProfiles`
collections are platform-scoped, so none is a `TENANT_SCOPED_COLLECTIONS`
member. They are read through `platformRepo(db)`, which is the sanctioned path
for exactly this case and is what the OP-100 tenant stage and route already do.
The listing is three round trips (one `find` for the rows, two `$in` reads for
the users and profiles), independent of the member count.

### D4 — the contract decisions ADR-0280 left to the GREEN are implemented as pinned

- the listing carries **every** membership row, removed ones included, because
  §2.2's DTO has a `status` field whose other value is `removed` (ADR-0280 A5;
  deliberately unpinned by the RED);
- `PATCH` answers `200` with the updated member `{ userId, role }` (A2);
- removing the owner reuses `409 cannot_demote_owner` (A3);
- a target with no membership is `404 not_found` on both verbs (A4);
- the caller's owner-only gate is checked **before** the target lookup, so a
  non-owner is `403 forbidden` without learning whether the target exists;
- audit-worthy changes are logged at `info`: `member.role_changed` and
  `member.removed` (§security_and_logging_requirements).

### D5 — one RED assertion is unsatisfiable as written and is left red (dispute)

`packages/contracts/src/masking.test.ts` (the `it.each` titled "U1: returns a
§0.13 masked contact that never carries the original address") asserts, for the
input `ra@gmail.com`, that the mask does not contain the local secret:

```ts
const localSecret = address.slice(0, address.indexOf("@")).slice(1); // "a"
if (localSecret !== "") {
  expect(masked).not.toContain(localSecret);
}
```

The same file **pins the output** for that exact input one test above —
`maskEmail("ra@gmail.com") === "r•••@gmail.com"` — and pins the domain verbatim
(`"r•••@gmail.com"` contains `gmail`, which contains `a`). No function can
satisfy both: the mask that the file's own `toBe` assertions require for
`ra@gmail.com` necessarily contains the single-character local secret `"a"`.
The other three inputs in the `it.each` (`r@gmail.com` → empty secret,
`rahul@gmail.com` → `"ahul"`, `rahul.menon@example.co.uk` → `"ahul.menon"`) pass,
because their secrets are longer than the one character that the preserved
domain happens to share.

The defect is the missing length guard on a one-character local secret — the
assertion is meaningful only when the secret is longer than a single character.
The proposed correction (for the Test Author, not made here) is to guard with
`if (localSecret.length > 1)` or to drop `ra@gmail.com` from that `it.each`
list. This card does **not** touch the test: the pin is left red and reported.

## Consequences

- 13/14 unit pins and **17/17** integration pins pass; the one red is the
  dispute in D5.
- `tsc` (all three projects) is clean; `eslint` reports 0 errors on every
  touched file (two pre-existing `security/detect-object-injection` warnings on
  the untouched object-index lines remain); `prettier --check` is clean on the
  touched files.
- The route-stage fix is the only change to shared code; the full integration
  suite (66 files, 479 tests) is green, so no OP-100 or OP-90/OP-97 route
  regressed.
- `cannot_demote_owner` is the first new tenancy error code since OP-100; it is
  append-only in `TENANCY_ERROR_CODES`, so the existing codes keep their
  positions and the client-facing enum stays a closed set.

## Alternatives

- **Filter the listing to `status: "active"`.** Rejected for now: §2.2's DTO
  carries a `status` field, ADR-0280 A5 records that showing history is a
  product decision, and no pin requires either behaviour. All rows are returned
  with their status, which is the reading that uses the field.
- **Use `tenantRepo(tenantId)` for `tenantMembers`.** Rejected: the repository
  scope is a **string** `tenantId` and stamps it verbatim into every filter,
  while the stored `tenantId` (and the one the OP-100 stage resolves) is an
  `ObjectId`; the string-stamped filter would match nothing. `platformRepo` is
  the correct scope for a subject-scoped collection.
- **Re-implement tenant resolution inside the member routes.** Rejected by
  ADR-0280: §0.4 requires one uniform denial, and the reusable stage already
  provides it.
