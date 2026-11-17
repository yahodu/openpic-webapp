# ADR-0836 — OP-135 TEST: the discard is observable, and the arms beside it are pinned

- **Status:** Accepted (characterization pins; green on arrival at `origin/main` `450fcb03`, the merge
  of PR #623)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0836`** at this base. The sweep immediately before minting found no `ADR-0836*` file in
  any `.worktrees/*/docs/adr`, `git rev-list --objects --all -- docs/adr` with every open PR head
  fetched into `refs/remotes/pr/*` returns **`0835`** as the highest record number on any ref (this
  lane's own GREEN; `0849`/`0850` exist only on the OP-136 lane's own heads), and no open PR adds a
  `0836`. So this record takes **`0836`** and advances **only** that cell to `0837`; both
  `unallocated (future lanes)` cells stay `0849` and no range is re-cut.
- **Consumes:** [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md) §4 (`null` is not
  superseded), [ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md) §1–§2 (the guard,
  and "a `skipped` verdict is unchanged"), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md)
  §4 (the selfie arm's writes), [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §4 (the
  report's wire shape), contract §6.4 (the poll the write feeds), §10.3.2 (the report body) and
  §10.3.3 (the watermark).
- **Findings:** **P1**, **P2**, **P3** and **P4** of the review of the OP-135 GREEN `t_c7b043ec`, as
  routed on card `t_795ba842`.

## Context

The superseded-selfie guard shipped in PR #623 and ADR-0832's carried case is green, but four
behaviours the delivery _asserts_ had no observer, so a regression in any of them would have shipped
silently:

- **The discard log.** The parent card's security/logging requirement asked for a warn on every
  discarded report. `grep -rn 'report_discarded' apps packages` returned `report/route.ts` only — the
  event had exactly one mention in the repository, and that mention was the call site. Deleting it
  changed no test.
- **The `null` pointer.** The guard is
  `profile?.activeSelfieId != null && !profile.activeSelfieId.equals(row._id)`: a profile with no
  pointer has no live result to protect, so the write proceeds (ADR-0832 §4, ADR-0833 §1). Inverting
  that `!= null` would have shipped silently too.
- **The `failed` verdict.** The discard is decided by `decision.status !== "skipped"`, so a failure on
  a superseded row is discarded as well — the correct reading (a superseded row must not mark the
  **active** profile `failed`), and unmeasured.
- **The `skipped` verdict.** ADR-0833 §2 claims "a `skipped` verdict is unchanged — it never wrote the
  profile in the first place". Nothing characterized it, so a flag that started to withhold (or to
  announce) a write that never happened would have been invisible.

## Decision

Five cases are appended to `apps/web/src/test/integration/internal-worker-endpoints.test.ts`, inside
the existing `describe("when the worker reports a selfie outcome")`: the 31 frozen cases, the
superseded-selfie case and ADR-0834's 11 pins are untouched, as are every helper, fixture, mock and
spec literal (the two import lines gain `afterEach` and the logging port).

### 1. P1 — the discard is observable as one `warn`

The file gains a three-line harness: `installLogSink()` captures the process logger with `getLogger()`,
installs `createLogger({ level: "info", transports: [memoryTransport()] })` through `setLogger`, and
returns the sink; an `afterEach` puts the captured logger back. The restore is mandatory, not tidy-up:
`@/server/logging` has **no** `resetLogger`, so a case that left the memory logger installed would
silence every later case in the file.

Two cases, because either half alone is satisfied by a wrong implementation:

