# ADR-0282 — OP-101 follow-up pins: the absent-row / malformed-id member paths

- **Status:** Accepted
- **Date:** 2026-10-24
- **Card:** OP-101 follow-up TEST (`t_2d85f947`) · **Predecessor:** OP-101 GREEN (`t_2e576e70`, [ADR-0281](ADR-0281-op101-tenant-members-green.md)) · **Gated GREEN:** `t_082fa536`
- **Branch:** `OP-101-task-tenant-members-pins` · **Workspace:** `/root/openpic/openpic-webapp/.worktrees/t_2e576e70`
- **Spec sources:** API contract §2.2 (tenant members), §0.4 (tenancy in URLs), §0.13 (masked contact), §0.15 (never-return); schema §13.1/§13.2/§13.4; [ADR-0281](ADR-0281-op101-tenant-members-green.md) §D6 (the dropped branches)

## Context

The OP-101 GREEN held the repo's **global** 80% branch gate (`vitest.config.ts`)
by deleting the defensive branches that guard **absent or corrupt** member data
(ADR-0281 §D6) — a missing `user`/`userProfiles` row, a non-`Date` `joinedAt`,
a malformed id, a path with no tenant segment. It landed at **80.02% branches
(2440/3049)** — a one-branch margin — and documented the reduction.

The RED spec (ADR-0280) pinned the happy paths, the owner-only gate, the owner
protection and the denial paths, but never the absent/corrupt-data paths. This
card adds the pins so the robustness can be restored without dropping the gate.
No production code is touched: the pins are the only diff.

## Decision

### D1 — the pins, and which of them are RED

Extension of `apps/web/src/test/integration/tenant-members.test.ts` (the
ADR-0280 spec file; the file's `I1`–`I3` pins are byte-unchanged). New pins:

| Behaviour pinned                                                                                 | Spec                                                                              | State against the current trunk         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------- |
| No `user` row → the row is still listed, contact fully masked (`•••`)                            | “still lists a member whose `user` document has gone missing…”                    | **RED**                                 |
| No `userProfiles` row → the row is still listed with `displayName: ""`                           | “still lists a member whose `userProfiles` document is missing…”                  | **RED**                                 |
| `joinedAt` absent / unparseable → the listing still answers `200`, the row degrades to the epoch | “does not fail the whole listing when one membership's `joinedAt` is %s”          | **RED** (`expected 500 to be 200`)      |
| `joinedAt` stored as an ISO string → normalised to the same instant                              | “normalises a `joinedAt` stored as an ISO-8601 string…”                           | green (characterisation)                |
| Ordering: `joinedAt` ascending, ties broken by ascending `userId`                                | “orders members by join time ascending” / “breaks ties in `joinedAt` by user id…” | time-ascending green, **tie-break RED** |
| Malformed `{userId}` on `PATCH`/`DELETE` → `404 not_found` (never `500`, never `403`)            | `members/{userId} — malformed target id`                                          | green (characterisation)                |
| A path with no usable tenant segment → the tenant stage's uniform `404`                          | `paths with no usable tenant segment`                                             | green (characterisation)                |
| `PATCH` success emits `member.role_changed` (`tenantId`, `userId`, `role`)                       | `member mutations — audit logging`                                                | green (characterisation)                |
| `DELETE` success emits `member.removed` (`tenantId`, `userId`)                                   | idem                                                                              | green (characterisation)                |
| A **refused** mutation (`409`, `422`, `403`) emits neither audit event                           | idem                                                                              | green (characterisation)                |

The card's acceptance note ("new pins are RED … for the absent-row/malformed-id
cases") is only **partly** accurate. Four of the behaviour groups are green at
the trunk. The reason is in the D6 diff itself: the trim removed the
`toHexOrNull`/`toIso` normalisers and the `?? null` lookups in the listing, but
`projectMember` kept its tolerant `profile?.displayName ?? ""` and
`user?.email ?? ""` fallbacks, and `tenantIdFromRequest`/`targetUserIdFromRequest`
still funnel a bad id into the id-shape check. So the absent-`user`/absent-
`profile`/malformed-id paths were **observably correct but uncovered**, not
broken. Those pins still earn their keep — they are the branches the GREEN must
be able to restore — but only the `joinedAt` corruption and the ordering
tie-break are genuinely RED. The distinction is recorded here so the GREEN does
not chase a phantom “broken absent-user path”.

### D2 — the product decisions the pins fix

- **An absent contact degrades to the fully-masked form** (`•••`), never a raw,
  empty or `undefined` value (§0.15). `maskEmail("")` already returns the
  fully-masked run; the pin makes that the contract, not an accident.
- **An absent profile degrades to `displayName: ""`** — the DTO field stays a
  string, and the row is never dropped.
- **A corrupt `joinedAt` degrades to the epoch** (`1970-01-01T00:00:00.000Z`) and
  the whole listing still answers `200`. The removed `toIso` fell back to
  `new Date(0)`; the pin restores that as the contract, so one bad row cannot
  `500` a workspace's member screen for every caller. (This is the F1 Medium
  from the OP-101 GREEN review, `members.ts:76`.)
