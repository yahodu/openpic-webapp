# ADR-0222 — OP-98 GREEN review sign-off: notification preferences and the public type catalogue verified and merged

- **Status:** Accepted · **Date:** 2026-10-22 · **Author:** `openpic-webapp-reviewer`
- **Card:** OP-98 phase 1 (GREEN, `t_d619efde`) · **Verdict:** **APPROVED WITH FINDINGS** — no changes requested; squash-merged
- **Reviewed:** branch `OP-98-task-notification-preferences`, head `c94cf95` (the post-`origin/main`-merge head), base `origin/main`; PR [#247](https://github.com/yahodu/openpic-webapp/pull/247) — squash-merged to `main` as `25292ae` ("feat(notifications): OP-98 notification preferences and public type catalogue (#247)"), `mergedAt` `2026-10-22T09:09:02Z`; `git merge-base --is-ancestor 25292ae origin/main` **true**
- **Reviewed by:** round 1, **artifact lens** (diff read cold, every handoff claim independently reproduced)
- **Number:** drawn from the OP-98 lane's reserved range `0220`–`0239` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), `docs/adr/README.md` § "ADR number allocation"). `0220` is consumed by [ADR-0220](ADR-0220-op98-notification-preferences-red.md) (the RED contract) and `0221` by [ADR-0221](ADR-0221-op98-notification-preferences-green.md) (the GREEN implementation) — both count as taken under ADR-0300 §7 — so this sign-off takes `0222`; the lane's `Next free` cell in `docs/adr/README.md` read `0222` on a fresh `origin/main` immediately before this commit and advances to `0223`.
- **Relates to:** [ADR-0220](ADR-0220-op98-notification-preferences-red.md) (the RED contract of record), [ADR-0221](ADR-0221-op98-notification-preferences-green.md) (the GREEN implementation this sign-off accepts), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the per-lane range policy), PR [#247](https://github.com/yahodu/openpic-webapp/pull/247) review comment [`#issuecomment-6336995714`](https://github.com/yahodu/openpic-webapp/pull/247#issuecomment-6336995714)
- **Touches:** `docs/adr/ADR-0222-op98-green-review-signoff.md` (this file) and the `docs/adr/README.md` ledger (the OP-98 lane row cell and paragraph) — **docs only**

## Context

This ADR records only the **review** of the OP-98 GREEN. The decisions the
implementation made are recorded in ADR-0221; nothing here restates or
contradicts them. The sections below are the delta a sign-off adds: what was
independently reproduced, what the verdict pins, and where each finding went.

The GREEN implements the ADR-0220 contract exactly: the pure settings module
(`mergePreferences` / `applyPreferencesPatch` / `isValidClockTime` /
`DEFAULT_PREFERENCES`), the `GET`/`PATCH /me/notification-preferences` route
pair, and `GET /notification-types` (contract §7.4, §7.6; design §19.1,
§19.3, §5). This review therefore looked at a tree whose suite the handoff
reported green, and re-derived that claim from scratch at the reviewed head.

## Decision

### 1. Reviewed scope and evidence — reproduced, not taken from the handoff

The merge (`25292ae`) touches exactly:

| File                                                              | Change                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/web/src/server/notifications/preferences.ts`                | new — the pure merge/patch module                              |
| `apps/web/src/server/notifications/notification-types-read.ts`    | new — the catalogue read accessor (seed-fallback guarded)      |
| `apps/web/src/app/api/v1/me/notification-preferences/route.ts`    | new — `GET` + `PATCH`                                          |
| `apps/web/src/app/api/v1/notification-types/route.ts`             | new — the public §7.6 projection                               |
| `packages/contracts/src/errors.ts`                                | `NOTIFICATION_ERROR_CODES` (append-only set)                   |
| `apps/web/src/server/http/catalog.ts`                             | `NOTIFICATION_ERROR_TRANSPORT` (the code-set's transport rows) |
| the three RED specs, `ADR-0220`, `ADR-0221`, `docs/adr/README.md` | carried unedited / the ledger                                  |

Every number below was re-run by the reviewer at the reviewed head `c94cf95`
(the merged tree is identical to it), in a **detached copy worktree** of the
same repository — not read off the handoff or from ADR-0221's own (earlier,
pre-merge) evidence table:

| Check (at `c94cf95`)                                                               | Result                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------- |
| `vitest run --project unit`                                                        | **90 files / 1605 passed**                   |
| `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`)                      | **63 files / 421 passed**                    |
| `tsc -p packages/contracts/tsconfig.json --noEmit`                                 | exit 0                                       |
| `tsc -p apps/web/tsconfig.json --noEmit`                                           | exit 0                                       |
| `eslint .`                                                                         | **0 errors / 80 pre-existing warnings**      |
| `prettier --check .`                                                               | clean                                        |
| ADR guard `vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts` | **29 / 29 passed**                           |
| `git diff --stat ad0e16e c94cf95 -- …` (three RED specs **and** ADR-0220)          | **empty** — byte-identical to the RED commit |

The cache-then-verify posture held: **no reviewer edit landed in the
deliverable**; the reviewer's only touched file was `docs/adr/README.md`, and
only to resolve the merge with `origin/main` (see §5).

Review record: the PR body comment
[`#issuecomment-6336995714`](https://github.com/yahodu/openpic-webapp/pull/247#issuecomment-6336995714)
(the sole `gh` identity, `getwithashish`, authored PR #247, so a formal GitHub
approval is not possible — the sign-off is recorded as a PR comment, matching
the posture of every prior OP-98/OP-97 review in this board).

### 2. Verdict: APPROVED WITH FINDINGS

The three acceptance criteria are verified as met and pinned:

- **Locked toggles are reported, not hidden.** A group that cannot be opted out
  of (`in_app`, `optOutAllowed: false`, or a transactional type) reports
  `effective: "on"`, `source: "default"` yet is still present in `resolved[]`.
- **The sparse patch semantics are exact.** Only present keys change; `null`
  removes an override; validation precedes any write, so a rejected `PATCH`
  writes nothing.
- **Precedence sources are correctly labelled.** A `global` `"on"` collapses to
  `source: "default"`; a `global` `"off"` or a more specific scope is a real
  override; ADR-0221 §"The module" records both readings.

The verdict is "with findings" only because five observations are owed to
follow-up cards (§3); none changes the shipped contract behaviour, and none was
a reason to hold the merge. No changes were requested on PR #247 and no
reviewer edit landed in the deliverable.

RED review finding **F1** (the error-code placement) is confirmed **resolved**:
the codes ride an append-only `NOTIFICATION_ERROR_CODES` set in
`@openpic/contracts` plus a `NOTIFICATION_ERROR_TRANSPORT` table in the server
catalogue, and `ERROR_CATALOG` is untouched — still exactly the 23 base
Appendix A rows that `errors.test.ts` pins. Adding the codes to `ERROR_CATALOG`
would have failed typecheck and reddened a spec the GREEN card may not edit.

### 3. F3 (the ADR-0220 code-span spacing fix) — **declined, reproduced independently**

RED review finding F3 asked for missing spaces "after closing backticks" in
ADR-0220 §"Assumptions & open questions", on the premise that CI would not catch
it. The premise is wrong, and the reviewer re-derived that independently rather
than trusting ADR-0221's own probe:

```
# probe file written on a copy of the repo, inside docs/adr/
$ cp <spaced paragraph> docs/adr/_f3probe.md
$ npx prettier --check docs/adr/_f3probe.md
[warn] docs/adr/_f3probe.md            # the spaced form is NOT prettier-clean
$ npx prettier --write docs/adr/_f3probe.md
$ sed -n '3,5p' docs/adr/_f3probe.md
… This drives the `default`source and the no-row`GET` result (`global`all`on`).  # spaces removed, byte-identical
```

Applying F3 would therefore make the intended `prettier --check .` gate red —
the opposite of its intent. The probe file was removed; the copy worktree was
left clean. `docs/adr/ADR-0220-…-red.md` stays **byte-identical** to its RED
commit (`ad0e16e`), and no ADR number is consumed by the decline.

### 4. Findings routed to follow-up cards

| #   | Severity | Finding                                                                                                                                                                                                                                                         | Routed to                                                  |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| R1  | Low      | The locked-group guard is enforced on `byType` only: a `global`/`byEvent` disable of a locked group is accepted as a stored no-op rather than rejected `422 opt_out_not_allowed`.                                                                               | **`t_c638e64f`** (TEST) — landed PR #254, squash `e99ee61` |
| R2  | Low      | The `PATCH` read-modify-write is non-atomic: two concurrent patches can lose an update. Only the **sequential** half is pinnable deterministically.                                                                                                             | **`t_c638e64f`** (TEST) — sequential half only             |
| R3  | Info     | `resolvesTo` / `resolvesToReason` are declared on the `mobile` entry but never emitted. ADR-0220 records this out of scope; informational.                                                                                                                      | no action (Info)                                           |
| R4  | Info     | No server-side cache on `GET /notification-types`: the route reads all enabled rows per request. A projection is impossible because `notificationTypeSchema` requires `retainBody`, and the contract mandates only the response `Cache-Control`; informational. | no action (Info)                                           |
| R5  | Info     | No rate-limit stage is bound on the five routes. This matches the repo-wide convention (19 of 20 route files bind none) and is already accepted as ADR-0132 F6; informational, not a regression.                                                                | no action (Info)                                           |

R1 and R2 were routed to the TEST card `t_c638e64f`, which landed as PR #254
(squash `e99ee61`, ancestor of `origin/main`) — characterisation pins only, no
production change. R3–R5 are informational and tracked by the human.

### 5. Merge mechanics

`origin/main` advanced 5 commits while the branch was in review. The branch
merged `origin/main`; the `docs/adr/README.md` index auto-merged cleanly, with
**both** main's OP-97 cell (`0183`) and the branch's OP-98 cell (`0222`)
preserved. The full suite was re-run green on the merged head (`c94cf95`) before
the squash merge, and the merged tree is identical to the reviewed head. The
merge landed as `25292ae`, an ancestor of `origin/main`.

## Consequences

- OP-98 phase 1 is **closed**: notification preferences, the merged read and the
  public type catalogue are verified, merged (`25292ae`) and recorded. ADR-0220
  stays authoritative for behaviour; ADR-0221 records the implementation; this
  ADR records the acceptance.
- Number `0222` is consumed by this sign-off; the OP-98 lane's `Next free` cell
  in `docs/adr/README.md` advances to `0223`. No number outside the lane's
  `0220`–`0239` range is touched.
- This is a **docs-only** record: no production, test, fixture or configuration
  file is touched, so no suite's observable behaviour changes.
- The findings are routed, not buried: `t_c638e64f` (TEST) carries R1/R2 and has
  already landed (PR #254); R3–R5 need no card.
- The `docs/adr/README.md` edit is the OP-98 lane row cell (`0222` → `0223`) plus
  one inserted paragraph. That file is a cross-lane hotspot; the paragraph is
  appended in the established sign-off style and no other lane's cell is touched.

## Alternatives considered

- **Record this sign-off as a section inside ADR-0221.** Rejected: ADR-0221 is
  the _implementation_ record and shipped inside PR #247; the acceptance of the
  merged tree is a distinct artifact, and every prior sign-off in this lane
  family (ADR-0132, 0181, 0200) is recorded as its own file.
- **Leave the findings as PR comments only.** Rejected: the repo's operating
  rules require every review finding to be routed to a card; R1/R2 therefore
  went to `t_c638e64f` (which has since landed as PR #254).
- **Request changes on PR #247.** Rejected: none of the findings touches the
  shipped contract behaviour, and blocking a verified, CI-green implementation
  on follow-up pins would hold the lane open for no behavioural benefit.
- **Apply F3 (the ADR-0220 spacing fix) in this card.** Rejected: it would make
  `prettier --check .` red (reproduced in §3), so the fix is withdrawn rather
  than applied; ADR-0220 must stay byte-identical to its RED commit.
