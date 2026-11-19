# ADR-0881 — OP-136 TEST: S4's page-slot claim is corrected, and the nudge window's bounded residual is pinned

- **Status:** Accepted (claim correction + characterization pin — green on arrival
  against the landed GREEN ADR-0880, so the PR is non-draft and merges)
- **Card:** OP-136 TEST `t_d338af8c` (Low; finding **F1** of the review of the
  OP-136 TEST card `t_957106bc`, PR #732 head `7f875b79` / ADR-0879, signed off
  through PR #737 as `6854a62e` / ADR-0880). Branch
  `OP-136-task-nudge-slot-residual-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/op136-sweep-drain`, cut from
  `origin/main` `9a3b8eeb`.
- **Implements:** nothing. This record changes **no** production file: it
  corrects a claim carried by a test title and its prose, and pins executably the
  residual that claim was hiding.
- **Consumes:** [ADR-0879](ADR-0879-op136-sweep-drain-shapes.md) §3 and
  §Pin inventory item **S4** (the text corrected here; ADR-0879 is frozen once
  PR #732 landed and is **not** edited),
  [ADR-0880](ADR-0880-op136-sweep-drain-shapes-green.md) §3 (the
  `verification-nudge` clock window as shipped —
  `createdAt in (now − 96 h, now − 24 h]`, `.sort({ _id: 1 })` before `limit`),
  [ADR-0860](ADR-0860-op136-indexed-check-scan-drain-shape.md) §4 (the no-marker
  pin vocabulary the appended case keeps), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 items 18–21 (an
  exhausted lane block keeps its range and draws from the pool, advancing both
  cells).
- **Consumers:** `apps/web/src/test/integration/job-sweep-drain.test.ts`.
- **Findings:** **F1** (Low, test-quality / record accuracy) of the review of
  `t_957106bc`.
- **Number allocation:** `0881`, a **pool draw**. The OP-136 lane block
  `0849`–`0868` is exhausted, and both `Next free` cells read `0881` at
  `9a3b8eeb`. The sweep immediately before minting found: the trunk's highest
  record is `0880`; every `.worktrees/*/docs/adr` tree tops out at `0880`; and
  `git rev-list --objects --all -- docs/adr` tops out at `0880`. The open PR
  heads — #690 (max `0876`) and #272 (max `0306`) — carry no `ADR-0881`. So this
  record takes `0881` and advances **both** cells to `0882`. No range is re-cut.

## Context — the measured inaccuracy

The case that ADR-0879 §Pin inventory calls **S4** was titled

> _the page is not spent on a ladder-exhausted account, so the two accounts
> behind it are reached_

and ADR-0879 §Pin inventory stated the same guarantee — "the ladder-exhausted
row must not spend a page slot". Both overstate what the **decided** shape
gives. Under the clock window that ADR-0880 §3 shipped, the S4 fixture's 120-hour
row is spared a page slot by its **age** (120 h > the 96 h upper bound, so the
query never selects it), not by its exhausted ladder: the ladder has nothing to
do with the answer.

The review of PR #732 measured the difference in a throwaway `--detach` probe
worktree at `7f875b79`, on the decided shape, with the exhausted row **inside**
the window:

- 50 h old, `userProfiles.verificationNudges: 2`, inserted **first**, plus 30 h
  and 40 h with `verificationNudges: 0`, `requestedLimit: 2`, one run →
  `{ scanned: 2, nudged: 1, counts: { exhaustedInsideWindow: 0, thirty: 1,
forty: 0 } }`.
- So the exhausted-but-recent row **does** spend a page slot, and the 40-hour
  eligible account is not reached on that run. The residency is still bounded —
  the row can hold a slot only while it is inside the window (≤ 96 h) — so the
  drain still terminates. The guarantee is "a row **past** the clock window does
  not spend a slot", not "an exhausted row never does".

`apps/web/src/server/jobs/verification-nudge.ts` at this base is the shipped
shape and reads exactly that way: the candidate filter is
`{ emailVerified: { $ne: true }, createdAt: { $lte: now − 24 h, $gt: now − 96 h } }`,
followed by `.sort({ _id: 1 }).limit(limit)`. Age, not ladder state, is what
admits a row; ladder state only decides whether the admitted row gets a nudge.

## Decision

### 1. The claim is corrected; every assertion value stays byte-identical

In `apps/web/src/test/integration/job-sweep-drain.test.ts` only prose changes in
the existing case (no fixture, no seed, no seed order, no matcher and no expected
value moves):

- the case title becomes **"a row past the clock window gives its page slot
  back, so the accounts behind it are reached"**;
- its Arrange comment states why the row is spared — 120 h is past the clock
  window, so it is spared by its **age**, not by its exhausted ladder;
- its two assertion **messages** are restated in the same terms (they are prose
  carried by `expect`, not the assertions: `toBe(2)` and
  `toEqual({ exhausted: 0, thirty: 1, forty: 1, fifty: 0 })` are untouched);
- the spec header's item 3 and its closing seed-order paragraph are restated, so
  no sentence in the file still repeats the overstated guarantee.

The claim correction is stated by reference from this record because ADR-0879 is
frozen: it is not edited, marked superseded or amended.

### 2. The bounded residual is pinned executably (`S6`)

One case is appended inside the existing
`describe("when the verification ladder has more candidates than one run may
examine")`, after `S5`:

- **"a ladder-exhausted row inside the clock window still spends a page slot, so
  the eligible row behind it waits"**
- Fixture: a `user` 50 h old whose `userProfiles` row carries
  `verificationNudges: 2`, seeded **first**; behind it two eligible accounts at
  30 h and 40 h with `verificationNudges: 0`. All three seeded through the
  file's own `seedAccount`, in that order, and nothing else.
- One run with `requestedLimit: PAGE` (`2`) and the file's `fixedClock(NOW)`.
- Two assertions, both on observables the file already uses:
  `detail(run, "nudged")` is `1`, and `outboxCounts(NUDGE, …)` is
  `{ exhaustedInsideWindow: 0, thirty: 1, forty: 0 }`.

The labels are the case's own (`exhaustedInsideWindow`, `thirty`, `forty`) so a
failure names the row that moved. The case names **no** marker field, no
constant, no sort key and no `scanned`/`hasMore` value (ADR-0860 §4): a correct
implementation with a different field name, a different bound inside the stated
margins or an ordered cursor satisfies it, and `hasMore: scanned >= limit` is
true of a draining window and a starved one alike, so it could not discriminate.

It asserts one `nudged` and `forty: 0` deliberately: the point of the pin is that
the recent exhausted row **does** cost a slot, so the row behind it waits. It
does not assert that the drain eventually reaches `forty` — that is the clock
bound ADR-0879 §3 already records, and S4/S5 pin its edges.

### 3. Deliberately not done

- ADR-0879 is not edited (frozen), so no `Superseded by` marker is added either:
  the corrected claim is this record plus the spec's own prose.
- `S5` is untouched, including its keyed `payload` assertion
  (`{ rung: "t+24h" }` / `{ rung: "t+72h" }`): the ladder's rung names are the
  feature's public payload, not mechanism, and the card scopes this change to S4
  and one appended case.
- The seed helpers (`seedAccount`, `seedProfile`, `seedSession`, `outboxRows`,
  `outboxCounts`, `detail`), the other four cases, the two neighbouring specs
  (`job-sweep-failure-windows.test.ts`, `job-sweep-account-lifecycle.test.ts`)
  and every `adr-*` fixture are untouched, so the frozen byte-identity claims of
  ADR-0879/ADR-0880 still hold for them.
- No production file is touched: `git diff --name-only origin/main...HEAD` names
  the spec, this record and `docs/adr/README.md` only.

## Consequences

- The spec now states two different guarantees in two different cases, and each
  is enforced separately: S4 reds if the upper clock bound widens enough to
  admit a 120-hour row; S6 reds if the page stops costing a slot for a recent,
  ladder-exhausted row (probes M1/M2 below). Before this record the second
  guarantee was stated nowhere and the first was stated under the wrong name.
- The lane's accepted residual is now two-sided: a row **inside** the window with
  no rung left costs a slot (S6), and a row **past** the window is not a
  candidate at all and is left un-nudged rather than nudged late (S5). Both are
  bounded, so neither stops the drain.
- The spec grows from 5 to 6 cases (`+71/−21` in that one file); no other spec,
  helper, fixture or production module moves.
- `docs/adr/README.md` is the shared-ledger hotspot: this row, the note and the
  two cells merge as a union keeping the higher cells (`0882`).

## Alternatives

1. **Edit ADR-0879's §Pin inventory sentence in place.** Rejected: ADR-0879 is
   frozen once PR #732 merged, and this repository's rule is "never edit an
   accepted ADR — supersede it with a new one". An in-place edit would also make
   the review's quoted text (head `7f875b79`) unreproducible.
2. **Rename only, append nothing.** Rejected: that is the finding — a corrected
   sentence with no executable pin leaves the real behaviour (a recent exhausted
   row costs a slot) unstated and free to drift, which is exactly how the
   original overstatement survived review.
3. **Pin `scanned` / `hasMore` in the new case.** Rejected: ADR-0860 §4's
   vocabulary, and neither discriminates — a draining page and a starved one
   report identically (`hasMore: scanned >= limit` is true of both).
4. **Add a second run so the pin also shows `forty` being reached.** Rejected:
   the card names one run and the measured observable is that run's; a second run
   would pin the clock bound a third time (S4 and S5 already do) and would make
   the case fail for two different reasons at once.

## Evidence

Base `origin/main` `9a3b8eeb`. The decided shape is on the trunk (ADR-0880
merged as `6854a62e`; `verification-nudge.ts` carries `.sort({ _id: 1 })`, the
`(now − 96 h, now − 24 h]` window and `MAX_CANDIDATE_AGE_MS = 4 × MS_PER_DAY`),
so the appended case is written against a shipped shape.

Lane spec, before and after the append (the same `-t`-free focused run):

```
baseline  (5 cases):  Test Files  1 passed (1)   Tests  5 passed (5)
delivered (6 cases):  Test Files  1 passed (1)   Tests  6 passed (6)
```

Green on arrival, as the card requires — a characterization pin, not RED, so no
GREEN sibling exists. The case is not vacuous: two probes, each applied to
`verification-nudge.ts` alone in the lane worktree and reverted byte-identically
afterwards.

| Probe | Mutation of `verification-nudge.ts`                      | Result                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | the page's sort flipped to `.sort({ createdAt: -1 })`    | `1 failed \| 5 passed (6)` — **S6 alone**, `AssertionError: the page carries the exhausted row and one eligible account, so exactly one nudge is due: expected 2 to be 1`. S4 stays green, so S6 judges the slot, not the window.                   |
| M2    | `MAX_CANDIDATE_AGE_MS = 6 × MS_PER_DAY` (window widened) | `2 failed \| 4 passed (6)` — **S4 and S5**, `the page is two candidates: a row past the clock window takes no slot, so two eligible accounts fit: expected 1 to be 2` and S5's per-rung counts. **S6 stays green**, so it does not judge the bound. |

The two red sets are disjoint where it matters: M1 reds only the new case, M2
reds only the two window-edge cases, which is the evidence that the appended pin
adds a guarantee rather than restating one. The file was restored
byte-identically (`sha256 38064a396f525ab9e05888d20c7055b9f9612069ad50a27f613dae0aeba1bb17`
before and after, `git status --short` showing only the spec).

Gates at the delivered head: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
`prettier --check` clean on the spec, this record and `docs/adr/README.md`; the
six `adr-*` guards green; the two neighbouring specs
(`job-sweep-failure-windows.test.ts`, `job-sweep-account-lifecycle.test.ts`)
green; `eslint` 0 errors on the spec (one pre-existing
`security/detect-object-injection` warning in `detail`, carried from the base).
`git diff --numstat` is `71 21 apps/web/src/test/integration/job-sweep-drain.test.ts`
plus this record and the ledger row, cell and note. No number outside `0881` is
consumed.