- **A malformed `{userId}` is a uniform `404 not_found`**, from the owner caller,
  on both verbs — never a `500` and never a `403` (§0.4). The caller's owner
  gate still runs first, so a non-owner is `403` regardless of target id; the
  `404`/`403` split is about the _caller's_ role, not the target's shape.
- **The listing order is total**: `joinedAt` ascending, ties broken by ascending
  `userId`, so the order is stable between calls. (The D6 trim dropped the
  user-id tiebreak as unpinned; the pin restores it.)
- **The audit trail only claims changes that happened**: `member.role_changed`
  and `member.removed` are emitted on success and on success only — a refused
  mutation (`409 cannot_demote_owner`, `422 validation_failed`, `403 forbidden`)
  emits neither (the F3 Low from the OP-101 GREEN review).

### D3 — the tenant-segment mechanism is pinned by behaviour, not by mechanism

The reviewer's F2 found the `tenantIdFromRequest` doc comment (and ADR-0281 §D2)
claim a path with no `tenants` anchor yields `""`; in fact
`segments[segments.indexOf("tenants") + 1]` returns `segments[0]` for such a
path (`/api/v1/foo/abc → "api"`), and the `404` is produced by the downstream
`OBJECT_ID_HEX` check, not by a missing-segment branch. The pin asserts the
**uniform `404 not_found`** for two anchor-less paths and says nothing about the
helper's return value, so the GREEN is free to restore the explicit
`afterTenants > 0 && afterTenants < segments.length` guard _or_ to correct the
comment — ADR-0281 §D2's wording is left for the case-`t_082fa536` GREEN to fix.

### D4 — what is deliberately not pinned

- **An empty listing.** Unreachable through the route: the tenant stage denies a
  caller with no active `tenantMembers` row before the handler runs, so the
  removed empty-listing early return guards nothing reachable. The GREEN should
  not need it.
- **A `tenantMembers` row whose `userId` is not an `ObjectId`.** The D6 trim's
  `instanceof ObjectId` filter guarded this, but the wire DTO requires a 24-hex
  id (`idSchema`), so a non-id row cannot be projected without a new product
  decision (skip the row? synthesise an id?). Out of scope; not pinned.
- **`maskPhone`'s `+` conditional.** The D6 trim made the `+` unconditional;
  no §2.2 path returns a phone, so there is nothing to pin. ADR-0281 §D6 item 3
  stands.

## Consequences

- Against the current trunk the new spec is **3 failed / 33 passed**, all three
  failures meaningful: two `expected 500 to be 200` (the `joinedAt` corruption,
  `RangeError: Invalid time value` at `members.ts:76:71`) and one ordering
  mismatch (`joinedAt`-only sort vs the pinned tie-break). The remaining nine
  pins are green characterisation pins that cover branches the suite never
  touched (the `?? ""` fallbacks, the id-shape `404`, the two audit lines and
  their refusal counterparts) — they widen the margin the GREEN needs.
- **Measured impact.** With only the three RED pins filtered out (so the suite
  passes and vitest emits a coverage report), the full suite reports **80.15%
  branches (2444/3049)** — up from the trunk's **80.02% (2440/3049)**. The nine
  characterisation pins therefore add **+4 covered branches** on their own, the
  margin the GREEN's restoration spends; the three RED pins will add the
  `toIso`/tie-break branches once the GREEN restores them.
- The pins are test-only. `tsc -p apps/web/tsconfig.json --noEmit`, `eslint` and
  `prettier --check` are clean on the changed file; no production file is in the
  diff.
- The GREEN case `t_082fa536` is gated on this card and reuses this worktree. It
  restores `toIso` (epoch fallback), the `?? null` lookups and the listing's
  user-id tiebreak, and re-measures the global branch gate; each restored branch
  is exercised by exactly one of the pins above.

## Alternatives

- **Only write the three genuinely-RED pins.** Rejected: the green characterisation
  pins are precisely the branches the GREEN must be allowed to restore, and the
  audit lines were asserted nowhere. Dropping them would let the next GREEN trim
  the same code again.
- **Pin the `tenantIdFromRequest` return value directly** (`""` for an anchor-less
  path). Rejected: that couples the spec to a helper's internal return shape and
  would fail the moment the GREEN restores the guard the reviewer asked for. The
  behaviour — a uniform `404` — is the contract.
- **Pin a non-`ObjectId` `userId` row.** Rejected as a second product decision
  (D4); pinning a guess would force a wire shape no §2.2 text supports.
