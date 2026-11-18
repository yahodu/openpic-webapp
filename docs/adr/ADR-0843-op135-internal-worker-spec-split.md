# ADR-0843 — OP-135 REFACTOR: the internal-worker endpoints spec splits into four behaviour files behind one harness

- **Status:** Accepted (refactor — relocation only; the case count and every case body are unchanged)
- **Card:** `t_6006f885` (OP-135 REFACTOR, Info) · **Branch:** `OP-135-task-spec-split` ·
  **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op135-spec-split` · **Base:** `origin/main`
  `2f23fa34` (release 1.66.0), which this branch was cut from
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0843`** at this base (ADR-0842 consumed `0842`; `0844` is the next card). So this record
  takes **`0843`** and advances **only** the `OP-135 worker interface lane` cell to `0844`. No range is
  re-cut and every other cell is untouched.
- **Consumers:**
  `apps/web/src/test/integration/internal-worker-endpoints.test.ts`,
  `apps/web/src/test/integration/internal-worker-batch-heartbeat.test.ts`,
  `apps/web/src/test/integration/internal-worker-derivative.test.ts`,
  `apps/web/src/test/integration/internal-worker-report-limits.test.ts` and
  `apps/web/src/test/helpers/internal-worker-harness.ts` — the four specs that import the harness, plus
  the harness itself, are the whole of this record's reach.
