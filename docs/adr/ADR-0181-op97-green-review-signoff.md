# ADR-0181 — OP-97 GREEN review sign-off: feed, read state and the unread-count hot path verified and merged

- **Status:** Accepted · **Date:** 2026-10-22 · **Author:** `openpic-webapp-reviewer`
- **Card:** OP-97 phase 1 (GREEN, `t_58825ec3`) · **Verdict:** **APPROVED WITH FINDINGS** — no changes requested; squash-merged
- **Reviewed:** branch `OP-97-task-in-app-feed-read-state-green`, head `82bcce0`, base `origin/main` @ `c44c311`; PR [#233](https://github.com/yahodu/openpic-webapp/pull/233) — squash-merged to `main` as `f95c50f` ("feat(notifications): OP-97 in-app feed, read state and unread-count hot path (#233)")
- **Reviewed by:** round 1, **artifact lens** (diff read cold, every handoff claim independently reproduced); all **13** PR checks `completed/success` at `82bcce0`
- **Number:** drawn from the OP-97 lane's reserved range `0180`–`0199` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), `docs/adr/README.md` § "ADR number allocation"). `0180` is consumed by the GREEN implementation ([ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md)); the lane's `Next free` cell in `docs/adr/README.md` read `0181` on a fresh `origin/main` (`cb7fff7`) immediately before this commit, so this sign-off takes `0181` and the cell advances to `0182`.
- **Relates to:** [ADR-0131](ADR-0131-op97-in-app-feed-read-state-unread-count-red.md) (the RED contract of record), [ADR-0132](ADR-0132-op97-red-review-signoff.md) (the RED review sign-off), [ADR-0180](ADR-0180-op97-in-app-feed-read-state-unread-count-green.md) (the GREEN implementation this sign-off accepts)

## Context

This ADR records only the **review** of the OP-97 GREEN. The decisions the
implementation made are recorded in ADR-0180; nothing here restates or
contradicts them. The sections below are the delta a sign-off adds: what was
independently reproduced, what the verdict pins, and where each finding went.

The lane had already spent one round on a disputed red. The GREEN's e2e journey
`E1` failed because the spec's read `POST` omitted the CSRF header the pinned
middleware gate requires; the fix was routed to the Test Author's card
`t_6f2430cb`, which landed the one-line spec change (RED commit `97257f5`) and
closed the dispute. This review therefore looked at a tree whose suite was
already reported green, and re-derived that claim from scratch.

## Decision

### 1. Reviewed scope and evidence — reproduced, not taken from the handoff

| Check                                                                                    | Result                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vitest run --project unit` @ `2388b4a`                                                  | **88 files / 1530 passed** — matches the handoff exactly                                                                                                                                   |
| `vitest run --project integration` (full) @ `2388b4a`                                    | **61 files, 398 passed / 1 failed** — the single red is `notification-unread-count.test.ts` I4 (`Test timed out in 5000ms`)                                                                |
| I4 suite re-run in isolation                                                             | **8/8 passed, 12.29 s** → the red is a load-dependent timeout, not an assertion failure and not a plan regression                                                                          |
| `playwright -c apps/web/playwright.config.ts --project=api e2e/me-notifications.spec.ts` | **E1 passed** (597 ms)                                                                                                                                                                     |
| OP-97 suites re-run at `82bcce0` (post-`origin/main` merge)                              | **43/43 passed** (fan-out + feed + read-state + unread-count)                                                                                                                              |
| `gh pr checks 233` @ `82bcce0`                                                           | **13/13** pass, including `ci` (e2e) and `test_coverage`                                                                                                                                   |
| Honesty scan of the new production files                                                 | clean — no `@ts-ignore`/`eslint-disable`/`skip`/`TODO`, no console noise, no fixture-shaped hardcoding; the only `process.env` reads are the pre-existing `instrumentation.ts` boot guards |

The reviewed tree is exactly the landed tree: `git diff 82bcce0 f95c50f -- apps
docs` is **empty**. **No test file was edited by the reviewer.** The reviewer's
only touched file was `docs/adr/README.md`, and only to resolve the merge
conflict with `origin/main` (keeping **both** index rows — OP-96 `0148` from main
and this lane's `0180`); prettier was clean afterwards.

Review record: the PR body comment
[#233 (comment)](https://github.com/yahodu/openpic-webapp/pull/233#issuecomment-6335672170)
and the inline comment on the I4 line
[#233 (discussion)](https://github.com/yahodu/openpic-webapp/pull/233#discussion_r4345826028).

### 2. Verdict: APPROVED WITH FINDINGS

The acceptance criteria are verified as met and pinned:

- **OTP types never appear.** I7 pins it at both layers (the feed and the
  unread count), and the exclusion is derived from the catalogue's
  `channelGroups.in_app.enabled === false` types rather than from a hard-coded
  key list.
- **The unread count plans `idx_user_unread`.** I4's `explain` pins the partial
  index on the count query.
- **An unchanged state is a bodyless `304`.** I5 pins the weak-ETag
  conditional-request path.
- **Ownership is enforced server-side in the query predicate** on all three
  mutations (read-all, single read, delete), so a foreign id is `404` — never
  `403`, which would be an existence oracle.

The verdict is "with findings" only because five observations are owed to
follow-up cards (§3); none of them changes the shipped contract behaviour, and
none was a reason to hold the merge. No changes were requested on PR #233 and no
reviewer edit landed in the deliverable.

### 3. Findings routed to follow-up cards

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                        | Routed to               |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| F1  | Medium   | The I4 pin is **lane-owned flaky**: 200 sequential inserts plus an `explain` land at ~5.0 s = vitest's default `testTimeout`, and the failure mode is a timeout, so it can redden the trunk while masking a real plan regression. The handoff's "unrelated 5 s timeouts" attribution was incomplete.                                                                                           | **`t_e9c96d6a`** (TEST) |
| F2  | Medium   | The fan-out **subject re-add is general but pinned only for `account.welcome`**: the rule applies to every type whose `dedupe.keyTemplate === null` (only two seeded types carry a dedupe-key template), yet only PRE-1 and E1 exercise it. Nothing pins a second dedupe-free type with `actorRef === subjectRef`, nor the exclusion half for a dedupe-carrying type.                          | **`t_e9c96d6a`** (TEST) |
| F3  | Low      | The **feed can list a row the badge has already dropped**: the feed bounds only `createdAt` while `summarizeUnread` also requires `expireAt > now`, so a TTL-expired row not yet swept by the ~60 s monitor appears in the feed and in `filter=unread` while `summary.unreadCount` excludes it (`expireAt` divergence).                                                                        | **`t_e9c96d6a`** (TEST) |
| F4  | Low      | Contract §7.2's ETag example is a **strong tag** while the endpoint emits the weak `W/"…"` that I5 pins; [ADR-0131](ADR-0131-op97-in-app-feed-read-state-unread-count-red.md)'s "exactly the two `auth.otp.*` keys" parenthetical is inaccurate (the derivation yields five `in_app:false` types, as ADR-0180 §2 records); and `filter=unread`'s restriction to `readAt: null` is un-recorded. | **`t_ee19ef3a`** (DOCS) |
| F5  | Info     | No rate-limit stage is bound on the five routes. This matches the repo-wide convention (19 of 20 route files bind none) and is already accepted as ADR-0132 F6, so it is **not a regression** here; recorded for the board, no action.                                                                                                                                                         | no action (Info)        |

F4 is deliberately routed to the docs card rather than fixed here: the ADR index
must stay byte-identical in that card, and no new ADR number is consumed by it.

### 4. The two ADR-0180 open items — now the Test Author's

ADR-0180 left two items open for the Test Author; this review confirms both are
real and hands them to `t_e9c96d6a` unchanged:

1. **The actor/subject layer split and the dedupe scoping.** PRE-1's fixture
   collapses actor and subject, which the pinned `resolveRecipients` (U2) maps to
   an empty recipient set; the GREEN satisfies the pin by re-adding the subject
   at the consumer, scoped to dedupe-free types so E1's fresh-signup badge stays
   at exactly one row. Both the layer split and the dedupe scoping are
   assumptions the Test Author should confirm or re-pin — this is exactly the
   unpinned generalisation F2 names.
2. **The OTP-exclusion parenthetical.** ADR-0131's "exactly the two
   `auth.otp.*` keys" does not match the seed's five `in_app:false` types. The
   implementation is correct (it follows the derivation); the ADR wording is what
   is wrong, and it is fixed by F4's docs card `t_ee19ef3a`.

## Consequences

- OP-97 phase 1 is **closed**: the feed, the read-state mutations and the
  unread-count hot path are verified, merged (`f95c50f`) and recorded. ADR-0131
  stays authoritative for behaviour; ADR-0180 records the implementation; this
  ADR records the acceptance.
- Number `0181` is consumed by this sign-off; the OP-97 lane's `Next free` cell
  in `docs/adr/README.md` advances to `0182`. No number outside the lane's
  `0180`–`0199` range is touched.
- This is a **docs-only** record: no production, test, fixture or configuration
  file is touched, so no suite's observable behaviour changes.
- The findings are routed, not buried: `t_e9c96d6a` (TEST) carries F1–F3 and the
  two ADR-0180 open items, and `t_ee19ef3a` (DOCS) carries F4. F5 needs no card.
- The `docs/adr/README.md` edit is a single inserted index row plus one advanced
  lane cell. That file is a cross-lane hotspot; the row is inserted in
  ascending-number position and its title is kept short so prettier does not
  widen the title column and re-pad every row.

## Alternatives considered

- **Record this sign-off as a section inside ADR-0180.** Rejected: ADR-0180 is the
  _implementation_ record and ships inside PR #233; the acceptance of the merged
  tree is a distinct artifact, and every prior sign-off in this lane family
  (ADR-0132, 0200) is recorded as its own file.
- **Leave the findings as PR comments only.** Rejected: the repo's operating
  rules require every review finding to be routed to a card, and the I4 flake and
  the unpinned fan-out generalisation are both things a later lane must act on.
- **Request changes on PR #233.** Rejected: none of the findings touches the
  shipped contract behaviour, and blocking a verified, CI-green implementation on
  follow-up pins would hold the lane open for no behavioural benefit.
- **Fix F4 (contract §7.2 + ADR-0131 wording) in this card.** Rejected: it is
  already owned by `t_ee19ef3a`, and folding it in here would make this record
  touch files outside its stated scope and risk a number/row collision in the
  shared ADR index.
