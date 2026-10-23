# ADR-0280 — OP-101 RED: tenant members — masked contacts, owner protection and soft removal

- **Status:** Accepted
- **Date:** 2026-10-23
- **Card:** OP-101 RED (`t_a0aa3cb0`) · **GREEN successor:** `t_2e576e70` (gated on this card) · **Dependency:** OP-100 (`t_2d03b293`, merged as PR #256 / `5fd133d`)
- **Branch:** `OP-101-task-tenant-members` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_a0aa3cb0`
- **Spec sources:** API contract §2.2 (tenant members), §0.13 (data type conventions — "Masked contact"), §0.15 (never-return rules), §0.4 (tenancy in URLs); schema §13.4 (`tenantMembers`), §10.1–§10.2 (row-level `tenantId` isolation); contract Appendix A.5 (`cannot_demote_owner`, `409`)

## Context

The user story is _"as a tenant owner, I want to list, re-role and remove workspace
members so that workspace access is controlled"_. OP-100 landed the workspace, the
reusable `defineRoute` tenant stage and the tenant read/update routes; this card
pins the three member-management behaviours on top:

1. **List** — `GET /tenants/{t}/members` returns the §2.2 DTO with `displayName`
   and a §0.13 **masked** contact (`emailMasked`), never another user's raw
   address (§0.15).
2. **Re-role** — `PATCH /members/{userId}` with `{role: "admin"|"member"}`, owner
   only; the owner's own role cannot be changed (`409 cannot_demote_owner`).
3. **Remove** — `DELETE /members/{userId}` soft-removes (`status: "removed"`,
   `removedAt`) and returns `204`; the owner cannot be removed (`409`); a removed
   member loses access on their **next** request because the tenant stage re-reads
   `tenantMembers` per request.

The contract fixes the endpoint shapes and the masked-contact wire format but
leaves several details unstated. Those are resolved below as explicit decisions
so the GREEN card and the reviewer can accept or overturn each one with evidence,
rather than the GREEN having to guess.

## Decision

### D1 — the tests are the contract; module paths and exports are pinned

The RED imports exactly these production paths. A rename or a move breaks the
pins — deliberately, so the interface cannot drift silently.

| Path                                                           | Pinned export(s)                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@openpic/contracts` (new `packages/contracts/src/masking.ts`) | `maskEmail(address: string): string`, `maskPhone(e164: string): string`          |
| `@/app/api/v1/tenants/[tenantId]/members/route`                | `GET` (declared via `defineRoute`, `route: "/api/v1/tenants/:tenantId/members"`) |
| `@/app/api/v1/tenants/[tenantId]/members/[userId]/route`       | `PATCH`, `DELETE` (`route: "/api/v1/tenants/:tenantId/members/:userId"`)         |

The tests assert **behaviour** — HTTP status, response body, response headers,
and stored documents. No test imports the tenant stage, a projection helper or a
service module, so the GREEN may implement the handlers inline, behind a service,
or as a re-projection of the list DTO.

### D2 — masking is a fixed-width run, not a length-proportional one

§0.13 fixes the _shape_ (`prefix + •`) and gives one example per helper — `"r•••@gmail.com"`
and `"+91•••••3210"` — but never says whether the bullet run scales with the hidden
segment. The RED pins **fixed widths** (three bullets for email, five for phone)
because §0.15 is a _never-return_ rule: a length-proportional mask still discloses
how many characters were hidden, and for a one-character local part it degenerates
into no mask at all. The email helper therefore keeps the **first** local character
and the domain verbatim and replaces everything between them with exactly `•••`;
the phone helper keeps `+`, the two-digit country code and the last four digits and
replaces the digits between them with exactly `•••••`. Both results must satisfy the
existing `maskedContactSchema` (§0.13).

The tests assert this reading positively (`maskEmail("ra@gmail.com") === maskEmail("rahul@gmail.com")`,
`maskPhone` with the same bullet count for two different numbers) so a
length-proportional implementation fails loudly rather than silently.

Only the shapes §0.13 documents are pinned: a single `@` with a plain or dotted
domain for email, and Indian E.164 (`+91` + 10 digits — the repo's default
`dataRegion: "in"`) for phone. Other country codes and malformed inputs are
deliberately unpinned; the contract says nothing about them.

### D3 — the owner's protection is the catalogue's `cannot_demote_owner` for both verbs

`PATCH` on the owner's own id is `409 cannot_demote_owner`, exactly as §2.2 and
Appendix A.5 name it — and the test asserts that **no** role (`admin` or `member`)
may be set, because §2.2 says "cannot change the owner's own role".

§2.2 says only "`409`" for removing the owner and the catalogue carries no
`cannot_remove_owner`. The RED pins `409 cannot_demote_owner` for `DELETE` too:
demoting and removing the owner are the same protection, and `cannot_demote_owner`
is the only owner-protection code in Appendix A.5. If the orchestrator prefers a
distinct code, only that one assertion changes.

### D4 — a removed member's next request is denied by the existing tenant stage

The `404` after removal needs no new mechanism: `tenantStage` already filters
`tenantMembers` by `status: "active"` on every request, so the soft-removed row
stops matching. The RED proves the _effect_ (baseline `GET` `200` → `DELETE` `204`
→ next `GET` by alias **and** by explicit id `404 not_found`) and separately
asserts the row survives as history (`status: "removed"`, `removedAt` a `Date`,
`joinedAt` unchanged), so "removed" can never be implemented as a hard delete.

### D5 — the variants the contract leaves open, and the one implementation note

Resolved unilaterally and pinned (each is a one-line change if overturned):

| Question                             | Pinned behaviour                                                | Why                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH` success status/body          | `200` with the updated member (`userId`, `role`)                | §2.2 gives no status; §2.1's `PATCH` returns the updated DTO, so the pair is consistent. §2.2 states `204` explicitly for `DELETE`, so its silence for `PATCH` is meaningful.         |
| Target `{userId}` with no membership | `404 not_found` on both `PATCH` and `DELETE`                    | §2.2 names no status; `404` keeps the endpoint from confirming ids it does not hold (contract §0.4).                                                                                  |
| A role outside `admin`\|`member`     | `422 validation_failed`, stored role unchanged                  | §2.2 constrains the body to two values; `validation_failed` is the catalogue's body-shape code.                                                                                       |
| Removed rows in the listing          | **not pinned** (the spec asserts only the active rows it seeds) | §2.2's DTO has a `status` field whose other value is `removed`, but whether the screen shows history is a product decision. A GREEN that filters to `status: "active"` is not failed. |

One implementation requirement is deliberately left to the GREEN and recorded
here because it is invisible in the assertions: `tenantIdFromRequest` in
`@/server/tenancy/route-stage` returns the **last** path segment, which is the
tenant only for `/tenants/:tenantId`. On these nested routes the last segment is
`members` (or the target `{userId}`), so the stage must learn the tenant segment's
_position_. Without that, every request here answers `404` — the tests say so, but
they do not say why.

## Consequences

- The GREEN lane has an executable, complete interface for listing, re-roling and
  removing members, including the owner-only gate and the no-oracle `404`s, without
  reading this card's prose.
- `tsc` on this branch is red **by design**: two `TS2305` (the two missing
  `@openpic/contracts` exports) and two `TS2307` (the two missing route modules).
  Vitest reports the integration suite as a failed load (`cannot find package`) and
  all 14 unit assertions failing on `maskEmail is not a function`.
- A throwaway **stub probe** (three minimal stubs at the pinned paths, deleted
  before handoff) proves the red is behavioural, not structural: with the stubs,
  `tsc` exits `0` and **17/17** integration tests fail at assertion level — every
  one on `expected <status>, received 501` — showing the auth boot, the private
  database and the fixtures are sound.
- Two review questions are raised explicitly rather than buried: D3 (one code for
  demote _and_ remove) and D5 (the `PATCH` status and the target-miss `404`).

## Alternatives

- **One bullet per hidden character.** Rejected: it leaks the hidden length, which
  is exactly what §0.15 forbids, and a one-character local part would come back
  unmasked.
- **`204` for `PATCH`.** Rejected: §2.2 states `204` for `DELETE` and stays silent
  for `PATCH`; the sibling `PATCH /tenants/{t}` returns the updated DTO, and a
  client that just re-roled a member benefits from the new role on the wire.
- **Hard-delete the membership row.** Rejected: §13.4 defines `status`/`removedAt`
  as "soft removal preserves history", and the `{tenantId:1, userId:1}` unique
  index means a re-invite needs the row to still exist.
- **Re-implement tenant resolution inside the members routes.** Rejected: §0.4
  requires one uniform denial and ADR-0260 makes the stage reusable by every
  tenant route; duplicating resolution would fork the `404`-not-`403` rule.
- **Pin the re-invite path (a removed member added back to `active`).** Deferred:
  out of this story's scope (no endpoint accepts an invitation here) and nothing
  in §2.2 states it.
