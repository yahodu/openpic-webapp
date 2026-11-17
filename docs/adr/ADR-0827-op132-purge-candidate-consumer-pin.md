# ADR-0827 — OP-132 TEST: the durable selfie purge candidate is consumed, not merely recorded

- **Status:** Accepted (one appended characterization pin; no production change)
- **Consumers:** `apps/web/src/test/integration/liveness-selfie-submit.test.ts`
  — the appended case ("when a withdrawal's purge failed and the attendee
  retries" › _consumes the pending purge candidate, so the bytes are gone after
  the retry_). No new reader: it reuses the F-A2 block's `PurgeLedgerRow`,
  `assetByHash`, `selfieBytesReadable` and `recordsPendingPurge`.
- **Lane:** the shared attendee block `0780`–`0798` (row
  `OP-129 attendee identity lane`) is exhausted, so this record draws from the
  `unallocated (future lanes)` pool. Both `Next free` cells read `0827` at this
  cut (`origin/main` `d497d87`, the squash of PR #593); the highest number
  `git rev-list --objects --all -- docs/adr` returns is `0826`
  (`ADR-0826-op132-retention-window-and-zero-reference-purge-pins.md`, the
  trunk's newest record), no `.worktrees/*/docs/adr` carries `0827`, and the 16
  open PR heads stop at `0825`. So this record draws **`0827`** and both cells
  advance to `0828`. No lane row is minted and no range is re-cut.
- **Amends:** [ADR-0797](ADR-0797-op132-failed-purge-retry-pin.md) §1 (P1 pins a
  _disjunction_ — this record pins the branch past it) and
  [ADR-0798](ADR-0798-op132-purge-before-delete-claim.md) §Consequences "Known
  gap, routed" (nothing consumed a candidate whose withdrawal was never
  retried — that consumption is now pinned). Neither record is edited.
- **Consumes:** `0827`.

## Context

ADR-0797 §1 pins **P1** as a disjunction. After a withdrawal whose
`deleteObject` rejected once and a second withdrawal against a healthy port, the
bytes are gone **or** the `mediaAssets` row is a durable purge candidate
(`refCount: 0` and `status: "purged"`/`purgedAt`). The round-2 review of those
pins (card `t_c146a82e`, finding **F2**) probed the disjunction with a
"purge-candidate" repair — stamp `status: "purged"` + `purgedAt` on the failed
delete and rethrow — and measured `P1 green, bytes still readable, the 19 frozen
cases green`. The marker alone satisfied the pin.

That is the F-A2 class the pin exists to close, one level down: a marker nobody
acts on is a marker on an orphan, and the biometric blob stays readable for good.
At the time of the review nothing consumed the marker — `grep -rn 'purged'` found
no sweep and no queue entry — so P1's second branch could be satisfied by a repair
that never erases anything.

The GREEN `t_0f7341d7` has since landed as
[ADR-0798](ADR-0798-op132-purge-before-delete-claim.md), which decides the
question ADR-0797 §Open question 2 left open: it **claims** the row atomically
with the last release (`refCount: 0`, `status: "purged"`, `purgedAt: null`),
deletes the object, **then** stamps `purgedAt`, and only then deletes the
`selfies`/`faceMatches` rows. §1 states the consumer explicitly: _"There is no
queue entry and no sweep — the withdrawal retry **is** the consumer"_. Measured
at this head, that is still the only reader of the claim:
`apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts` claims and stamps, and
`apps/web/src/server/attendee/selfie-submit.ts` reads the in-flight claim to
answer `409 selfie_purged`. No sweep exists.

## Decision

### 1. The consumer the record names is pinned by driving it

One appended case reproduces the state a failed purge leaves through the real
path — a confirmed selfie, one `deleteObject` rejection injected through the
storage port the route resolves, so the withdrawal fails mid-purge — and then
sends the retry, which ADR-0798 §1 names as the consumer. It then requires the
candidate to be **consumed**: the retry answers `204`, and
`getObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash))` no longer answers bytes.

No sweep entry point is pinned, because the shipped record has none and a pin on
an endpoint that does not exist would be a pin no implementation can pass. If a
later record introduces a sweep, that endpoint gets its own pin.

### 2. The seed is asserted, so the case cannot pass on a state it never reached

Before the retry the case asserts the seed it claims: `recordsPendingPurge(row)`
is true (the §16.1 candidate shape ADR-0797 §1 accepts), the bytes are still
readable, and **`purgedAt` is still `null`**. The third assertion is the
interesting one: it pins ADR-0798 §1's ordering — the completion mark must not
precede the object delete — so a repair that stamps `purgedAt` on a _failed_
delete (the reviewer's probe, i.e. a marker on an orphan) reddens here with a
message that names the defect instead of passing.

The seed is the record's claim shape on purpose. A repair that records the
pending purge in a _different_ shape must update this assertion together with
ADR-0798 §1; that coupling is the price of pinning "the row that is consumed is
the row the record leaves behind".

### 3. P1 is **not** widened — the queue-entry arm is not applicable

The card allowed a third candidate ("…or a queue entry") and this card's item 2
asked to widen `recordsPendingPurge` **only** if the GREEN's record took a
queue-entry repair. It did not: ADR-0798 §Alternative 2 rejects a queue entry in
so many words ("ADR-0797's P1 second branch reads only the `mediaAssets` row, so
a queue-only repair stays red; the card text allowed it, the pin does not"), and
§1 states there is no queue entry and no sweep. Widening the pin now would
forbid a shape the record deliberately did not build and would weaken the
candidate check for a mechanism that does not exist. So `recordsPendingPurge` and
P1 are left exactly as they are, and no existing case, helper or fixture was
edited.

For the same reason the rollback/reorder-only arm (card item 3) needs no separate
case: ADR-0798 already orders the purge before the rows, and the retry is still
what finishes a failed purge, so the consumer arm is the applicable one. The
"not applicable" verdicts are recorded here rather than as new cases.

### 4. The case also requires the completion mark, because it is observable

After the retry the case asserts `purgedAt instanceof Date`. This is not a shape
preference: ADR-0798 §2 scopes the `409 selfie_purged` deflection to
`status: "purged"` **and** `purgedAt: null`, so a consumed candidate that never
stamps `purgedAt` leaves every later submit of those bytes deflected forever.
The two assertions are independent: mutation M2 below reddens only the stamp one.

### 5. Measured, not argued

The case is **green on arrival** — the repair already consumes the candidate —
so there is no GREEN sibling and the PR is a normal green test PR, not a draft.
On the shipped tree the file goes `23 → 24` cases (`24 passed (24)`). Two
throwaway mutations on `consent/route.ts`, each restored byte-identically
(`sha256 6611d672…` before and after, `git status` clean apart from the spec),
show that each assertion bites on its own:

| probe                                                           | result                       | red text (abridged)                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 — claim filter `refCount: {$lte: count}` → `refCount: count` | `1 failed \| 23 passed (24)` | _…left the selfie object `originals/selfies/<hash>` readable although the failed attempt had left the mediaAssets row a purge candidate: nothing consumed the candidate (the first attempt answered 500, the retry 204): expected true to be false_ |
| M2 — drop `$set: {purgedAt: now}` after the delete              | `1 failed \| 23 passed (24)` | _the retry erased the bytes but left `purgedAt: null`, so the row still records an in-flight purge and every later submit of these bytes is deflected (ADR-0798 §2): expected null to be an instance of Date_                                       |

M1 is the arm this record exists for, and it is the discriminating measure the
review asked for: under M1 the retry finds nothing to re-attempt, the row still
reads as a candidate and the bytes stay readable — **P1 stays green** (all 23
frozen cases pass) while this case reddens alone. That is the F2 gap, now closed
by executable contract rather than by prose.

## Consequences

- The GREEN of P1's disjunction can no longer be satisfied by a marker alone: the
  candidate must be consumed, and the consumption must be observable as missing
  bytes plus a completion mark.
- The retry is the contract's only purge consumer. A repair that instead defers
  the purge to a sweep or a queue entry will redden this case (correctly: nothing
  in the record consumes those) and must add its own consumer pin in the same PR.
- The seed assertion couples this case to ADR-0798 §1's claim shape. That is
  deliberate and documented in §2.
- `docs/adr/README.md` stays the shared-ledger hotspot: this row, this note and
  the two cells merge as a union keeping the higher cell (`0828`).

## Alternatives

1. **Pin a sweep entry point instead of the retry.** Rejected: no sweep exists
   and ADR-0798 §1 says so; a pin on a missing endpoint measures nothing.
2. **Widen `recordsPendingPurge` to accept a queue entry.** Rejected: the record
   rejected a queue entry (§3 above); the widening would pin a mechanism the
   codebase does not have.
3. **Assert only "the bytes are gone" and drop the seed assertions.** Rejected:
   the case would then pass on a withdrawal that deleted the object before the
   failure was ever injected, i.e. on a state the F2 probe never reached.
4. **Pin the first attempt's status (`500`).** Rejected: ADR-0798 §Open questions
   leaves a softer status open and unpinned; the case reads the first attempt's
   status only in its failure messages.

## Not pinned here

- **A candidate whose withdrawal is never retried.** Nothing consumes it until a
  sweep exists; that is a known gap in ADR-0798 §Consequences, not a defect this
  card can pin without an entry point.
- **The `409 selfie_purged` deflection itself** (`selfie-submit.ts`). It is the
  in-flight-claim side of the same window and belongs to the submit lane; this
  card's scope is the failure arm only.
- **The retry's `X-Deleted-Counts` numbers.** ADR-0797 §1 pins the header as a
  format on purpose; this case does not re-pin it.