- **Consumes:** [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §2 (the file it froze and
  the case bodies this refactor carries unchanged), [ADR-0792](ADR-0792-op132-liveness-selfie-green.md)
  §Consequences (a refactor must leave the artefact alone — the rule that rules out the alternative in
  §Alternatives 1), [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §3 (the F4a pin and the
  module-level driver capture it needs) and [ADR-0839](ADR-0839-op135-pointer-race-failed-verdict-pin.md)
  §Evidence (the P2/P3 probes re-run here), [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md)
  (the case that could not move, §2 below), contract §0.3 and §10.3.2.

## Context

### 1. The measured state at this base

`apps/web/src/test/integration/internal-worker-endpoints.test.ts` is the largest of the 140 integration
specs and it had become the place every OP-135 card appended to:

| measure                                           | value at `2f23fa34` | decision snapshot (`4a98f013`) |
| ------------------------------------------------- | ------------------- | ------------------------------ |
| lines                                             | **2 706**           | 2 638                          |
| cases (`pnpm vitest run --project integration …`) | **51 passed (51)**  | 50 passed (50)                 |
| single-file run (vitest `Duration`)               | **13.59 s**         | 10.61 s                        |
| `describe` blocks                                 | 14                  | 13                             |
| preamble (imports, credential, handlers, seeds)   | 694 lines           | 694 lines                      |

The +1 case and +68 lines are ADR-0842's compound-item pin, which landed between the decision and this
base. Every figure here was measured on this tree, not carried over: the orchestrator card says to
re-measure and use the result as the oracle, and that is what §Evidence reports.

The file's shape is why the split is mechanical: a 694-line preamble (`world`, the seeds, the four
resolved handlers, the `app` lifecycle) followed by independent `describe` blocks that share nothing but
that preamble.

### 2. The citation constraint — the deciding fact

The repository's ADR guard (`checkRepositoryAdrConsumers`, invariant (v) of ADR-0302) hard-checks every
citation of a record that declares `Consumers`. At this base it reports `ok: true`, 1 615 references
checked, 396 verified, **0 issues**, 71 declaring records. The spec carried 37 references. Only four of
them pin **this specific path**:

| record                                                                | identifies the legacy path                                        | identifies anything else under `apps/web/src/test/**` |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| 0792                                                                  | yes                                                               | no                                                    |
| 0798                                                                  | yes                                                               | no                                                    |
| 0840                                                                  | yes                                                               | no                                                    |
| 0842                                                                  | yes                                                               | no                                                    |
| 0806                                                                  | yes                                                               | yes (the record names the `apps/web` tree)            |
| 0808                                                                  | yes                                                               | yes                                                   |
| 0835                                                                  | yes                                                               | yes                                                   |
| the rest (0028, 0007, 0829, 0830, 0832, 0833, 0834, 0836, 0837, 0839) | no `Consumers:` field — counted `unlisted-consumer`, never failed | —                                                     |

The decision snapshot named `0792`, `0798`, `0840` and `ADR-0314`; measured at this base the spec cites
**no** `ADR-0314`, and **`0842`** (minted after the snapshot) joined the pinning set. So a citation may
move out of the legacy file only when its record does not declare consumers, or declares and identifies
the target. That is what decides which arms move and which stay, and it is not negotiable by editing a
record (the README's line 3 rule and ADR-0792 §Consequences).

### 3. The spy coupling the split must not break

Three pins hold a `Collection.prototype.findOne` / `updateOne` spy open and compare what the driver
actually received against `driverFindOne` / `driverUpdateOne` / `filterTargetId`. Those three are
**module-level IIFEs, evaluated once at import**, precisely so the capture precedes every spy. If the
trio moved into a per-test closure, or into a module a spec imports _after_ installing its spy, the
comparison would read the spy itself and the pins would pass vacuously — the failure mode this record
must not introduce.

## Decision

### 1. Split, do not rename, do not edit a record

Four behaviour files plus one harness. The legacy path keeps its name (five `Consumers:` lists name it:
0314, 0792, 0798, 0835, 0840), and the two arms whose citations may not move stay inside it.

| file                                                     | blocks (located by `describe` title)                                                                                                                                                        | cases at `2f23fa34` |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `internal-worker-endpoints.test.ts` (**path unchanged**) | I5 refusal ladder; I2/I6/I8 image-report and selfie-report arm (incl. the superseded-selfie P1–P5 block); F4b pair-never-half-written; F-A; F-B pointer race; ADR-0842's compound-item case | **32**              |
| `internal-worker-batch-heartbeat.test.ts`                | I1 domain-event batch; I4 heartbeat                                                                                                                                                         | **6**               |
| `internal-worker-derivative.test.ts`                     | I3/I7 derivative; F2 ownership matrix                                                                                                                                                       | **8**               |
| `internal-worker-report-limits.test.ts`                  | F3 batch cap; F4 lease race; F6 event-instant window                                                                                                                                        | **5**               |
| `helpers/internal-worker-harness.ts` (**new module**)    | the 694-line preamble, the F3/F6 section constants, and the module-level driver trio                                                                                                        | —                   |

**32 + 6 + 8 + 5 = 51**, equal to the base head's count. No case is added, dropped, skipped or renamed;
no case body, title, assertion, fixture literal, timeout or `describe` title is edited. `git diff` reads
as moves plus generated import blocks plus the appended docblock map.

### 2. What moves and what may not

- **The selfie arm stays.** `ADR-0792` (line 1 142, inside I6) and `ADR-0840` (line 1 592, above P5) are
  cited from inside it and neither record identifies any other file. The arm is therefore inseparable
  from the legacy path without editing a frozen record.
- **The file docblock stays.** `ADR-0798` sits in it.
- **ADR-0842's compound-item case stays.** Its record's `Consumers:` names the legacy path only, so the
  case could not move either — a constraint the decision snapshot did not have, because the record did
  not exist then.
- **The three files that could move are the ones whose records are silent** (`0830`, `0832`, `0833`,
  `0834`, `0836`, `0837`, `0839`) or name the whole `apps/web` tree (`0806`, `0808`, `0835`).
- **The harness cites none of 0792 / 0798 / 0840 / 0842.** Its preamble's records are `0007`, `0028`,
  `0806`, `0808` and `0829`, and each of those either declares against the whole tree or declares
  nothing.

### 3. The harness is a module, not a spec

- It is `apps/web/src/test/helpers/internal-worker-harness.ts`, imported by all four specs as
  `../helpers/internal-worker-harness.js`. **No `.test.ts` imports another `.test.ts`** — Vitest would
  register those cases twice, in both files' contexts.
- It exports the preamble's declarations unchanged (constants, `signedPost`, the four handlers,
  `ENDPOINTS`, `meHandler`, `app`, `settingsCollection`, `seedPacing`, `world`, `seedAsset`, `assetRow`,
  `seedClaimedImage`, `claimSelfie`, `profileRow`, `selfieRow`, `pollParticipation`, `submittedSelfie`,
  `confirmedWithWorkerResult`, `activationDeliveryKey`, `incrementalDeliveryKey`, `domainEvent`), plus
  `REPORT_BATCH_CAP`, `EVENT_INSTANT_WINDOW_MS` and `OUT_OF_WINDOW_REASON` — the surface wins by
  measurement, not by taste: these are exactly the names the four blocks reference.
  `FOREIGN_DIGEST`, `DerivativeRefusal` and `DERIVATIVE_REFUSALS` stay in the derivative file, which is
  the only file that uses them.
- The lifecycle (`beforeAll` / `afterAll` / `beforeEach`) runs **at import time and therefore registers
  per spec file**. Each of the four specs gets its own `app`, its own database prefix and its own
  cleanup — the isolation the single file gave for free.
- `app` is exported as a live ESM binding (`export let app: TestApp`), so the moved case bodies keep
  reading `app.db` verbatim.
- `driverFindOne` / `driverUpdateOne` / `filterTargetId` stay **module-level in the harness**, evaluated
  once when the harness is imported (which happens before any spec's `describe` body runs). The three
  specs that pin a spy import them from there.

### 4. Documentation of the move

- The legacy docblock keeps its text and gains a **"Where the cases live"** map naming the three
  sibling files and the harness, so a reader arriving at the old path is routed rather than surprised.
- The F2/F3/F4/F6 section docblock stays **whole** in the derivative file, where it opens F2; the
  report-limits file states that it is the continuation. Splitting that block would have rewritten
  prose that four records cite by section, for no gain.
- Each new spec carries a short docblock: what it pins, and that its case bodies are the legacy file's
  unchanged.

## Consequences

- A future append lands in the file that owns the behaviour, and no file has to hold the whole surface.
- The four specs run in **9.54 s** (`Duration`, 4 files) against the single file's **13.59 s**: the same
  work, split across workers.
- The one behavioural difference is lifecycle isolation: four `app` instances instead of one.
- A refactor that reorders or drops a case now reddens one small file, not a 2 700-line one.
- The legacy path stays as the citation anchor for four records, so a later card that wants to move the
  selfie arm has to mint a consumer row — which ADR-0792 forbids for a frozen artefact — or leave it.

## Alternatives

1. **Edit the three records' `Consumers:` lists so the citations may move.** Rejected, and it is the
   decision's deciding fact: `docs/adr/README.md` line 3 says never edit an accepted ADR, and ADR-0792
   §Consequences says a refactor must leave the artefact alone — "adding a consumer row to a frozen
   record … would have made the record describe code the GREEN never shipped". A refactor that needs a
   frozen record rewritten is not a refactor.
2. **A case-less pointer stub at the legacy path** whose citations point at nothing. Rejected: it keeps
   the four records' citations resolvable while the behaviour they describe lives elsewhere, so the
   guard would verify a file that asserts nothing — a green report about an empty artefact. It also
   leaves the split's reader with a dead file.
3. **A size-cap guard alone** (refuse a spec above N lines). Rejected: it defers the split to the next
   append, under time pressure, and a board-wide cap would red 11 existing files without a grandfather
   list — a guard that spends its budget on the files nobody is touching.
4. **Move the selfie arm and rewrite the citations.** Rejected: it needs alternative 1.
5. **Put the shared constants in one behaviour spec and import it from the others.** Rejected: a
   `.test.ts` importing a `.test.ts` registers the imported file's cases twice.

## Evidence

Base `origin/main` `2f23fa34`, branch cut from it, uncommitted tree at the measurements below.

**1. Equal case count.** The four files in one command, and the base file alone:

```
base   (2f23fa34)  Test Files  1 passed (1)   Tests  51 passed (51)    Duration 13.59 s
split  (this tree) Test Files  4 passed (4)   Tests  51 passed (51)    Duration  9.54 s
                   endpoints 32 · batch-heartbeat 6 · derivative 8 · report-limits 5
```

Per file, run alone: `internal-worker-endpoints` 32, `internal-worker-batch-heartbeat` 6,
`internal-worker-derivative` 8, `internal-worker-report-limits` 5.

**2. Citation invariant.** `grep -rln "ADR-0792\|ADR-0798\|ADR-0840" apps/web/src/test` returns **two**
paths: the legacy spec, and the pre-existing `integration/liveness-selfie-submit.test.ts`, which cites
`ADR-0798` in two comment lines and is named in that record's own `Consumers:` list. Neither is new and
neither is touched here. Among the files this record creates, the count is **zero**: the harness, the
batch-heartbeat, derivative and report-limits specs cite none of the three. The card's "exactly one
path" was measured without the pre-existing consumer; the guard is the operative check, and it is green
(§5).

**3. Diff scope.** `git diff --name-only 2f23fa34..HEAD`:

```
apps/web/src/test/helpers/internal-worker-harness.ts
apps/web/src/test/integration/internal-worker-batch-heartbeat.test.ts
apps/web/src/test/integration/internal-worker-derivative.test.ts
apps/web/src/test/integration/internal-worker-endpoints.test.ts
apps/web/src/test/integration/internal-worker-report-limits.test.ts
docs/adr/ADR-0843-op135-internal-worker-spec-split.md
docs/adr/README.md
```

No production file, no other record.

**4. The pins still bite.** Each mutation applied alone to
`apps/web/src/app/api/v1/internal/worker/report/route.ts`, run, and reverted from `HEAD`; the file was
restored byte-identically every time
(`sha256 fac5c7f112696370c5133c09f13d4303c0e8b93332a4ca9ff0454b79ee05e1af` before and after).

| probe            | mutation                                                                          | result on this tree                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0839 **P2**  | the pointer removed from the selfie arm's write filter (`{ _id: row.profileId }`) | filtered as recorded (`-t "F-A\|F-B"`): **`2 failed`** — F-A and F-B, both in the legacy spec. Unfiltered the same mutation reddens **6**: those two plus the four superseded-selfie pins (ADR-0832's case, P1, P3, P5), which the recorded probe filtered out.                                                                                                                       |
| ADR-0839 **P3**  | the guard's own profile read retargeted at `COLLECTIONS.selfies`                  | **`2 failed`**, both `Error: the route never read the profile, so the pinned window never opened` — F-A and F-B. The record says `1 failed`; **the base tree gives the same 2** (control run with the unsplit 2 706-line spec restored from `HEAD`), so this is a stale figure in that record, not a split effect: F-B was appended later in the same card and opens the same window. |
| ADR-0834 **F4a** | the lease decided at read time — `leaseFilter` reduced to `{ _id: row._id }`      | **`1 failed`**, exactly the F4 case of `internal-worker-report-limits.test.ts` (`1 failed \| 50 passed (51)` across the four files).                                                                                                                                                                                                                                                  |

A split that broke the spy coupling would read `0 failed` on all three. It does not.

**5. Gates.** `pnpm typecheck` exit `0` (all three projects); `pnpm lint` exit `0` — 0 errors, and none
of the five touched files appears in the existing `security/*` warning report; `pnpm format:check`
clean; the six `adr-*` guard specs green (**6 files / 236 passed**); `pnpm test:unit` **186 files /
3 127 passed | 3 skipped (3 130)**; `pnpm test:int` **145 files / 1 500 passed (1 500)** — the same
cases as the base run, in three more files. No per-case timeout is added: ADR-0841's
`INTEGRATION_TEST_TIMEOUT_MS = 30 000` project budget is unchanged and `vitest.config.ts` is not edited.

**6. Relocation fidelity.** Each file's body — everything after its docblock and import block — was
compared with its base slices as whitespace-collapsed text, with the harness's added `export` keywords
removed: all five are **identical**. Two harness declarations (`domainEventsHandler`,
`activationDeliveryKey`) re-wrap to a second line because `export ` pushed them past prettier's 100
columns; nothing else in a case body, title, assertion or fixture changed.
