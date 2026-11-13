# ADR-0824 — OP-132 TEST: `firstMatchNotifiedAt` is stamped by the first delivery and never moved

- **Status:** Accepted (characterisation pin; green on the cut, no production change)
- **Consumers:**
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts` — the
  appended describe `when a confirmation is the profile's first delivery` (four
  cases, `:880`) and the three file-local helpers it adds (`WatermarkRow`, `:851`;
  `firstMatchNotifiedStamp`, `:861`; `firstDeliveryStamp`, `:872`). It reuses the
  file's own `readyEvent`/`submitOne`/`runWorker`/`confirm`/`profileRow`/
  `matchesNewRows` and its `FIRST_RUN_MATCHES`/`SECOND_RUN_NEW_MATCHES`
  constants; the helper module `../helpers/selfie-flow.ts` is **not** touched.
- **Lane:** both `Next free` cells were **re-read at this head** (`origin/main`
  `5a0c8e0`) and read **`0824`** — the `OP-129 attendee identity lane` row and the
  `unallocated (future lanes)` pool row. The sweep found nothing above `0823`
  anywhere: `git rev-list --objects --all -- docs/adr` returned
  `ADR-0822-op134-my-events-gallery-url-green.md` and
  `ADR-0823-op132-confirm-burst-budget.md` as the highest objects, no
  `.worktrees/*/docs/adr` carries `0824`–`0829`, and no open PR head does
  (`gh pr list --state open`: the live ADR-carrying heads are 0818/0819/0820 on
  PRs #573/#574/#575). This record therefore draws **`0824`** and both cells
  advance to **`0825`**. No lane row is minted.
- **Amends:** the unpinned sentence in
  [ADR-0806](ADR-0806-op132-confirm-publication-green.md) §Decision ("§15.3's
  `firstMatchNotifiedAt` is stamped by the first delivery inside the same
  transaction"), and the aside in
  [ADR-0805](ADR-0805-op132-confirm-publication-pins.md) §Assumptions ("the pins
  do not require that field by name, only the count a client sees"). Neither
  record is edited; this one adds the pin they left owed.
- **Consumes:** `0824`.

## Context

Schema §15.3's `firstMatchNotifiedAt` is the "fires exactly once" anchor of the
match notification, and the shipped confirmation is its **only** writer. At
`origin/main` `5a0c8e0`
(`apps/web/src/app/api/v1/p/events/[slug]/selfies/[selfieId]/confirm/route.ts`,
sha256 `94b91fb3…`):

- `:69` declares `firstMatchNotifiedAt?: Date | null` and `:98` projects it;
- `:135` reads `firstDelivery = firstMatchNotifiedAt === undefined || null`;
- `:159` writes `...(willPublish && firstDelivery ? { firstMatchNotifiedAt: now } : {})`
  — inside the same transaction as the `attendee.matches.new` insert, only when
  that transaction actually delivers, and only on the profile's first delivery.

`grep -rn firstMatchNotifiedAt apps packages --include=*.ts` finds exactly three
sites besides the route: the two profile-creation writes (`selfie-submit.ts:211`,
`liveness/challenges/route.ts:82`, plus the consent route's `consent/route.ts:152`)
all set `null`, and nothing else writes the field. So the route is the sole
producer, and a regression in it is invisible to the contract unless a spec reads
the field.

It was invisible: the review of `t_ed3785df` / PR #557 measured a throwaway tree
at `e5af1ac` with the `:139` stamp spread deleted, and
`vitest run --project integration selfie-confirm-publication liveness-selfie-submit`
answered **2 files / 24 passed, 0 failed**. ADR-0806 §4 described the write;
ADR-0805 deliberately did not pin it by name; no other spec reads it. That is a
Low-severity coverage gap with a silent-regression shape, which is what this card
closes.

## Decision

**One appended describe, four arms, each an independent case.** The file already
owns the fixture chain and the readers this needs, and the card forbids editing
an existing case, so the block is additive: `137 insertions(+)`, zero deletions,
no existing assertion or helper re-formatted.

1. **Arm 1 — a delivery stamps the field, with the confirm's own instant.**
   Confirm a selfie whose worker run produced `FIRST_RUN_MATCHES` (3) matches.
   Before the call the field is asserted `null` (both creation sites write
   `null`, so a value can only come from the delivery); the delivery is
   observed (one `attendee.matches.new` row carrying `count: 3`); then the field
   is a `Date` inside a **real-clock bracket** captured immediately before and
   immediately after the `confirm` call.
2. **Arm 2 — no delivery, no stamp.** Confirm a selfie whose worker has not run
   (the `processing` arm that `liveness-selfie-submit.test.ts` I9b pins). The
   answer is `status: "processing"`, the outbox stays empty, and the field stays
   `null`. Nothing new is pinned about the `processing` arm itself; it is the
   starting point that makes the stamp's absence attributable.
3. **Arm 3 — a later delivery does not move it.** After arm 1, submit and
   confirm a second selfie whose worker run finds `SECOND_RUN_NEW_MATCHES` (2).
   The outbox gains its **own** row carrying `count: 2` — so this is a delivery,
   which is what makes the case discriminating — and the field still reads arm
   1's instant.
4. **Arm 4 — a repeat confirm does not move it.** Confirm the first selfie
   again: the same `200` envelope, still **one** outbox row for that selfie, and
   still arm 1's instant.

**The time assertion is a real-clock bracket, not a tolerance.** The card leaves
the choice open between (a) a small tolerance around `Date.now()` at the call and
(b) "`instanceof Date` and `>= updatedAt − tolerance`. The bracket is strictly
stronger than both and needs no constant: the route reads `systemClock.now()`
**once** per request (`route.ts:113`) and writes that single instant, so the
stamp cannot precede the request and cannot follow the answer. Reading the
sibling field `updatedAt` instead would couple this pin to a second column the
card does not name, and a "within N ms of `Date.now()`" tolerance only widens a
window that a correct implementation needs to be zero. The test app invokes the
route handler in-process, so the bracket compares one clock to itself; an
out-of-process invocation (an e2e) would need a tolerance, and that is recorded
below as a known limit rather than silently guessed.

**The field is read through a local cast, not through a widened helper.** The
file's `ProfileRow` (`:250`) declares only the columns its earlier cases read and
`../helpers/selfie-flow.ts` is frozen, so `WatermarkRow` (`:851`) names the one
extra field and the read site casts once
(`(await profileRow()) as unknown as WatermarkRow`). `firstMatchNotifiedStamp`
normalises `undefined`/absent to `null`, so arm 2's assertion is "no stamp",
not "no key" — the schema's two spellings of "never delivered".

## Evidence — measured on this head (`origin/main` `5a0c8e0`, branch `b41754c`)

**The four arms are green on the cut, and nothing else moved.**

- Focused: `vitest run --project integration selfie-confirm-publication` →
  `Test Files 1 passed (1)`, `Tests 19 passed (19)`. The file's 15 shipped cases
  (the repeat, the new-count, both late-publication cases, the pair and the ten
  burst rounds) are unchanged and green; the four new arms are the remaining
  four.
- Whole projects: `--project unit` → `Test Files 178 passed (178)` /
  `Tests 2938 passed | 3 skipped (2941)`; `--project integration` →
  `Test Files 131 passed (131)`, `Tests 1350 passed (1350)`. No other spec moved.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
  `npx eslint <spec>` exit `0`; `npx prettier --check <spec>` —
  "All matched files use Prettier code style!".

**The pin is load-bearing: three mutations in a throwaway worktree, each
restored and removed.** The probe was `git worktree add --detach <scratch>/probe-fba391ab b41754c`
with the three `node_modules` symlinks; each mutation edited only the confirm
route, the focused spec was re-run, and the route was restored with
`git checkout --` after every pass (`git status --short` and `git diff` empty
before the worktree was removed with `git worktree remove --force`).

| Mutation                                      | Change to `route.ts`                                    | Result                                                                   |
| --------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| **M1 — the stamp deleted** (the card's probe) | the `:159` spread removed                               | `Tests 3 failed \| 16 passed (19)`; arms **1, 3 and 4** red, arm 2 green |
| **M2 — the `firstDelivery` gate dropped**     | `...(willPublish ? { firstMatchNotifiedAt: now } : {})` | `Tests 1 failed \| 18 passed (19)`; arm **3** red only                   |
| **M3 — stamped on every confirm**             | `firstMatchNotifiedAt: now,` unconditionally            | `Tests 3 failed \| 16 passed (19)`; arms **2, 3 and 4** red, arm 1 green |

The failure text, verbatim:

```
# M1, arms 1/3/4 (each at its arm-1 precondition)
Error: expected the first delivery to stamp firstMatchNotifiedAt, received null

# M2, arm 3
AssertionError: expected 1794600994694 to be 1794600994635 // Object.is equality

# M3, arm 2
AssertionError: expected 2026-11-13T20:16:58.920Z to be null
# M3, arms 3 and 4
AssertionError: expected 1794601019200 to be 1794601019125 // Object.is equality
AssertionError: expected 1794601019402 to be 1794601019381 // Object.is equality
```

Read honestly, the table says three things a single mutation could not:

- **Arm 1 is the only arm that reds on a missing stamp and stays green when the
  stamp is merely too eager** (M3), so it pins "the first delivery stamps", not
  "some delivery stamps".
- **Arm 2 cannot red on a deleted stamp** — it asserts absence, which a deletion
  satisfies. M3 is the mutation that proves arm 2 bites, and it does so with the
  field's own value in the message.
- **Arms 3 and 4 red at their arm-1 precondition under M1**, not at their
  "not moved" assertion — unavoidable for a pin whose subject is the first
  delivery's stamp, and the reason M2 exists: under M2 arm 1 is green and arm 3
  reds at `expected 1794600994694 to be 1794600994635`, which is the "never
  moved" assertion itself, on a 59 ms gap between the two deliveries. Arm 4's
  own "not moved" assertion is exercised by M3 (a 21 ms gap). So each arm's
  distinctive assertion is reddened by at least one mutation.

**Why the equality assertions are not a same-millisecond coin flip.** Arms 3 and
4 compare the observed instant with `toBe`. A re-stamp is only indistinguishable
from the original if it happens in the same millisecond; the measurements above
put the gap between the first delivery and the second at **59 ms** (M2) and
**21 ms** (M3), and the gap between the first delivery and its own repeat at
**21 ms**, each across several round trips (an object put, a challenge, a submit,
the worker's writes, a confirm). The gap is measured on every run, so a future
tree that collapses it would show up as an unexpected pass, not as a flake.

## Consequences

- **Schema §15.3's "fires exactly once" anchor is now regression-visible.** A
  later change that drops the stamp, gates it on `published` instead of
  `willPublish`, or writes it on every confirm now reddens this file with the
  field's name in the message — the class of regression the review measured
  passing silently at `e5af1ac`.
- **The pin states a behaviour, not a mechanism.** It reads only the stored
  profile document and the outbox; it does not care whether the stamp is written
  by the confirm, by a `$set` in the same transaction, or (in future) by the
  pipeline's internal endpoint, as long as the first delivery stamps once and
  nothing moves it.
- **Known limit — the bracket requires in-process invocation.** The
  `[before, after]` window is exact because the integration harness calls the
  handler in this process, on the same clock. An e2e (real HTTP, separate
  server) would need a tolerance; no e2e asserts this field today and this record
  does not add one.
- **Known limit — same-millisecond delivery would be invisible.** If a future
  implementation delivered two selfies inside one millisecond, arm 3's equality
  would pass on a re-stamp. Measured gaps are 21–59 ms, so the residual is
  theoretical, and it is recorded rather than papered over with a sleep.
- **Known limit — the field's other writers are somebody else's pin.** The
  pipeline's `POST /api/v1/internal/domain-events` and
  `POST /api/v1/internal/worker/report` (OP-135, [ADR-0808](ADR-0808-op132-late-match-publication-ownership.md))
  do not ship at this head. When they do, they become candidate writers of this
  watermark, and **that** path needs its own pin; this record covers the confirm
  only, which is the only writer today.
- **No production, fixture or helper change.** The diff is one spec file
  (`137 insertions(+)`); `../helpers/selfie-flow.ts` and every other spec are
  byte-identical to `origin/main`.
- **This is a characterisation pin, so the PR is not RED-by-design.** It is
  green on the cut and is meant to land: the reviewer decides the merge, not a
  separate GREEN card.

## Alternatives

- **Assert `firstMatchNotifiedAt.getTime() === updatedAt.getTime()`.** Rejected:
  it pins a relationship between two columns the card names only one of, and a
  legitimate future refactor that computes the two instants separately (or stops
  writing `updatedAt` at all) would redden a spec whose subject is the watermark.
- **Assert `|firstMatchNotifiedAt − Date.now()| < N`.** Rejected as strictly
  weaker: it needs a constant nobody can justify, and it would pass a stamp
  written slightly _before_ the delivery — exactly the bug class ("a submit-time
  default", or a stamp taken outside the transaction) it is meant to catch.
- **Freeze the clock (`vi.useFakeTimers()` / `vi.setSystemTime`) and assert
  equality.** Rejected: the case runs a real `MongoMemoryReplSet` transaction
  with driver retries and TTL bookkeeping; fake timers in that harness change
  the retry and commit semantics the neighbouring cases depend on. The bracket
  gets the same determinism without touching the runtime.
- **A new spec file.** Rejected: the file already owns `readyEvent`/`submitOne`/
  `runWorker`/`confirm`/`profileRow`/`matchesNewRows`, its `beforeEach` cleanup
  list and `FIRST_RUN_MATCHES`; a second copy of the chain would be a second
  thing to keep honest, and a second app boot for one file.
- **Widen `ProfileRow` or `../helpers/selfie-flow.ts` to carry the field.**
  Rejected: the card freezes the helper module, and the file's local interface is
  the earlier cases' contract — a local `WatermarkRow` cast at one read site is
  the smallest honest change.
- **Pin the field on the `processing` arm as well as the `ready` one (a single
  mega-case).** Rejected: one behaviour per case. Four arms fail with four
  different messages, which is what lets the implementation agent (or a future
  reviewer) see **which** half of the contract regressed.

## Out of scope

- The pipeline's own writer of this watermark (OP-135/OP-136, ADR-0808) — no
  such endpoint exists at this head.
- Whether the two creation sites should write `null` versus omit the field. The
  pin normalises both spellings, so either is allowed.
- The §6.4 notification **count** and the §7.6 delivery identity: pinned by
  ADR-0805/ADR-0808 and unchanged here.
- The burst/pair concurrency behaviour of the confirmation (ADR-0816/ADR-0821) and
  the failing-transaction arm (ADR-0820) — different files, different records.
