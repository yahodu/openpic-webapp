# ADR-0044 — OP-89 identity-lifecycle indexes/TTLs follow-up: review sign-off

- **Status:** Accepted (review sign-off) · **Date:** 2026-10-06
- **Card:** OP-89 `t_5e541eaa` (phase 1-Identity, epic Authentication, follow-up) · **Amends:** ADR-0043 (records that its claims are enforced; does not supersede it)
- **PR / branch:** `OP-89-task-identity-indexes` (PR #162), base `main` @ 601b4d5
- **Review lens:** artifact (round 1 — no prior `changes_requested`)

## Context

ADR-0043 declared the missing `INDEX_SPECS` entries for the identity-lifecycle
collections (`sessionDevices` index + TTL, `contactChangeFanouts` TTL,
`userProfiles` schema §13.2 indexes) and bounded the new-device read. This ADR
records the independent review at head `b00152b`, the verdict, and the residual
findings. Per AGENTS.md §3.3 the reviewer did **not** edit the implementation;
findings are routed as follow-up cards.

## Verification reproduced (not just read)

- `./node_modules/.bin/vitest run --project unit` — 1319 passed / 67 files.
- `TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project integration`
  — 225 passed / 34 files.
- `tsc` (root, packages/contracts, apps/web) clean; ESLint 0 errors (20
  pre-existing warnings, none in the changed files); Prettier clean.
- PR #162 checks: ci, lint, unit_test, test_coverage, env-changes, secret-scan,
  validate-branch-name, validate-pr-title, CodeQL — all pass.
- Contract audit: the hook emits no new/altered event keys; the flags-only
  payload, the transient fan-out record and the `identity_hook.*` log keys are
  unchanged. The only hook change is the read predicate and the added `expireAt`.
- Honesty audit: no fixture-shaped hardcoding, no test-environment conditionals,
  no `@ts-ignore`/lint suppressions, no debug output, no test edits.

## Decision

**APPROVED WITH FINDINGS, merged to `main`.** All three acceptance items are
satisfied: `INDEX_SPECS` declares the three collections' indexes, the full suite
is green with no hook behaviour change, and ADR-0041 §4 is backed by a real
unique `{userId: 1}` index (the implementer's chosen route — the ADR is left
unedited per the immutable-ADR policy, and ADR-0043 §4 documents the enforcement).

Residual findings (none blocks the merge):

1. **Low — the new TTL/index declarations and the bounded read are unpinned.**
   `index-bootstrap.test.ts` I1 asserts `created` equals `INDEX_SPECS` (a
   self-referential comparison), and `indexes.test.ts` only lints spec _shape_;
   so a regression that removes the `sessionDevices` TTL, the
   `{userId:1,createdAt:-1}` index, the `contactChangeFanouts` TTL or the
   `userProfiles` unique index fails nothing. → routed to a Test Author card.
2. **Low — the 100-sighting read cap can theoretically drop an in-window prior
   sighting** (a user with >100 sightings in 24 h whose matching device is not in
   the 100 newest), yielding a duplicate `auth.signin.new_device`. The per-device
   24 h-bucket `dedupeKey` is the backstop, and ADR-0043 §2 documents the cap; the
   ADR's own coverage-gap list names it. → covered by the same Test Author card.
3. **Medium (coordination) — ADR numbering collision.** The sibling RED-pins
   branch (`t_7ce3d03c`, draft PR #163) also claims `ADR-0043`. Whichever side
   merges second must renumber. This branch merged first with ADR-0043, so the
   RED ADR must be renumbered at GREEN time (`t_42a91a52`), and any new ADR here
   starts at 0045. → comment on `t_42a91a52`.
4. **Ops note — the unique `userProfiles.userId` index is a migration.**
   `ensureIndexes` only adds; if any environment already holds duplicate
   `userProfiles` rows for one `userId`, the index build fails. The hook's
   `updateOne(..., {upsert:true})` write path is consistent with the index, so
   only pre-existing bad data can break it. → flagged for the operator; no code
   change.

## Consequences

- The three High/Medium production defects from ADR-0042 findings 1–3 are closed
  on `main`; ADR-0040 §2's TTL-bound PII justification now holds.
- A future regression removing any of the seven new specs is silent until the
  coverage-gap card lands; that card is the fix.

## Alternatives considered

- **Block on the Low findings.** Rejected: no Critical (security/honesty) finding
  exists; the residual items are coverage gaps and a deploy-time note, all routed.
- **Reviewer edits the implementation or the tests.** Rejected: AGENTS.md §3.3 and
  the review skill preserve the boundary; test changes require a Test Author card.
