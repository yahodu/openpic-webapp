# ADR-0834 — OP-135 TEST: four pins on the internal worker boundary

- **Status:** Accepted (RED pins; the draft PR that carries them must **not** be squash-merged —
  OP-93/ADR-0306. The GREEN card `t_b4a1ee9c` carries the cases forward unchanged)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose own
  `Next free` cell read **`0834`** at this base. The sweep immediately before minting found no
  `ADR-0834*` file in any `.worktrees/*/docs/adr`, `git rev-list --objects --all -- docs/adr`
  (with all sixteen open PR heads fetched into `refs/remotes/pr/*`) returns nothing at `0834`, and
  the newest object on any ref is `0833` (this lane's own GREEN). So this record takes **`0834`**
  and advances **only** that cell to `0835`; both `unallocated (future lanes)` cells stay `0849`
  and no range is re-cut. The one open head carrying an `08xx` record is PR #622
  (`OP-136-task-job-sweeps-red`), whose ADR files are `0830`/`0831` — read-only references to this
  lane, not new numbers.
- **Consumes:** [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §4–§5 (the report and
  derivative wire shapes), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §4, §6, §7
  (the lease arm, the derivative key derivation, the batch cap it left unpinned),
  [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md)/[ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md)
  (the arm these pins harden), contract §0.15 (object keys stay server-side), §10.3.2 (the batch
  contract and the 100-item batch size), §10.3.3 (the report's watermark) and schema §16.1, §18.2,
  §18.3.
- **Findings:** **F2**, **F3**, **F4** and **F6** of the review of the OP-135 GREEN `t_4a280d94`,
  as routed on card `t_1ef602ae`. **F7** (the auth-thunk dedupe) is a behaviour-neutral refactor and
  gets no record here, as its card says.

## Context

The four endpoints are the pipeline's **whole** write surface, and each one takes a caller-supplied
value and then derives durable state from it. Measured on the trunk at `a53623e5`
(`ADR-0833`'s head plus the release commit):

| finding | caller-supplied value   | what the route did with it                                                                                                                                                                | measured                                                                                                                  |
| ------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| F2      | `contentHash`, `format` | `${locationKey}/${body.contentHash}.${body.format}` at `derivative-complete/route.ts:86`; `asset.contentHash`, projected by `findMediaAssetById` for exactly this purpose, was never read | `200 {"status":"derivatives_ready"}` with `derivatives.preview.objectKey = "previews/../../etc/passwd.webp/../../evil"`   |
| F3      | `items[]` (unbounded)   | `z.array(reportItemSchema)` with no cap, 1 read + up to 3 writes per item, sequentially (`report/route.ts:75`)                                                                            | a 101-item report answered `200` and applied its items                                                                    |
| F4      | the lease, read once    | lease read at `report/route.ts:121`, then written with `{_id: row._id}` only (lines 180, 191, 214)                                                                                        | two reports that both read the lease both answered `applied: 1`; a failing profile write still left the selfie row `done` |
| F6      | `occurredAt`            | injected as the emit clock, and `emitDomainEvent` derives `expireAt = occurredAt + retention.domainEventDays` (`domain-events.ts:334-336`)                                                | an instant 25 h ahead was accepted and its `expireAt` moved with it                                                       |

## Decision

### 1. F2 — the stored derivative key is the asset's, and an unowned hash/format is `422`

Three refusal rows (`it.each`) at the observable the caller sees: `422` with
`error.code === "validation_failed"`, **before** the write, with `derivatives` and `status` on the
asset exactly as seeded (`{}`/`"stored"`). The rows are a traversal-shaped pair
(`"../../etc/passwd"`, `"webp/../../evil"`), a well-formed sha256 digest that is simply not this
asset's, and a format the pipeline never writes (`"exe"`).

The rule the pin encodes is the one the sibling GREEN card states: a legitimate body carries **the
asset's own** `contentHash`, and `format` comes from an allow-list. The GREEN may enforce the hash
arm in the body schema (a digest shape) or in the handler after `findMediaAssetById`; both answer
`422 validation_failed`, which is what the pin asserts. The key shape is pinned whole —
`` `thumbnails/<asset.contentHash>.webp` ``, not a substring — so a derivation that drops the variant
prefix or the format reddens.

**Honest limit (§3).** Because a legitimate body must carry the asset's own hash, "the body's hash"
and "the asset's hash" are the same string under any conforming implementation: the key-shape rows
(the two `describe("… the asset owns")` cases) are **green on the trunk** and are regression locks,
not RED pins. The load-bearing half of F2 is the refusal rows, which are red (`expected 200 to be
422`) and stay red until the route stops deriving durable state from the request. `objectKeyRef` is
pinned as _not key material_ (the stored key never contains the handle) — the raw-`objectKey`
refusal already in the file is referenced in the section docblock rather than duplicated.

### 2. F3 — `items` is capped at §10.3.2's 100, refused by body validation

The pin adopts **100** — the number `/internal/domain-events` already applies (`MAX_BATCH`,
`domain-events/route.ts:25`) and §10.3.2's batch size — and pins both sides: a 101-item report is
`422 validation_failed` **and** the seeded leased row is byte-identical afterwards (the refusal
precedes the first read), while a report of exactly **100** items answers `{applied: 100,
leaseLost: 0, rejected: []}` and all 100 rows reach `processing.status: "done"`. The at-cap case is
the boundary that stops the cap drifting one lower; it is green on the trunk and exists for that
reason.

Refusal is a **body rule** (`z.array(reportItemSchema).max(100)` ⇒ the pipeline's `422`), not a
handler-side `413`: the sibling endpoint does the same, and a `413` would make the two batch routes
answer differently to the same shape of mistake. Recorded as a decision because the status choice is
the story's call (ADR-0829 left the cap unpinned for exactly that reason).

### 3. F4a — the lease is a predicate of the write, not of an earlier read

The pin builds the read-then-write window **without touching production code**: it spies on the
driver's `Collection.prototype.findOne`, and on the first call for `event_images` with this row's
`{_id}` it takes the **real** read, then runs a second, complete `POST …/worker/report` for the same
item and the same `workerId`, and only then resolves the held read with the pre-competition
snapshot. Any write that repeats the read's verdict now lands on a lease it no longer holds.

The assertion is in two parts, both observable:

- exactly one answer is `{applied: 1, leaseLost: 0, rejected: []}` and the other
  `{applied: 0, leaseLost: 1, rejected: []}` — today **both** answer `applied: 1`;
- the row holds the **winner's** verdict (`status: "failed"`, `durationMs: 9900`,
  `lastError.code: "face_detection_failed"`), never the loser's `done`/`3400` — the "lease-lost
  reports never overwrite" criterion the parent card claims, which the sequential `I2` case cannot
  see.

The fix the pin forces is the one the GREEN card names: put `processing.workerId` and
`processing.status: "processing"` into the `updateOne` filter and branch on `matchedCount`. A
re-read-then-write that is not atomic with the write does **not** satisfy it — the held read resolves
_before_ the competing commit, so only a write-time predicate sees the new state. (A `findOneAndUpdate`
with the same predicate is an equivalent shape.)

### 4. F4b — the selfie arm's two rows are one unit

The pin rejects the profile `updateOne` (`Collection.prototype.updateOne`, gated on
`collectionName === attendeeEventProfiles`, with `code: 2` — a non-retryable error, so neither a
retry budget nor `withTransaction`'s transient-error handling absorbs it) and asserts that the
request answers `500 internal_error` **and** that the selfie row is byte-identical to its pre-report
state (`processing.status: "processing"`, no `finishedAt`, no `quality.*`) with the profile also
unchanged. Today the selfie row is already `done` when the profile write fails — the half-written
state that leaves the profile `processing` forever.

Either resolution the GREEN card allows satisfies it: one `withTransaction` around the pair, or the
profile write **first** so a failure cannot leave the selfie row ahead of it. The pin deliberately
does not assert _which_, because both make the observable true; what it forbids is the shipped order
(and any regression that drops the second write entirely). The symmetric direction — a failing
**selfie** write leaving the profile written — is left unpinned and named in §6.

### 5. F6 — the worker's instant is bounded in one direction, and the TTL still follows it

Two cases:

- an instant **25 h ahead** of the server is refused **in that item's `rejected[]` only** —
  `{index: 1, eventKey, reason: "occurred_at_out_of_window"}`, `accepted: 1`, `deduped: 0`, exactly
  as `unknown_event_key` behaves — and only the accepted item leaves a row;
- an instant **inside** the window (5 min ago) is still stamped as the event's `occurredAt` and
  derives `expireAt = occurredAt + retention.domainEventDays`, which the pin reads from
  `getPlatformSettings` rather than hard-coding 180 days.

The reason code is `occurred_at_out_of_window`; it is the one string the GREEN must adopt, and it is
recorded here because no contract text names it.

**The card's `±24 h` proposal is not satisfiable with the frozen suite, so the pin adopts the
forward bound only.** Measured, not argued: the file's own `domainEvent()` fixture posts a **fixed**
`occurredAt` of `2026-09-25T09:41:00.000Z`, which is **52.92 days** before this run, so a symmetric
window would refuse the items of `I1`, both dedupe cases and the later-arrival case. The
counterfactual was applied to `domain-events/route.ts` (the same guard with `Math.abs(skewMs)`) and
the lane spec re-run:

```
× I1: accepts the rest of the batch and rejects only the unknown event key
× counts a repeat of the same dedupeKey as deduped and keeps one row
× dedupes the activation identity a confirmation has already published (ADR-0808 §3)
× records a later arrival for an already-announced selfie as a second delivery
Tests  10 failed | 32 passed (42)
```

— four **frozen** cases reddened by a rule the GREEN would then have to satisfy without editing
them, which the card forbids. A past instant is also a legitimate worker backlog (a worker that was
offline still flushes), while the future direction is the only one in which the caller's own value
pushes `expireAt` past the retention the platform chose. The one-sided rule keeps every frozen case
green and still refuses the F6 hazard; the GREEN card's "±24 h" is therefore read as "+24 h", and
`t_b4a1ee9c` carries a comment saying so.

The bound must be evaluated **in the route** against `systemClock`, not inside `emitDomainEvent`:
that function's clock seam carries the _worker's_ instant by design
(`{now: () => new Date(item.occurredAt)}`), and `domain-events.test.ts` drives it with
`fixedClock(T0)` fixtures (2026-01), so a skew check inside the emitter would redden that frozen
suite as well.

### 6. Evidence: RED on the trunk, green with a faithful near-fix, and one pin per finding

Baseline before the append: `31 passed (31)`. After it, on `origin/main` `a53623e5`:
`Tests  7 failed | 35 passed (42)` — three F2 refusal rows, F3's over-cap row, F4a, F4b and F6's
skew row, each at an assertion (never a load or harness error):

```
F2 (×3)  AssertionError: expected 200 to be 422
F3       AssertionError: expected 200 to be 422
F4a      AssertionError: expected [ { applied: 1, …(2) }, …(1) ] to deeply equal [ { applied: +0, …(2) }, …(1) ]
F4b      AssertionError: expected { …(13) } to deeply equal { …(12) }   // status: "done" vs "processing"
F6       AssertionError: expected { accepted: 2, deduped: +0, …(1) } to deeply equal { accepted: 1, … }
```

Four of the eleven new cases pass on the trunk **by construction** and are recorded as such: the two
F2 key-shape rows, F3's at-cap row and F6's inside-the-window row (§1, §2, §5). They are regression
locks, not RED evidence.

Satisfiability was then proved with a **faithful minimal near-fix** applied to the three production
files and removed again: `Tests  42 passed (42)`. Each finding was then omitted in turn, everything
else left in place, and the spec re-run — each omission reddens **only** its own cases:

| variant        | result                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| all four fixes | `42 passed (42)`                                                           |
| omit F2        | `3 failed \| 39 passed` — the three refusal rows, `expected 200 to be 422` |
| omit F3        | `1 failed \| 41 passed` — the over-cap row                                 |
| omit F4a       | `1 failed \| 41 passed` — the concurrent-reports row, `applied: 1` vs `0`  |
| omit F4b       | `1 failed \| 41 passed` — the half-written pair row                        |
| omit F6        | `1 failed \| 41 passed` — the skew row, `accepted: 2` vs `1`               |

Every production file was restored byte-identically after each run (sha256 `75ac3e56b419` /
`800aa74564a9` / `e6a5e08c4837` before and after; `git status --short` shows only the spec).

## Consequences

- **One file, appended.** `apps/web/src/test/integration/internal-worker-endpoints.test.ts` grows by
  the eleven new cases (+519 lines) plus two import-line additions (`vi`, `Collection`) and
  `getPlatformSettings` in the existing import block. No existing case, helper, fixture or mock is
  edited; the frozen 31 stay green (`35 passed` of the 42 includes them).
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0` at the pinned head; `prettier --check` clean;
  `eslint` 0 errors. The spec carries the file's existing `security/detect-object-injection`
  warning class and adds none.
- **The RED pins do not merge.** The PR is a **draft** and is not squash-merged (OP-93/ADR-0306): a
  merged RED leaves `main` red. The GREEN `t_b4a1ee9c` bases on
  `origin/OP-135-task-worker-boundary-pins`, merges the then-current `origin/main` and carries these
  cases forward unchanged; its branch closes the draft PR as superseded after its own merge.
- The selfie arm is now pinned on six facts — a live result stays visible (§6.4), a failure reaches
  `status: "failed"` (`I6`), a withdrawn profile's late result is rejected (`I8`), a superseded
  report moves nothing (ADR-0832), the pair is not half-written (F4b here), and a report that lost
  its lease writes nothing (F4a here) — so the arm may be reorganised freely but cannot drop any of
  them.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, the lane cell (`0834` → `0835`) and
  the prose note merge as a union keeping the higher cell; the pool cells stay `0849`. The new index
  row's Title cell is 111 characters, far under the group's widest (2948), so it costs one line and
  widens no column.

## Not decided here

- **`objectKeyRef`'s purpose.** The pins fix only that it is not key material and that the stored key
  is the asset's. Whether the GREEN binds the handle (refusing one that does not resolve) or
  documents it as an opaque correlation id is the GREEN card's explicit decision, and the ADR it
  owes must close it.
- **The symmetric direction of the selfie pair.** A failing **selfie** write leaving the profile
  written is the inverse half-written state; it is not pinned (the card names the profile direction)
  and a `withTransaction` closes both at once.
- **`worker.report_discarded` and the null-`activeSelfieId`/`failed`/`skipped` arms** — routed to
  card `t_795ba842`, chained behind the GREEN. **F7** (the four duplicated `auth:` thunks) is the
  GREEN's refactor and gets no number.
- **Whether the past direction needs a floor.** If the outbox later gains one (e.g. "older than the
  retention is dead on arrival"), it must come with a fixture change to the frozen batch cases or a
  rule that leaves their fixed instant accepted; the pin as written does not constrain it.

## Note — carried forward unchanged into ADR-0835's GREEN

The eleven cases this record pins are carried forward unchanged into
[ADR-0835](ADR-0835-op135-internal-worker-boundary-hardening-green.md)'s GREEN, and they are green
there (`42 passed (42)`); this record stays the **RED evidence**, and the review that followed that
GREEN is recorded in ADR-0835 §"Review sign-off (round 1, artifact lens)". Nothing in §1–§6 is
restated or retracted here.
