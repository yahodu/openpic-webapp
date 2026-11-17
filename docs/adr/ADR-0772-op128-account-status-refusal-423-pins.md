# ADR-0772 — OP-128 follow-up: the account-state refusal answers the Appendix A.1 envelope (`423 account_suspended` / `account_banned`)

- **Status:** Proposed — four rows (`suspended` organizer, `banned` organizer, suspended attendee, permanent ban)
  are RED until the F-G1 GREEN lands (`t_4b4c1a41`); the `deletion_pending` / `deleted` / expired-ban / `active`
  control / mixed-batch / `413` rows are green on arrival
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_79d646b0` (TEST follow-up, orchestrator finding **F-G1**, decision card `t_61de14fa`), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-account-status-refusal-423-pins`, cut from the predecessor pin card's branch
  `OP-128-task-signed-url-fallback-pins` at `79bd74a` (PR #447, itself stacked on
  `OP-128-task-account-status-gate-pins` at `cfed101` — the card's "base after `t_8b3f316e` lands" is `79bd74a`,
  not `cfed101`, because that card delivered to its own branch instead of advancing the gate branch; the ADR and
  the PR record the deviation)
- **Consumes:** contract §0.3 (account states and the banned-user rule), §5.6 (the batch refresh and its
  `denied[]` vocabulary), **Appendix A.1** (`account_banned`/`account_suspended` rows at `3486`–`3487`); schema
  §13.1, §13.2; ADR-0025 (the auth guard table), ADR-0766 (the endpoint pins, D2/D3/D4), ADR-0767 (the
  implementation), ADR-0768 (the account gate — **D1 superseded, D2–D4 stand**), ADR-0770 (the gate's
  implementation), ADR-0771 (the breadth rows this card reconciles)
- **Supersedes:** **ADR-0768 D1** and D1's recorded consequence ("this wire does not carry `supportUrl`,
  `banReason` or `banExpires`"). ADR-0768 is **accepted and frozen**: it is not edited. The supersession lives
  here and in this record's index row, the pattern of ADR-0685 D3 and ADR-0687.

## Context

ADR-0768 D1 closed the OP-128 gate by mapping every account-state refusal to the **§5.6 per-item** code
`forbidden`:

```
403 { error: { code: "forbidden" } }
```

That reading took the four-code denial vocabulary (`forbidden`, `authentication_required`, `not_found`,
`feature_not_available`) — which §5.6 defines for one entry of `denied[]` — and used it for a refusal that
denies the **whole request**. The two envelopes are not the same thing:

- **§5.6 / §0.15** own the `200 { urls, denied }` answer and the denial code of one item.
- **Appendix A.1** (contract `3486`–`3487`) owns the whole-request error envelope and already carries both
  account states: `account_banned` **423** `{ banReason, banExpires }`, `account_suspended` **423**
  `{ reason, supportUrl }`.
- **§0.3** (contract `96`) repeats it for the ban: "**Banned users** → `423 account_banned` with
  `{ banReason, banExpires }` on every authenticated endpoint except `GET /me` and
  `POST /me/data-requests`."
- `AUTH_ERROR_TRANSPORT` (`apps/web/src/server/http/catalog.ts:160-168`) agrees: both account codes are
  **423**, and `account_incomplete` / `admin_2fa_required` are the only 403 members of that family.
- `evaluateAuth("user", …)` (`apps/web/src/server/auth/guards.ts:181-203`) already returns exactly those codes
  and details, and `requireAuth` forwards them verbatim (`guards.ts:454-459`). The media route flattens them to
  `appError("forbidden")` (`route.ts:174-176`), so the details a client needs are dropped one call before the
  wire.
- The exchange-wide behaviour is already pinned and green: `auth-guards.test.ts:495` (`I5`) measures a banned
  user as **423 `account_banned`** with `details { banReason, banExpires }` on a normal route.

So the media signer was the only authenticated endpoint answering `403` for a suspended or banned caller, and
the only one hiding the reason. The orchestrator took the decision on 2026-11-12: the refusal answers **A.1**,
not the per-item vocabulary. This card pins it.

## Decision

### D1 — the account-state refusal is the Appendix A.1 envelope; `403 forbidden` survives only for the deletion states

A refusal that denies the request is answered by A.1, and the guards' own `code` + `details` reach the wire
verbatim:

