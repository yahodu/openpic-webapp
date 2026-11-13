# ADR-0825 — OP-134 GREEN review sign-off: the claim and the cross-tenant "my events" read verified; five findings routed, none blocking

- **Status:** Accepted · **Date:** 2026-11-13 · **Author:** `openpic-webapp-reviewer`
- **Card:** OP-134 phase 5 (GREEN, `t_135c11ae`), round 1 · **Verdict:** **APPROVED WITH FINDINGS** — no changes requested on the pull request, **zero reviewer edits to the deliverable**
- **Reviewed:** branch `OP-134-task-claim-and-my-events`, head `967d928`; PR [#565](https://github.com/yahodu/openpic-webapp/pull/565) — squash-merged to `main` as `0d57e95` (`feat(attendee): OP-134 claim an anonymous session and read my events (#565)`), `mergedAt` `2026-11-13T15:20:26Z`; `git rev-parse 0d57e95^{tree}` = `967d928^{tree}` = `6afce2f570cfca220594a0c16a3f9c9679ecb761`, so the bytes reviewed are the bytes that ship
- **Reviewed by:** round 1, **artifact lens** (diff read cold; every handoff claim independently re-derived)
- **Consumers:** none in the swept source tree — this is a review record and no source file cites it. The consumers of the decision it signs off stay declared on [ADR-0815](ADR-0815-op134-attendee-claim-green.md) and are not restated here.
- **Relates to:** [ADR-0814](ADR-0814-op134-attendee-claim-red.md) (the RED contract of record), [ADR-0815](ADR-0815-op134-attendee-claim-green.md) (the GREEN this record accepts), [ADR-0818](ADR-0818-op134-claim-endpoint-arms-pins.md) (the F1/F2 pins it routed), [ADR-0819](ADR-0819-op134-my-events-gallery-url-pin.md) and [ADR-0822](ADR-0822-op134-my-events-gallery-url-green.md) (the F4 pin and GREEN), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the per-lane range policy), PR [#565](https://github.com/yahodu/openpic-webapp/pull/565) review comment [`#issuecomment-6857198808`](https://github.com/yahodu/openpic-webapp/pull/565#issuecomment-6857198808)
- **Touches:** `docs/adr/ADR-0825-op134-green-review-signoff.md` (this file) and the `docs/adr/README.md` ledger (one index row, both `Next free` cells, one lane paragraph) — **docs only**
- **Amends:** nothing. [ADR-0814](ADR-0814-op134-attendee-claim-red.md) and [ADR-0815](ADR-0815-op134-attendee-claim-green.md) are merged and frozen; this record neither edits them nor supersedes them.
- **Consumes:** `0825` (both `Next free` cells advance to `0826`; see §6).

## Context

This ADR records only the **review** of the OP-134 GREEN. The decisions the
implementation made are recorded in ADR-0815; nothing here restates or
contradicts them. The sections below are the delta a sign-off adds: what was
independently reproduced, what the verdict pins, and where each finding went.

The GREEN delivers the anonymous-session claim and the cross-tenant "my events"
read for contract §6.7: two pure modules (`computeExpiringSoon`, `decideClaim`),
one claim service (`claimAttendeeSession`) used by both the explicit route and
the session-created identity hook, the new catalogue code
`session_claimed_by_other_user` (`409`), and
`crossTenantReads.findAttendeeEventsBySubjectUser` as the only new whitelisted
cross-tenant read. This review therefore looked at a tree whose suite the
handoff reported green, and re-derived that claim from scratch at the reviewed
head.

## Decision

### 1. Reviewed scope and evidence — reproduced, not taken from the handoff

Every number below was re-run by the reviewer at the reviewed head `967d928`, in
a worktree of the same repository — not read off the implementer's handoff or
off ADR-0815's own (earlier, pre-merge) evidence table:

| Check (at `967d928`)                                                                                                      | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `vitest run --project unit` (the two OP-134 unit specs)                                                                   | **2 files / 21 passed (21)**                                                                           |
| `vitest run --project integration` (the three OP-134 integration specs)                                                   | **3 files / 17 passed (17)**                                                                           |
| `vitest run --project unit` (full)                                                                                        | **177 files / 2930 passed, 3 skipped**                                                                 |
| `vitest run --project integration` (full)                                                                                 | **127 files / 1309 passed**                                                                            |
| ADR guard `adr-numbering` on the branch tree                                                                              | **29 passed (29)**, no duplicate `ADR-NNNN`                                                            |
| `gh pr checks 565`                                                                                                        | **13 / 13 pass**                                                                                       |
| honesty sweep of the production diff (`NODE_ENV`, `VITEST`, `isTest`, `console.`, `@ts-ignore`, `eslint-disable`, `TODO`) | **clean** — the single hit is a `Number.isNaN` guard, a false positive                                 |
| test-file diff `f5215f2..967d928`, test files only                                                                        | **7 hunks, every one an `ADR-0811 → ADR-0814` docblock line**; no assertion, fixture or helper changed |
| re-run on the **merged trunk** `0d57e95`                                                                                  | unit **50/50** (21 claim + 29 ADR), integration **17/17**                                              |

The cache-then-verify posture held: **no reviewer edit landed in the
deliverable**, and no changes were requested on the pull request.

### 2. Verdict and the acceptance criteria mapped to evidence

**APPROVED WITH FINDINGS.** Nothing in the delivery is Critical, every
acceptance criterion of the card is met, and the suite is green. The five
findings are Medium/Low, are behaviours the pins do not cover, and each one is
routed to a card rather than left as a flag.

| Acceptance criterion (card `t_135c11ae`)               | Evidence                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _No data moves; no reprocessing_                       | `claim.ts:182-192` is schema §15.3's `$set`/`$unset` pair keyed on `_id`; integration case I1 asserts the same `_id`, the same selfie id and an unchanged outbox length. Green.      |
| _The cross-tenant read only returns the caller's rows_ | `cross-tenant.ts:376-382` builds `{"subject.userId": subjectUserValue(userId), …keyset}` and nothing else; case I3 seeds a second account's profile and asserts it is absent. Green. |
| _The cookie is cleared_                                | `route.ts:97-103` answers `op_att=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` through `buildAttendeeSessionCookie`; case I4 asserts it. Green.                                      |
| _`info attendee.claimed` with counts_                  | `claim.ts:230-235`; asserted in case I1. Green.                                                                                                                                      |

### 3. Findings routed to cards — F1 to F5

| id  | severity   | finding                                                                                                                                               | routed to                              |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| F1  | Medium     | two accounts claiming one session concurrently both answer `200 claimed: [1]`; two `attendee.event.linked` rows; `claimedByUserId` is last-write-wins | TEST `t_08232689` → GREEN `t_07786aa0` |
| F2  | Medium     | a cookie-only **bodyless** claim `POST` answers `415 unsupported_media_type`, though §6.7 says the body may be omitted                                | the same pin/GREEN pair                |
| F3  | Low-Medium | two ADR index-row tails still cite the intermediate renumber                                                                                          | DOCS `t_9d929f46`                      |
| F4  | Low        | `galleryUrl` is `"/e//gallery"` on the list where the claim answers `""`                                                                              | TEST `t_53eb3bdf` → GREEN `t_e9bc6c07` |
| F5  | Medium     | the claim's cross-tenant **write** goes through `platformRepo` outside `src/server/repos/**`, plus two byte-identical keyset filters                  | refactor `t_647440ba`                  |

**F1 — Medium · `apps/web/src/server/attendee/claim.ts:148,182` · concurrent
claims by two accounts both succeed.** Measured in a throwaway worktree at
`967d928` (probe deleted, not committed): two signed-in accounts claim the same
session through `Promise.all`, and the probe answered

```
PROBE_RESULT {"statusA":200,"statusB":200,"claimedA":1,"claimedB":1,"profileSubjects":[{"kind":"user","userId":"…A"}],"claimedBy":"…A","linkedEvents":2}
```

So one profile, owned by `A`; `B`'s `200` still names an event it did not move;
**two** `attendee.event.linked` domain events exist for one claim; and
`attendeeSessions.claimedByUserId` is last-write-wins rather than the owner. The
conflict check at `:148` is a read before the writes, and the re-point
`updateOne` at `:182` never inspects `matchedCount`. → TEST `t_08232689` (the
pins live in
`apps/web/src/test/integration/attendee-claim-endpoint-arms.test.ts`), GREEN
`t_07786aa0`.

**F2 — Medium · `apps/web/src/app/api/v1/me/attendee-sessions:claim/route.ts:75`
· the contract's "body omitted" arm is a 415.** §6.7 writes the body as
`{ "sessionToken": … }` _"(or omitted, reading the `op_att` cookie)"_. Measured:
a cookie-only `POST` with **no body** answers `415 unsupported_media_type` and
claims nothing; `Content-Type: application/json` with an empty body answers
`400 malformed_json`. Only `{}` works, and the RED helper `claimSession()` always
sends `{}`, so the omission arm was never exercised. The house already has
`optionalJsonBody()` (used by §6.5's `gallery:seen` and `hide`) for exactly this
shape. → the same TEST/GREEN pair.

**F3 — Low-Medium · `docs/adr/README.md:428-429` · two index rows still cite the
intermediate renumber.** Row `0814` ended _"Renumbered `0811 → 0813` at merge"_
(the record itself says `0811 → 0813 → 0814`); row `0815` ended _"Draws `0814` …
both advance to `0815`"_ and _"(`ADR-0811 → ADR-0813`)"_ — but the row **is**
`0815`, the cells read `0816`, and the citations had moved to `0814`. The cell
was right; only the prose was stale, and a reader who "repaired" the cell from
the prose would re-mint `0815`. → DOCS `t_9d929f46`.

**F4 — Low · `apps/web/src/app/api/v1/me/events/route.ts:90` · `galleryUrl` is
`"/e//gallery"` when the event has no active access link.** Measured:
`{"slug":"","galleryUrl":"/e//gallery"}`. The claim answers `""` for the same
event (`claim.ts:117-120`), so the two §6.7 surfaces disagreed and one of them
carried a path no route serves. → TEST `t_53eb3bdf`, GREEN `t_e9bc6c07`.

**F5 — Medium · `apps/web/src/server/attendee/claim.ts:86` · a cross-tenant
_write_ lives outside the whitelisted repository module.**
`platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles)` was the only
place under `apps/web/src/server` that reached this tenant-scoped collection
through the tenant-free door (every other reader uses `tenantRepo`; `platformRepo`
is reserved for platform-scope collections). The claim must cross tenants, but
the exception was undocumented beside the "single whitelisted cross-tenant read"
statement and sat outside the `repos/**` directory the lint rule keeps
reviewable. Also in `cross-tenant.ts`: `reusableKeysetFilter` and
`attendanceKeysetFilter` were byte-identical apart from the sort field. →
refactor `t_647440ba` (behaviour-preserving).

**Resolution state at this head (recorded, not claimed as verified work).** F3 is
closed (PR #583 → `db25e3b`). F4 is closed: the pin landed inside its own GREEN
PR (#579 → `ad5b1ce`) rather than on the closed draft #574, and the decision is
recorded in ADR-0819/ADR-0822. F5 is closed (PR #584 → `5a0c8e0`; the contract
sentence that names the whitelisted write followed in PR #588 → `5f6588a`). F1
and F2 are **open by design**: the pins are delivered on the still-open draft PR
#573 and recorded in ADR-0818, and the GREEN `t_07786aa0` carries them unchanged.

### 4. Information recorded without a card

- `cross-tenant.ts:454` defaults a missing `status` to `"ready"` and `:456` a
  missing `updatedAt` to `new Date(0)` — silent defaults a fixture cannot tell
  apart from stored data.
- A `409` leaves `op_att` in the browser; only the success answer clears it.
- The emit happens after the rows have moved, so an outbox failure answers a
  `500` over committed state. The implementer disclosed it; a retry is safe
  because the walk then finds no anonymous row. No pin covers it.
- `newMatchCount` excludes hidden matches — a choice §6.7 does not spell out
  (ADR-0815 §5).
- The reviewer made no refactor on the reviewed PR: the one candidate (the twin
  keyset filters) sits in the same file as the F5 move, and a reviewer commit
  would have forced a fresh 13-check CI run on a green PR without changing what
  ships. It was folded into `t_647440ba` with its guard.

### 5. The RED contract's docblocks were renumbered at merge — comment-only, verified

The RED specs cite their contract record in their file docblocks. When the lane
renumbered its records `ADR-0811 → ADR-0814` at merge (ADR-0300 §10: main's
merged records win), those citations had to move with them or the
citation-accuracy guard would have been dishonest. `git diff f5215f2..967d928 --
apps/web/src/test` is **7 hunks and every one is an `ADR-0811 → ADR-0814`
docblock line**; no assertion, fixture, helper or mock behaviour changed. The
handoff disclosed the edit, and the reviewer verified it hunk by hunk rather
than accepting the disclosure.

### 6. Number and ledger effect

Both `Next free` cells read `0824` at this branch head (`origin/main`
`5f6588a`). The mandatory sweep before minting found the pool head **already
taken in flight**: `ADR-0824-op132-first-match-notified-pin.md` is committed on
`OP-132-task-first-match-notified-pin` (PR #590, worktree `t_fba391ab`), and
`git rev-list --objects --all -- docs/adr` returns `0824` as the highest number
anywhere on any ref. (The sweep's other hit, `0823`, is the trunk's own merged
`ADR-0823-op132-confirm-burst-budget.md` carried by PR #589's head — a branch
inherits its base's records, so a sweep must be read against what each head
_adds_, not what it contains.) Under ADR-0300 §7 an in-flight number counts as
taken, so this record draws **`0825`** — the next number above the highest
in-flight reservation — and both cells advance to `0826`. No lane row is minted:
the shared attendee block `0780`–`0798` was exhausted before this lane, so the
number comes from the `unallocated (future lanes)` pool, the
[ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md) precedent. When
PR #590 lands it will set the cells from its own base and the merge keeps the
**higher** cell, exactly as the earlier skips in this lane did.

## Consequences

- The lane's round-1 review is on the record where a future reader of the code
  will find it, next to the implementation it signs off — not only in a pull
  request comment, which a squash-merge buries.
- The verdict is bounded: it says the tested behaviour is right, not that the
  claim and the read are finished. F1 (a double claim by two accounts) and F2 (a
  §6.7 arm the contract publishes and the route refuses) are Medium and remain
  open; both are pinned before they are fixed, per TDD, and the pins exist at
  `b03e212`.
- The two §6.7 surfaces now agree on the empty-slug `galleryUrl` (F4), and the
  claim's cross-tenant write is inside the whitelisted repository with a
  contract sentence naming it (F5) — both were review findings, both were fixed
  by their own cards, and neither fix is claimed as verified here.
- The ledger cells now stand at `0826` while `0824` and `0825` are in flight or
  consumed; a later lane that reads the cell as a reservation bound would
  over-allocate by one, which ADR-0300 §10 already forbids.
- Nothing in this record changes behaviour, the test-facing contract, or any
  accepted record.

## Alternatives considered

- **Append the sign-off to ADR-0815 instead of a new record.** Rejected:
  ADR-0815 is merged and frozen, and the house rule is one file per decision
  with supersession rather than in-place editing. The OP-98/OP-100 precedent
  ([ADR-0222](ADR-0222-op98-green-review-signoff.md),
  [ADR-0262](ADR-0262-op100-red-review-signoff.md)) is a separate sign-off
  record.
- **Mint the number from the `Next free` cell (`0824`).** Rejected on the
  sweep: `0824` is committed on an open PR, and ADR-0300 §7 counts in-flight as
  taken. Minting it would have produced a duplicate file number at merge, which
  is the failure mode this lane already hit twice (`0811 → 0813 → 0814`,
  `0812 → 0815`).
- **Record the Medium findings and let the cards carry the detail.**
  Rejected: F1 and F2 are behaviours, not style, and the record must state the
  measurement so that a future reader can tell a regression from a documented
  gap. The probe output and the failure texts are quoted verbatim for that
  reason.
- **Fold the F5 refactor into the review of PR #565.** Rejected: a reviewer
  commit on a green PR would have re-run 13 checks to ship the same bytes, and
  the refactor needs its own suite-guarded change. It shipped as its own card
  instead.
