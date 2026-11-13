# ADR-0797 — OP-132 TEST: the failed-purge retry and the purge/reference race are pinned at the invariant

- **Status:** Accepted (RED / executable contract)
- **Consumers:**
  `apps/web/src/test/integration/liveness-selfie-submit.test.ts` — the two
  appended cases (`:1074` P1, `:1133` P2) and their local readers
  (`PurgeLedgerRow`, `assetByHash`, `selfieBytesReadable`, `recordsPendingPurge`).
- **Lane:** the shared attendee block `0780`–`0798`
  (row `OP-129 attendee identity lane`). [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)
  advanced the lane's `Next free` cell to `0797`; re-read at the branch cut from
  `origin/main` `f2bf527`, then swept: `docs/adr` on the trunk (highest `0796`),
  every `.worktrees/*/docs/adr` (highest `0796`) and every open `OP-13x` PR head
  (`#539`, `#545`, `#547` — highest `0794`) hold no `0797`, so this record takes
  it and the cell moves to `0798`.
- **Amends:** [ADR-0796](ADR-0796-op132-selfie-asset-owner-expiry-purge.md)
  §Consequences "Known gap, routed (F-A2, High)" — the pin that closes it — and
  §3's `shortcut:` (the release/delete window), which is now pinned.
- **Consumes:** `0797`.

## Context