| Seeded account state                                               | Status  | `error.code`        | `error.details`                                    |
| ------------------------------------------------------------------ | ------- | ------------------- | -------------------------------------------------- |
| `userProfiles.status = "suspended"`                                | **423** | `account_suspended` | `{ reason: "suspended", supportUrl: "/support" }`  |
| Better Auth `user.banned`, `banExpires = 2099-01-01T00:00:00.000Z` | **423** | `account_banned`    | `{ banReason: "spam", banExpires: "2099-01-01…" }` |
| permanent ban (`banExpires: null`)                                 | **423** | `account_banned`    | `{ banReason: "spam", banExpires: null }`          |
| suspended **matched attendee**                                     | **423** | `account_suspended` | `{ reason: "suspended", supportUrl: "/support" }`  |
| `userProfiles.status = "deletion_pending"`                         | 403     | `forbidden`         | absent                                             |
| `userProfiles.status = "deleted"`                                  | 403     | `forbidden`         | absent                                             |
| ban with `banExpires` in the past (`2020-01-01`)                   | 200     | —                   | per-item answer, unchanged                         |
| suspended caller with **201** items                                | 413     | `payload_too_large` | unchanged — the cap precedes the gate (D3)         |

Every refusal row also pins **no `urls` key** and **no occurrence of the image's content hash** in the body:
a refused request mints no signed object.

`403 forbidden` is not deleted from this endpoint — it stays the answer for the two **deletion** states, which
A.1 has no 423 row for and which `evaluateAuth` itself returns as `forbidden` (`guards.ts:131-133`,
`:194-198`). D1 therefore changes three of the five refusal rows, not the vocabulary.

### D2 — §5.6's all-denied `403` still governs an **allowed** principal

`signedUrlBatchStatus`'s "every item denied and none `authentication_required` → `403`" (ADR-0766 D2) is the
per-item rule for a caller the account gate **admits**. It is not this refusal: an account-state failure stops
the request before any item decision exists, so the "all items denied" reading does not apply and no
`denied[]` is produced. The pins keep both: the mixed-batch `200` and the active control are unedited.

### D3 — the item cap (`413`) still precedes the account gate

`suspended caller + 201 items → 413 payload_too_large` is pinned and green (ADR-0771 D4). The size check is a
request-shape rule and runs before the principal's account state is consulted; a `423` here would tell a
suspended caller their batch is acceptable. This card keeps that order and pins it again through the
re-pinned suspension fixture, so a reorder reddens a row.

### D4 — no contract file changes, and no new read

`docs/API Contract.md` is **not edited**. §0.3 already mandates `423 account_banned`, A.1 already carries both
details blocks, and §5.6 already names the four per-item codes — the implementation is being brought to the
contract, not the contract to the implementation. The status and ban fields are already on the principal
`resolvePrincipal` returns, so the refusal costs no query and `I5`'s `reads(200) === reads(2)` still holds
(ADR-0768 D4, unchanged).

### D5 — the pins are test-only; the production `throw` is the GREEN's

`route.ts`, `guards.ts` and `signed-urls.ts` are untouched on this branch. The RED is exactly the four rows
whose status is not yet `423`; the GREEN (`t_4b4c1a41`) replaces the flattened
`throw appError("forbidden")` with the guard's own `code` + `details`. Note for that card:
`AppErrorOptions` is compiled with `exactOptionalPropertyTypes: true`, so `{ details: decision.details }`
fails `tsc` when the decision carries no details — spread the key instead
(`{ ...(decision.details ? { details: decision.details } : {}) }`).

## The pins (what this card changes)

One file, `apps/web/src/test/integration/media-signed-urls.test.ts`:

