# ADR-0110 — OP-89 follow-up: residual stale ADR-0043 production citations redirected to ADR-0045 §1/§3

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-89 follow-up production-comment cleanup (`t_5b56e338`, backend lane; raised by the review of `t_6803883d`, PR #179)
- **Relates to:** [ADR-0045](ADR-0045-op89-followup-red-idempotency-2fa-transition-and-surface-seams.md) §1 (re-run idempotency) and §3 (surface adapters), [ADR-0043](ADR-0043-op89-identity-lifecycle-indexes-ttls.md) (the indexes/TTLs record the stale citations wrongly pointed at), [ADR-0066](ADR-0066-op89-identity-indexes-test-reference-renumber.md) (the predecessor of this cleanup class), [ADR-0070](ADR-0070-op91-followup-deletion-requested-red.md) (the `account.deletion.requested` record the citations correctly also name)
- **Schema:** n/a · **Contract:** n/a (production comment text only)

## Context

ADR-0066 redirected the stale `ADR-0043 §3` **test** citations to ADR-0045 §3 and, in
its Consequences, flagged the two remaining **production** comments
(`identity-hooks.ts` L719 `(ADR-0043 §1)` and `identity-lifecycle.ts` L120
`(ADR-0043 §3)`) for a production-lane follow-up. That follow-up was PR #179
(`t_6803883d`, merged to `main` as `229a64c`), whose card body locked the diff to
**exactly two lines**, so three further production comments — created by later
lanes and therefore not in scope then — were deliberately routed to this card.

Verified against `main`@`229a64c`, ADR-0043 records only the identity-lifecycle
index/TTL declarations: §1 is the `COLLECTIONS` registration, §2 the
`sessionDevices` bound, §3 the `contactChangeFanouts` TTL index. It does **not**
record either the dedupe/re-emit scheme or the section 4–6 endpoint seam, so the
three citations below misdirect a reader. The correct targets are:

- the instant-derived dedupe / re-emit scheme → **ADR-0045 §1** ("Re-run
  idempotency — a redelivered hook emits exactly once"); the
  `account.deletion.requested` emit also correctly cites ADR-0070.
- the `createIdentityLifecycleSeams` surface seam (incl. `sessionsRevoked` and
  `deletionRequested`) → **ADR-0045 §3** ("Surface adapters — one seam per
  remaining section").

## Decision

Redirect exactly three production comments; **no behavioural change** (comment
text only):

1. `apps/web/src/server/auth/identity-hooks.ts` — the `handleDeletionRequested`
   dedupe/re-emit JSDoc: `(ADR-0043 §1, ADR-0070)` → `(ADR-0045 §1, ADR-0070)`.
   Only the `§1` half changes; ADR-0070 is correct and stays.
2. `apps/web/src/app/api/v1/me/sessions:revoke-all/route.ts` — the
   `createIdentityLifecycleSeams().sessionsRevoked` seam citation:
   `ADR-0043 §3` → `ADR-0045 §3`.
3. `apps/web/src/app/api/v1/me/deletion/route.ts` — the
   `handleDeletionRequested` counterpart of the revoke-all emit:
   `(ADR-0043 §3, ADR-0070)` → `(ADR-0045 §3, ADR-0070)`. Only the `§3` half
   changes; ADR-0070 stays.

The `identity-hooks.ts` `(ADR-0043)` (L78) and `(ADR-0043 §2)` (L90) citations and
the three `apps/web/src/server/db/indexes.ts` citations are correct (the
`sessionDevices` read cap / TTL and the index declarations) and are **not**
redirected. The remaining stale citation on the TEST side
(`apps/web/src/test/integration/me-sessions-and-deletion.test.ts:61`) belongs to
the Test Author lane and is a separate sibling card. The `ADR-0043 §3` prose
inside accepted ADRs is a historical record and is out of scope.

## Numbering

Resolved as the lowest free `ADR-0nnn` against a fresh `origin/main` at write
time: `main`@`229a64c` was dense through **ADR-0109**, so this record took
**0110**; the file was checked against every branch and ref for an existing
`ADR-0110`/`ADR-0111` before committing (none). Central cross-lane ADR allocation
remains owned by the orchestrator; if a sibling lane claims `0110` first this
record renumbers to the lowest free number on the merged tree, unchanged in
content — the same procedure ADR-0066 records.

## Consequences

- A reader following any of the three citations now lands on the ADR that
  actually records the behaviour (dedupe → ADR-0045 §1; surface seam →
  ADR-0045 §3), instead of the index/TTL record.
- No behavioural change: only comment text differs, so the full unit/integration
  suites, typecheck, lint and Prettier stay green (comment-only diff).
- The reference is documentation only and is not enforced by an automated guard,
  as ADR-0034 and ADR-0066 also noted; a future ADR renumber must sweep these
  citations again.

## Alternatives considered

- **Leave the stale citations.** Rejected: ADR-0043 §1/§3 record unrelated
  behaviour, so the citations actively mislead.
- **Also redirect the test-side citation here.** Rejected: test files are the
  Test Author's jurisdiction; the sibling card handles it.
- **Rewrite the `ADR-0043 §3` prose inside the accepted OP-91/OP-94 ADRs.**
  Rejected: accepted ADRs are immutable historical records (see
  `docs/adr/README.md`), explicitly out of scope for this cleanup.
