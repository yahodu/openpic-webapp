# ADR-0095 — OP-94 fan-out polish review sign-off

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_3b8e846d` (OP-94 Low polish review) · **PR:** #190 (merged as `5ec8633`)
- **Reviews:** ADR-0094 (polish implementation), ADR-0093 (GREEN review sign-off)
- **Findings origin:** ADR-0093 `eslint-unbound-method-scope`, `serial-recipient-reads`, `groupChannel-mobile-fallback`

## Context

The OP-94 Low-severity polish (PR #190, branch `OP-94-task-fan-out-polish`, fresh
from `origin/main` @ `2c42fe1`) addressed the three findings routed from the OP-94
GREEN review. The reviewer lane independently verified all three items on the
exact head `cefd481` rather than trusting the handoff, using a round-1
artifact-plus-execution lens.

## Review evidence (independently reproduced)

- Focused unit `fan-out` 15/15; full unit project 78 files / 1438; full
  integration project 39 files / 294 (`TMPDIR=/root/tmp-mongo`).
- `eslint .` 0 errors (37 pre-existing `security/*` warnings); `prettier --check`
  clean; `tsc` root + contracts + web clean; PR checks 11/11 pass.
- Diff contains no test, mock, fixture or factory edit (5 files: `eslint.config.mjs`,
  `fan-out.ts`, `resolve-channel.ts`, ADR-0094, `docs/adr/README.md`).
- **Item 1 (eslint scope):** re-enabled `@typescript-eslint/unbound-method` via CLI
  `--rule` across the whole repo (`eslint . --rule ... -f json`, parsed
  programmatically) — exactly two files trip it (`fan-out.test.ts` 8 sites,
  `notification-fan-out.test.ts` 1 site). The scoped `files` list in the new
  flat-config block is therefore complete, and the guard is restored for every
  other spec, `**/test/**`, `**/mocks/**`, config, e2e and production.
- **Item 2 (parallel reads):** `loadRecipientContext`'s three `findOne`s and
  `processEvent`'s `getPlatformSettings`+`loadTemplates` are independent;
  `Promise.all` preserves results and rejection propagation. No pin observes
  ordering.
- **Item 3 (mobile skip channel):** traced reachability — `processEvent` iterates
  only `group.enabled` groups (`fan-out.ts:946-947`) and `channelGroupSchema`
  requires an enabled mobile group to declare ≥1 candidate
  (`notification-types.ts:76-82`). The changed fallback expression is therefore
  unreachable for every schema-admitted input; behaviour is preserved and the
  literal divergence is removed. No seed type hits the path.

## Decision

- **APPROVED WITH FINDINGS.** PR #190 squash-merged to `main` as `5ec8633`; local
  `main` synced to `origin/main`.
- **One Low coverage gap routed to the Test Author:** no pin asserts the channel
  recorded for a pre-selection mobile skip when a mobile group declares no
  `candidates`. Because the branch is defensively unreachable today it is not a
  blocker, but it is the natural regression guard for item 3's alignment.
  New RED card `t_9e63f809` (`openpic-webapp-testcase-writer`, child of
  `t_3b8e846d`) pins the fallback to `DEFAULT_MOBILE_CANDIDATES[0]`.
- **Informational:** ADR-0094's Context describes all three items as
  "behaviour-preserving"; item 3 does change a persisted value (`sms`→`whatsapp`)
  in the unreachable branch. ADR-0094's Consequences section discloses this
  accurately — no action required beyond the pin above.

## Consequences

- The OP-94 fan-out polish is on `main` (`5ec8633`); the `unbound-method` guard is
  narrower and the recipient/settings reads overlap.
- The mobile skip-channel alignment is locked by a schema-contract pin once
  `t_9e63f809` (RED → GREEN) lands. If the Test Author cannot reach the branch
  without widening the public contract, the card instructs them to report back
  rather than export `groupChannel`.

## Alternatives

- **Block on the unpinned item-3 change.** Rejected: the branch is unreachable for
  all schema-admitted inputs, so no observable behaviour changed; a coverage gap
  is routed instead.
- **Skip the sign-off ADR.** Rejected: the repo's established pattern is a
  reviewer sign-off ADR per lane (ADR-0086, 0087, 0089, 0091, 0093).