The round-2 review of the OP-132 GREEN (`t_fb098cce`, PR #546, squash `90110ee`)
found **F-A2 (High)**, measured with a throwaway probe: `DELETE …/consent`
deletes the `selfies` and `faceMatches` rows _before_ it releases the asset
references and deletes the blob
(`apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts:322-329`). A transient
object-store failure therefore re-creates the original F1 defect — an orphaned
biometric object — and destroys the only pointer to it:

```
PROBE_RESULT {"firstStatus":500, "selfiesAfter":0, "assetRefCount":0,
              "withdrawnRows":0, "readableAfter":38,
              "secondStatus":204, "readableRetry":38}
```

The retry derives its references from the `selfies` rows, which are already
gone, finds none, and answers `204` with nothing pointing at the object any more.
ADR-0796 §3 records a second, related gap as a `shortcut:`: the reference
release and the object delete are two calls, so a submit that re-references the
hash between them loses its blob.

This card (`t_c146a82e`) is **pins only**: no production change, no edit to an
existing case, fixture or helper. The GREEN sibling `t_0f7341d7` fixes the
defect; `t_26ab6dd7` keeps ownership of the two-reference/`refCount: 0` erasure
arm and the retention window, which this record does not restate.

## Decision

### 1. P1 pins the _invariant_ — "no orphan" — not the repair's shape

After a withdrawal whose `deleteObject` rejected once
(`vi.spyOn(getObjectStorage(), "deleteObject").mockRejectedValueOnce(…)`, then
`mockRestore()`) and a second withdrawal against a healthy port, the case asserts
the **final** state: either the bytes are gone
(`getObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash))` rejects `not_found`), or
the `mediaAssets` row is a durable purge candidate — `refCount: 0` **and**
(`status: "purged"` or a `purgedAt` date) — that a sweep can act on, without the
deleted `selfies` rows. Both branches are satisfiable (see §5) and ADR-0796 §3
already forbids deleting the row, so the pin does not choose between a
rollback/reorder repair and a purge-ledger repair. The retry's own contract is
pinned unchanged: `204` plus `X-Deleted-Counts`.

The counts are read as a **format**
(`/^selfies=\d+;embeddings=\d+;matches=\d+$/`), never as fixed numbers, because
they state what _that attempt_ deleted: a rollback-based repair retries with the
rows in place (`selfies=1`), a purge-candidate repair finds them already deleted
(`selfies=0`). Pinning `selfies=0` would forbid the rollback; pinning `selfies=1`
would forbid the ledger. Both are complete erasures, which is the property at
stake.

### 2. P2 pins "a reference must not outlive its object", not "the bytes stay readable"

The card asked for the bytes to stay readable when a second attendee's submit of
the same bytes lands inside the `deleteObject` stub. **That branch is not
satisfiable** and this record says so instead of shipping a pin no correct fix
can pass: at the moment the stub runs, the withdrawal has already committed to
the purge, and no implementation can un-ask that call. The only two achievable
outcomes are "the purge is skipped" (bytes readable) and "the losing submit is
deflected" (not `202`). Pinning only the first hides a correct claim-based
repair; pinning only the second hides the orphan. The case therefore pins the
disjunction that _is_ the defect:

```
second submit answered 202  ∧  bytes gone   →  fail
```

i.e. a submit that was told `202` must still find its bytes. It also asserts
`interleaved` — that the withdrawal really reached the object delete — so a
deferred-purge implementation cannot make the race window vacuous. (`interleaved`
is a reader on this case's own seam, not a call count on the mock.)

**Measured, and handed to the GREEN as an open question:** under a faithful
claim-based repair the losing submit answered **`500`** (the
`(tenantId, contentHash)` unique index rejecting the upsert of a `purged` row —
the `E11000` the reviewer's Low note predicted). That satisfies this pin (no
dangling reference) but it is not a good answer, and the API contract has no code
for it. A clean `4xx` is the GREEN's decision, recorded in §Open questions; the
pin deliberately does not dictate it.

### 3. Determinism, not luck

- The transient failure is injected through the storage **port** the route
  resolves (`getObjectStorage()` memoizes the memory adapter), so the case
  measures the route's real call, and `mockRestore()` runs before the retry so a
  failed assertion cannot leak the stub.
- The second submit is driven **synchronously inside** `deleteObject`, so the
  two operations cannot interleave differently on another machine: there is no
  timer, no polling and no second process.
- `afterEach` already calls `vi.restoreAllMocks()` in this spec; the case also
  restores explicitly before its assertions.

### 4. Deliberately not pinned

- **The `status` of the surviving `refCount: 0` row after a successful purge.**
  §16.1 carries both `stored` and `purged`, and ADR-0796 §3 keeps the row on
  purpose (the OP-131 case pins it surviving). Whether it moves to
  `purged`/`purgedAt` is the GREEN's record; P1 accepts the marker as a second
  branch but nothing requires it, so the info arm of the card is recorded here
  instead of asserted.
- **Two concurrent submits of one hash.** A `Promise.all` of two submits lands
  in the driver's `WriteConflict`/`E11000` path with no synchronous seam to pin;
  a spec built on that ordering is flaky by construction and would redden a
  correct implementation. P2 already pins the same `mediaAssets` accounting with
  a deterministic interleaving.

### 5. Satisfiability was probed, not assumed

Two throwaway repairs on `consent/route.ts` (+ `selfie-submit.ts` for the
second), `git checkout --`-restored and hash-verified (`1e2c026d…`,
`7246b17b…`, `git diff` empty):

| probe                                                                                           | P1    | P2      | the 19 frozen cases |
| ----------------------------------------------------------------------------------------------- | ----- | ------- | ------------------- |
| purge-candidate on a failed delete (`status: "purged"` + `purgedAt`, rethrow)                   | green | **red** | 19 green            |
| + claim `status: "purged"` before the delete, and refuse a `purged` row in `insertQueuedSelfie` | green | green   | 19 green            |

The first row is the evidence that P1 and P2 are independent arms: the natural
F-A2 repair turns P1 green and leaves P2 red.

## Consequences

- The GREEN has one sentence to satisfy per arm: after a failed purge and a
  retry there is no object nobody points at, and a `202` submit never ends up
  pointing at bytes a withdrawal deleted.
- The withdrawal may answer `500` on the first attempt (a transient failure is
  allowed to be reported); what it may no longer do is report the _retry_ as a
  completed erasure when nothing can reach the object.
- A ledger-based repair keeps the `404`-freedom of the current route, and a
  claim-based repair has to decide how a submit that loses the race is answered
  (§Open questions).
- `docs/adr/README.md` stays the shared-ledger hotspot: this row plus the
  `0797`/`0798` cell merge as a union keeping the highest value.
- No number outside `0780`–`0798` is touched.

## Alternatives

1. **Pin `500` on the first attempt.** Rejected: it dictates the repair's
   shape. A withdrawal that defers the purge to a durable candidate may
   legitimately answer `204` on the first attempt; the existing F1 pin
   (`:914`) already requires the _successful_ path to delete synchronously, which
   is the only ordering constraint the contract has.
2. **Pin `selfies=0` (or `selfies=1`) in the retry's `X-Deleted-Counts`.**
   Rejected for the reason in §1: it forbids one of the two complete repairs.
3. **Pin the second submit's status instead of the dangling reference.**
   Rejected: it would let a repair answer `202` and still delete the bytes.
4. **Drive the race from a `setTimeout` or a second connection.** Rejected: the
   interleaving would then be a race the scheduler decides, which is the
   flakiness the card forbids.

## Open questions (for the GREEN `t_0f7341d7`)

1. **How is the losing submit answered** when it re-references a hash whose
   purge is claimed? Measured today: `500` (the unique index). A `409` with a
   retry hint and a documented code would be the good answer; the contract has
   no code for it yet.
2. **Which branch does the repair take** — purge candidate (row marked, sweep or
   retry acts) or rollback/reorder (rows survive the failure)? The pins accept
   either; the ADR of the repair must name it, per the card.
3. **Does the surviving `refCount: 0` row move to `purged`/`purgedAt`** after a
   successful purge? If yes, P1's second branch becomes redundant rather than
   wrong, and a later card can tighten it.