| Where                                     | Change                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ErrorBody` (`~:179`)                     | widened with `readonly details?: Record<string, unknown>` (A.1's per-code detail block) so the detail assertions type-check                                                  |
| `REFUSED_ACCOUNT_STATES` + `I7` `it.each` | each entry now carries `status` + `code` + `details`; titles read `answers $status $code …`; the assertion reads the envelope's `error` and compares status, code, details   |
| `I7` suspended attendee                   | `423 account_suspended` + `{ reason, supportUrl }`, no `urls`, no content hash                                                                                               |
| `I7` docblock                             | rewritten from the §5.6 `forbidden`/`403` rationale (and ADR-0768) to the A.1 rationale and **ADR-0772**                                                                     |
| `I7`/`I7b` shared constants               | `BAN_EXPIRES_NEVER` hoisted above the table so the seeded instant and the expected ISO string are one value; `BAN_REASON` names the string both `seedBan` and the pins use   |
| `I7b` permanent ban / `deleted`           | details assertion kept (t_8b3f316e already landed it `423`), `urls` absent added so every refusal row carries the no-signed-object pair                                      |
| `I7b` docblock                            | re-pointed from "the `I7` rows are stale" to "the `I7` describe holds the three base states" — the contradiction is resolved by this card, so the comment must not repeat it |

**Reconciliation, not duplication.** `t_8b3f316e` (ADR-0771 D4) added `I7b`'s expired ban, permanent ban,
`deleted` and `413` rows, and its permanent-ban row already pinned `423 account_banned` with
`{ banReason, banExpires: null }`. Nothing had to be re-pinned there: no row on this branch answers
`403 forbidden` for a suspended or banned caller after this change. The one remaining `403` rows are the two
deletion states, which D1 keeps.

## Evidence (measured on this branch)

**RED on arrival.** `npx vitest run --project integration apps/web/src/test/integration/media-signed-urls.test.ts`
on the unmodified base route (`route.ts` sha256 `ae0fa71f…`):

```
Tests  4 failed | 27 passed (31)
  × I7 > answers 423 account_suspended … for a suspended event member
  × I7 > answers 423 account_banned … for a banned event member
  × I7 > answers 423 account_suspended for a suspended attendee that holds a match
  × I7b > answers 423 account_banned with the ban details for a permanent ban
AssertionError: expected 403 to be 423 // Object.is equality
```

All four failures are `expected 403 to be 423`, one per suspended/banned row. Every row the decision did not
move is green: `deletion_pending` `403`, `deleted` `403`, expired ban `200`, the `active` control (both kinds
signed), the mixed batch `200`, and the suspended + 201-item `413`.

**Satisfiability (throwaway half-fix in `route.ts`, reverted).** Forwarding the guard's decision —
`throw appError(decision.code, { details: decision.details })` — turns the file **31 passed (31)**, so the
fixtures reach the right principal and the expected details are the guard's own.

**The detail assertions are load-bearing (throwaway probe, reverted).** The same half-fix with the details
dropped (`throw appError(decision.code)`) reddens exactly four rows —
`expected undefined to deeply equal { reason: 'suspended', … }` for the three I7 refusal rows and
`expected { error: …(4) } to match object { error: …(2) }` for the permanent ban. A GREEN that forwards the
status and the code but not the details is therefore rejected.

**Restored byte-identically:** `route.ts` `ae0fa71f0ce858d1a9cf1e3d0d4f3c3f52eff343fb3826155f6d605a30f8830f`,
`guards.ts` `97212f51…`, `signed-urls.ts` `2b3f9793…`; `git status --short` shows the one spec file, this
record and the ledger cells only.

**Gates.** Focused unit `media-signed-urls-authorization.test.ts` untouched at **24 passed (24)**: the refusal
is a route-level fact, not a per-item decision. Full unit and integration suites, `tsc -p
apps/web/tsconfig.json --noEmit`, ESLint, Prettier and `adr-numbering` (**29/29**) are recorded in the card
handoff.

## Consequences

- **O1 — a client can now explain the refusal.** `supportUrl` (suspended) and `banReason`/`banExpires`
  (banned) reach the wire, superseding ADR-0768 O1 ("the code cannot say suspended"). The client reads the
  same envelope here as on every other authenticated endpoint, so one handler can branch on it.
- **O2 — the per-item `denied[]` vocabulary is unchanged.** A caller whose account is **allowed** still gets
  `not_found` / `authentication_required` / `feature_not_available` / `forbidden` per item, and the all-denied
  collapse at `403` (D2). §5.6 needs no edit.
- **O3 — out of scope, owned elsewhere.** The `auth.denied` log line for an account refusal (**F-G2**) is
  `t_4b4c1a41`'s; the `media.sign` rate class stays as ADR-0766 O3 left it; a suspended OP-129 `attendee`
  session has no `userProfiles` row to read (ADR-0768 O2, unchanged).
- **O4 — the deletion states keep `403`.** They have no A.1 423 row and the guard itself returns `forbidden`;
  if the contract ever grows `account_deletion_pending`, this table is the place to extend.
- **O5 — PR stacking deviation.** The card names `OP-128-task-account-status-gate-pins` as the base, but the
  predecessor delivered to `OP-128-task-signed-url-fallback-pins` (`79bd74a`, PR #447). This branch is cut
  from `79bd74a` and its draft PR targets that branch so the diff is only this card's change; if #447's base
  is retargeted or merged first, this PR's base follows it.