- a superseded report (ADR-0832's seed: the item claimed by `LEASEHOLDER`, the profile pointed at a
  **different** `activeSelfieId`) emits **exactly one** entry matching
  `{event: "worker.report_discarded", level: "warn", kind: "selfie", id: <the reported selfie id>,
workerId: LEASEHOLDER, reason: "superseded_selfie"}`;
- a report whose profile's `activeSelfieId` **equals** the reported row emits **none**, and the profile
  is written (`ready`, the report's `matchCount`, its `matchRunStartedAt` as the watermark) — so an
  unconditional log fails, and so does a log whose subject is the profile rather than the item.

The assertion is `toMatchObject` on the filtered entry plus `toHaveLength(1)`, never `toEqual` on the
whole entry: `ts` is the emission instant, and pinning it would freeze the clock seam rather than the
observable.

### 2. P2 — a profile with no `activeSelfieId` is not superseded

The pointer is seeded `null` explicitly (a submit already leaves it `null`; setting it makes the seed
independent of the submit's own default), a `done` report is sent, and the profile **is** written:
`status: "ready"`, the report's `matchCount`, `lastMatchRunAt` = the report's `matchRunStartedAt`. No
`report_discarded` entry appears.

### 3. P3 — a `failed` verdict on a superseded row is discarded too

Same seed, `outcome: "failed"` with a non-retryable `face_detection_failed` error. The profile's whole
document is unchanged (`toEqual(profileBefore)`, plus `ready`/`7`/the newer instant read explicitly),
the item's **own** row still records the verdict (`processing.status: "failed"`,
`lastError.code: "face_detection_failed"`), and one `report_discarded` entry is emitted. The answer
stays `{applied: 1, leaseLost: 0, rejected: []}`, as ADR-0832 §2 requires.

### 4. P4 — a `skipped` verdict on a superseded row writes nothing and logs nothing

Same seed, `outcome: "skipped"`. The profile is byte-identical to its pre-report state, **zero**
`report_discarded` entries are emitted — the flag must not withhold a write that would not have
happened — and the item's own row still carries the verdict (`processing.status: "skipped"`).

### 5. Deliberately not pinned here

- The read-then-write window between the guard's profile read and the profile write is finding **F4**
  and belongs to `t_1ef602ae` → `t_b4a1ee9c` in this chain.
- Rewriting the discard log from `getLogger()` to a request-scoped `requestLogger` was not required:
  the entry carries no request id and no PII, and the observable is the port's own output.
- The number of attempts that can emit the warn is unpinned (F-E, Info): `withTransaction` retries, so
  a retried transaction may log twice. Pinning "exactly one across attempts" would pin the retry
  budget, which belongs to the transaction's own contract.

## Consequences

- The discard log is load-bearing: deleting the warn reds P1 and P3. A log hoisted out of the guard
  reds P1's allowed direction and P2. Inverting the `!= null` test reds P2 alone. Logging the
  `skipped` arm reds P4 alone. Each probe is recorded in §Evidence.
- The case that installs the sink must be the case that reads it: the logger is process-wide, so the
  `afterEach` restore is part of the contract, not hygiene. A future case that wants to observe a log
  line calls `installLogSink()` and does nothing else.
- These are characterization pins: they introduce no production change and must be green on arrival.
  A red here is a defect report, not a request to weaken the pin.
- No public behaviour changes. The lane spec is `47 passed (47)`.

## Alternatives

1. **`toEqual` on the whole log entry.** Rejected: `ts` is generated per emission, so the assertion
   would pin the clock rather than the discard; `toMatchObject` over the six contract fields keeps the
   regression-detecting power and drops the noise.
2. **Spy on `getLogger`** (`vi.spyOn(module, "getLogger")`). Rejected: it asserts on an internal
   collaborator and couples the spec to the call site; the logging port exists precisely so a test can
   observe the output instead.
3. **Count `worker.lease_lost` entries too.** Rejected as the wrong arm — a discard is not a lost
   lease, and ADR-0832 §2 pins the answer that distinguishes them (`applied: 1` vs `leaseLost: 1`).
4. **Pin the retried transaction's log count.** Rejected in §5: it would pin the retry budget to a
   logging detail.

## Evidence

Base `origin/main` `450fcb03` (PR #623 merged; the guard is in the base —
`git show origin/main:apps/web/src/app/api/v1/internal/worker/report/route.ts | grep -n
'supersededSelfie\|report_discarded'` prints six lines). Lane spec at the delivered tree:
**47 passed (47)** — the 42 pre-existing cases plus P1×2, P2, P3, P4.

Probes, each applied alone to a throwaway worktree (`.worktrees/probe-t795ba842`, detached at
`450fcb03` with the delivered spec copied in), run against the same spec, then restored:

| Probe | Mutation of `report/route.ts`                                                                | Result                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —     | none (baseline)                                                                              | `47 passed (47)`.                                                                                                                                                                                 |
| M1    | the `getLogger().warn("worker.report_discarded"…)` call deleted                              | `2 failed \| 45 passed (47)` — `P1: logs one warn …` and `P3: discards a failed verdict …`, both `expected [] to have a length of 1 but got +0`.                                                  |
| M2    | the same warn hoisted **out** of the `if (supersededSelfie)` guard, the write arms untouched | `2 failed \| 45 passed (47)` — `P1: logs nothing when …` and `P2: writes the profile …`, both `expected [ { …(8) } ] to deeply equal []`.                                                         |
| M3    | the pointer test inverted (`!= null` → `== null`)                                            | `1 failed \| 46 passed (47)` — `P2: writes the profile when it has no active selfie pointer` with `expected { status: 'processing', …(2) } to deeply equal { Object (status, matchCount, ...) }`. |
| M4    | a warn added on the skipped+superseded arm only                                              | `1 failed \| 46 passed (47)` — `P4: a skipped verdict …` with `expected [ { …(8) } ] to deeply equal []`.                                                                                         |

Every probe reddened only its own pin(s), and the route was restored byte-identically each time
(`sha256 80e14b9164ef97bb2829045001b0d767bda31d11d729630821a6dea01432a0e3`). Gates at this head:
`tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 errors, `prettier --check` clean, the
`adr-*` guards green, and the full `unit` + `integration` projects green.
