# ADR-0840 — OP-135 TEST: the discard line carries exactly its eight non-PII fields

- **Status:** Accepted (characterization pin — green on arrival against the landed GREEN ADR-0833, so
  the PR is non-draft and merges)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0840`** at this base (`30ae9ea7`). The sweep immediately before minting found no
  `ADR-0840*` file in any of the thirty-four `.worktrees/*/docs/adr` trees (their maxima ranged
  `0800`–`0857`, and none held a record inside `0840`–`0848`), `git rev-list --objects --all -- docs/adr`
  returning **`0857`** as the highest number on any object (the OP-136 lane), and none of the open PR
  heads fetched into `refs/remotes/pr/*` (through `#639`) carrying `0840`. So this record takes
  **`0840`** and advances **only** that cell to `0841`; the OP-136 cell stays `0857` and both
  `unallocated (future lanes)` cells stay `0869`. No range is re-cut.
- **Consumers:** `apps/web/src/test/integration/internal-worker-endpoints.test.ts`
- **Consumes:** [ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md) §2 (the discard
  line, its three non-PII fields and its privacy claim), [ADR-0836](ADR-0836-op135-superseded-selfie-arm-pins.md)
  §1 (P1, the `toMatchObject` pin this one completes), [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md)
  §2 (the `{applied: 1, leaseLost: 0, rejected: []}` answer), contract §10.3.2 (the report body) and
  §10.3.3 (the watermark), and CONVENTIONS §5.3 (the redaction control the entry passes through).
- **Findings:** **F1** (Low) of the review of the OP-135 TEST card `t_795ba842` (PR #627, squash
  `9db78584`, ADR-0836), routed on card `t_6bcdda0e`.

## Context

ADR-0833 §2 made the withheld profile write observable: when the report's profile update matches
nothing, the route emits one `worker.report_discarded` at **warn** carrying `kind`, `id`, `workerId`
and `reason: "superseded_selfie"`, and the record states the privacy half of that decision in the same
breath — _the line carries no profile id and no biometric field_, because it is shipped to the
operator's log vendor.

ADR-0836 §1 pinned the line with `toMatchObject` over six fields plus `toHaveLength(1)`.
`toMatchObject` **permits extra keys**, so the privacy half was unmeasured: a change that added
`profileId`, a `subject` handle, a contact or an `embedding` reference to that `warn` would leave every
one of the 49 cases in the host spec green while the leak reached the vendor. The entry's real key set
at this base is eight keys — the logger's `ts`, `level`, `msg` envelope plus the four call-site fields
— measured through the same `memoryTransport` sink the delivered harness installs
(`setLogger(createLogger({ level: "info", transports: [sink] }))`, so no `service`/`env`/`version`
envelope).

The redaction control is no substitute for the pin: `redactEntry` redacts **values** by key and by
pattern but keeps the key, so `email` or `phone` would arrive as a key with `[REDACTED]` beside it —
still a field this decision did not sanction.

## Decision

One case is appended inside the existing `describe("when the worker reports a selfie outcome")`,
beside P1, in `apps/web/src/test/integration/internal-worker-endpoints.test.ts`. The frozen 49 cases,
every helper, fixture, mock and spec literal are untouched; the diff is `+76/−0` in that one file.

### 1. It reuses P1's seed and harness rather than restating them

`submittedSelfie()`, `claimSelfie(fixture.selfieId, LEASEHOLDER)`, `seedSupersededProfile()` (the
profile pointed at a **different** `activeSelfieId`, `ready`/`7`/the newer run instant),
`installLogSink()`, `discardEntries()`, `signedPost()` and `SUPERSEDED_NEWER_RUN` are the P1 ones. The
sink is installed after the seed, so it holds this request's lines only, and the `afterEach` that puts
the process logger back is P1's.

### 2. It asserts the entry's own key set, then names each forbidden field

- `expect(discarded).toHaveLength(1)` first, so the case measures the discard arm and not the absence
  of lines, then a `throw` when the entry is missing — the assertion a silent `[]` would otherwise turn
  into an index-typed `undefined`.
- `expect(Object.keys(entry).sort()).toEqual([…])` with the eight names — **sorted**, so the assertion
  names the set rather than the emission order, and an exact list, so a removed field reddens as loudly
  as an added one.
- Five explicit absences — `profileId`, `subject`, `embedding`, `email`, `phone` — because the exact
  list's diff names the extra field but not what it means; the negative list is the record's own claim,
  not every conceivable PII name.
- The answer stays `{applied: 1, leaseLost: 0, rejected: []}` (ADR-0832 §2), which is what proves the
  case reached the discard arm instead of a rejected or lease-lost one.

### 3. Deliberately not pinned

- **The rest of the entry's values.** `ts` is the clock and `msg` is the logger's own rendering; the
  case pins the **field set**, which is the privacy claim. P1 already pins the six values it names.
- **Every other PII name.** The negative list is the record's claim; enumerating `address`, `name`,
  `iban` and the like would invent a contract ADR-0833 does not state, and the exact key set already
  forbids them.
- **The line's transport shape** (JSON serialization, vendor envelope). That is the logging port's
  contract (`logger.test.ts`, `redaction.test.ts`), not this route's.

## Consequences

- The privacy half of ADR-0833 §2 is now enforced: any field added to that `warn` reddens exactly this
  case with a diff naming it, while P1–P4 stay green (probes M1/M2 below).
- The case is green on arrival because ADR-0833 shipped the correct shape. This record introduces
  **no** production change and needs no GREEN sibling; unlike ADR-0836's pins it is not RED-by-design,
  so the PR is non-draft and merges on its own.
- The host spec is now 2638 lines / 50 cases. Four OP-135 chain cards and three reviews have appended
  to it; the decomposition decision the earlier records flagged stays due, and this card's "append one
  case beside P1" instruction keeps it from growing further.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, the lane cell and the note below merge as
  a union keeping the highest cells. The card's `≤116 chars` row rule stays **unsatisfiable**
  (neighbouring rows measure 1873–3253 characters and no guard checks width — the same finding the
  review of `t_795ba842` routed as F4); consistency with the ledger wins.

## Alternatives

1. **Widen P1's `toMatchObject` to `toStrictEqual` on the whole entry.** Rejected: it edits a frozen
   case ADR-0836 §1 owns, and it would pin `ts` and `msg` values this decision does not.
2. **Assert only the negative list.** Rejected: a field the list does not name (`subject` is the
   realistic shape, and it is on the list only because the review named it) would pass; the exact key
   set is what makes the claim enforceable.
3. **Assert only the exact key set.** Rejected: its diff names the extra key but says nothing about
   _why_ the key is forbidden, and a future reader would be free to "just add one more field".
4. **Spy on the logger call** instead of reading the sink. Rejected: call counting and argument
   inspection are implementation details; the entry the transport receives is the observable.

## Evidence

Base: `origin/main` `30ae9ea7`, cut at run time. The trunk carries ADR-0833's line
(`git grep -n 'worker.report_discarded' origin/main -- apps/web/src/app/api/v1/internal/worker/report/route.ts`
→ line 260), so this pin is written against the shipped shape, not before it.

Lane spec, before and after the append:

```
baseline  (49 cases):  Test Files  1 passed (1)   Tests  49 passed (49)
delivered (50 cases):  Test Files  1 passed (1)   Tests  50 passed (50)
```

Green on arrival, as the card requires. The case is not vacuous — two probes, each applied alone to
`report/route.ts` in a throwaway worktree detached at the delivered commit
(`git worktree add --detach …/probe-26722eaf 26722eaf`, per-package `node_modules` symlinks):

| Probe | Mutation of `report/route.ts`                          | Result                                                                                                                                                                                                |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | `profileId: row.profileId,` added to the `warn` fields | `1 failed \| 49 passed (50)` — **this case alone**: `AssertionError: expected [ Array(9) ] to deeply equal [ Array(8) ]` with `+ "profileId"` in the diff. P1–P4 stay green.                          |
| M2    | `subject: "x",` added to the `warn` fields             | `1 failed \| 49 skipped (50)` under `-t "P5: logs the discard with exactly"` — the same diff with `+ "subject"`, so a name outside the negative list is caught by the exact key set, not by the list. |

The route was restored byte-identically after both probes
(`sha256 9e379612246b0bafc5327bc093986951cb9545407827141403b54787f2a27162` before and after — the same
hash ADR-0838 and ADR-0839 record). `git diff --numstat` for the spec commit is `+76/−0` in the one
file; no production file, no helper, no fixture and no mock is touched.

Gates: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 issues, `prettier --check` clean
on the spec, this record and `docs/adr/README.md`, the `adr-*` guards green, full `unit`
**`184 files / 3077 passed | 3 skipped (3080)`** and full `integration`
**`8 failed | 1441 passed (1449)`** in `139` files, where all eight failures are the harness's 5 s
test-timeout class in seven specs this change does not touch — `notification-quiet-hours-release`
(I12, 5009 ms), `auth-guards` (I7, 5013 ms), `notification-unsubscribe` (the tampered-token preview,
5010 ms), `notification-digest-flush-unrecorded-bound` (F1, 5013 ms),
`notification-redelivery-body-retention` (F4, 5017 ms), `billing-crons` (I4, 5035 ms) and
`notification-types-catalogue` (§7.6 projection, 5006 ms and 5001 ms) — and each of the seven is green
when run on its own at this head (**`7 passed (7)` files / `70 passed (70)` tests**). The lane spec is
`50 passed (50)` in that same full run. A test-only append to one spec cannot reach those files; the
class is the one ADR-0838 and ADR-0839 record at this trunk, and CI is the authority on the full
project.
