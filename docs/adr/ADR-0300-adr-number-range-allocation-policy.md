# ADR-0300 — ADR numbers are drawn from per-lane reserved ranges, never from the shared high-water mark

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (process) — allocate per-lane ADR-number ranges (`t_a83e7ff3`, orchestrator; raised by the review of `t_a3d52d6e`, PR [#213](https://github.com/yahodu/openpic-webapp/pull/213))
- **Relates to:** [ADR-0128](ADR-0128-op96-green-review-signoff.md) (the OP-96 integration renumber), [ADR-0133](ADR-0133-op96-f1-f4-round2-red.md) (an earlier cross-lane allocation settled by card `t_cf0b1f77`), [ADR-0138](ADR-0138-op96-f1-unrecorded-flush-bound-red.md) / [ADR-0141](ADR-0141-op96-f1c-r2-redelivered-digest-cap-green.md) / [ADR-0143](ADR-0143-op96-flush-overlap-single-send-green.md) / [ADR-0145](ADR-0145-op96-f1-unrecorded-flush-bound-green.md) (the number collisions this policy ends)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

Until now the allocation rule was _"take the lowest `ADR-0nnn` free against a
fresh `origin/main` **and** every open ref, immediately before committing"_. That
makes the number a function of global board state at one instant, and every other
lane that merges in between invalidates it. On 2026-10-20 alone:

- the OP-101 lane (`t_a3d52d6e`, PR #213) was renumbered **three** times
  (`0128 → 0129 → 0142`);
- the OP-96 lane was relocated **four** times in a day
  (`0100–0106 → 0110–0116 → 0111–0118 → 0120–0128`), and again per round-3 card;
- `0143` was simultaneously claimed by two OP-96 refs (PR #220 and PR #221), and
  `0144` by `main` (PR #224) and `OP-96-task-quiet-release-flake-red` (PR #225),
  so PRs #225 and #221 sat `mergeable: CONFLICTING`;
- `docs/adr/README.md` and the `ADR-01xx` numbering were flagged as a hotspot by
  at least three prior cards (`t_609968cf`, `t_a4cdff8f`, `t_a3d52d6e`) with no
  owner assigned.

Every lane appends a row and a note to the same two regions of `README.md`
(the table tail and the trailing lane notes), so the tail of that file is a
**serialization point** for the whole board. The conflict is structural — same
file region — not semantic: two lanes never disagree about an ADR, they merely
want the same integer. Two of the three OP-101 renumbers cost a full re-review
cycle (`kanban_request_changes` → rebase → re-run CI → re-request review).

## Decision

Adopt **per-lane reserved ranges** as the binding allocation policy for
`docs/adr/`:

1. The **orchestrator is the allocator**. It assigns each lane (`OP-<n>`) a
   disjoint range of numbers **up front**, before any of that lane's cards are
   dispatched, and writes the range into every card body of the lane. Ranges are
   recorded in `docs/adr/README.md` § "ADR number allocation".
2. A lane takes its next ADR number as the **next unused number inside its own
   range** (a lane-local counter). It **never** consults `origin/main`'s
   high-water mark, the tail of `README.md`, or another lane's refs. Because
   ranges are disjoint by construction and are never re-cut, two lanes cannot
   collide even though neither inspects the other's branches.
3. Gaps inside a range, and ranges that go unused, are **expected and cheap**: a
   number is consumed once and is never reissued to another lane. The allocator
   may size a lane's range above the 20-number default when the lane's observed
   ADR volume warrants it (OP-96 received 34).
4. Numbers allocated **before this policy** (`≤ 0145`) are **frozen history** and
   are never moved; a branch that already carries one keeps it and draws only its
   _new_ ADRs from its reserved range.
5. **Board-wide / process** decisions that belong to no single lane draw from the
   allocator-owned `board-wide` range (`0300`–`0319`); this record consumes its
   first slot (`0300`).
6. Reserved ranges in force at adoption:

   | Holder (lane)                       | Reserved range                  | Next free |
   | ----------------------------------- | ------------------------------- | --------- |
   | board-wide / process (orchestrator) | `0300`–`0319`                   | `0301`    |
   | OP-96 notifications follow-up       | `0146`–`0179`                   | `0146`    |
   | OP-97 in-app feed                   | `0180`–`0199`                   | `0180`    |
   | OP-94 fan-out                       | `0200`–`0219`                   | `0200`    |
   | OP-98 notification preferences      | `0220`–`0239`                   | `0220`    |
   | OP-99 one-click unsubscribe         | `0240`–`0259`                   | `0240`    |
   | OP-100 tenancy                      | `0260`–`0279`                   | `0260`    |
   | OP-101 CI lane-shape                | `0280`–`0299`                   | `0280`    |
   | unallocated (future lanes)          | `0320`+ (20 per lane, in order) | `0320`    |

7. **Semantics of the `Next free` cell** (2026-10-22, card `t_815703d7`). The
   `Next free` cell in [README](README.md) § "ADR number allocation" is a
   **reservation counter**, not a count of landed files. A number in a lane's
   range is **taken** — and therefore not "next free" — once **either** (a) an
   `ADR-0NNN-*.md` with that prefix is on `main`, **or** (b) the number is
   allocated to any card or ref of that lane which has not yet landed (an
   _in-flight_ allocation: an open branch/PR of the lane, or a live card of the
   lane that has been assigned the number). In-flight allocations **reserve**
   the number: the counter is monotonic and a number is never reissued to
   another lane nor rewound when an allocation is abandoned (gaps are expected
   and cheap — item 3). The cell always names **the number the next
   newly-started card in the lane will receive**, so a card that writes the
   ledger _excludes its own just-made allocation_: a card consuming `0NNN`
   writes the next unallocated number above `0NNN`. Rationale: the lane-local
   counter is shared across a lane's **concurrent** cards, so "taken" must
   include in-flight allocations — otherwise two cards in one lane compute the
   same "next free" and collide. That is exactly the 2026-10-22 OP-96 `0147`
   race: PR #235 wrote its own in-flight number as the cell while the sibling
   fixture-clock card counted `0147` as taken. This is what makes the integer
   knowable before the branch exists (item 1).

## Consequences

- Two lanes can no longer collide: the integer a lane will use is knowable before
  its branch exists, so `README.md` stops being a merge serialization point.
- Renumber cycles, rebases and re-review loops caused purely by number races end.
- The README grows a small, stable ledger (ranges + frozen pre-policy numbers)
  that the allocator maintains; lanes append only their own row, as before.
- Numbers are no longer dense: the table will show gaps (e.g. `0145 → 0300`) and
  a lane may skip numbers it never uses. This is deliberate and cheap.
- The allocator now owns a step it did not have before: assigning a range when a
  lane is created. If skipped, the lane must not invent a number — it should ask
  the allocator (the rule is "next free _in my range_", and an unallocated lane
  has none).
- A purely mechanical duplicate-prefix check (two files in `docs/adr/` sharing an
  `ADR-NNNN`) remains worthwhile as a backstop and is recorded separately in
  [ADR-0302](ADR-0302-adr-number-guard-contract.md); this record is the policy,
  not the guard.

## Alternatives

- **(b) Merger-owned finalisation** — the _merger_ assigns the number when the
  branch lands, the ADR file carrying a placeholder (`ADR-NNNN-…`) until then.
  Rejected: it serializes renames at merge time instead of removing them (every
  merge rewrites a filename and every cross-reference), and it moves authorship
  of a decision artifact into the merge action, which the board runs as a
  mechanical `--squash --admin` step.
- **(c) Append-only file, number derived from position** — a single `docs/adr/`
  log where the number is the row index. Rejected: it renames history. ADRs are
  cited by number throughout code, tests, the `docs/` design docs and other
  ADRs; positional numbers would invalidate every existing citation on the next
  insert.
- **Keep "lowest free number at commit time"** — rejected: it is the status quo
  that produced four renumbers in a day and two `CONFLICTING` PRs; the check is
  unenforceable because it is stale the moment it is computed.

## §8 — Same-lane concurrency: reserve at creation (rule A)

_2026-10-25, card `t_e5485868` (orchestrator) — the OP-105 lane follow-up that
closes the two same-lane number collisions._

§7 makes an in-flight allocation count as **taken**, but it still leaves the
number to be _derived by the worker_ from the `Next free` cell it reads at its
branch cut. That value is a **snapshot of shared state**: two same-lane branches
cut from the same `origin/main` read the same cell and mint the same number. On
the OP-105 lane (`0380`–`0399`) that happened **twice** — first `0382` (two
records cut off `2baaf14`), then `0383`+`0384` (the drift-log pair against the
memory-provider pair, the same cut) — and each collision cost a review loop on
the lane (card `t_e5485868`; see the two _number collision_ notes in
[README](README.md)). Rule (A) replaces the snapshot with a reservation made
**before the branch exists**, so there is no shared value left to race on.

8. **Reserve at creation (rule A).** The **orchestrator is the allocator** (item
   1): it allocates each ADR number **when it creates the card** and writes
   `**Consumes: NNNN**` into that card's body — `none` for a card that mints no
   number, such as this in-place amendment. The worker takes the reserved number
   as given and **never** derives one from the `Next free` cell: not at its
   branch cut, not immediately before committing, not to "advance the counter".
   The cell becomes **informational** — it records the lane's reservation
   high-water, and the card that lands a ledger row sets it to
   `max(consumed)+1`. A card with no reserved number asks the allocator; it never
   invents one. This supersedes the practice the §7 notes describe ("the cell's
   value re-read at the branch cut immediately before committing"), which is what
   produced both OP-105 collisions.
9. **Pre-push re-read of trunk _and_ sibling reservations.** Immediately before
   pushing, the worker re-reads (a) **trunk** — is `ADR-0NNN` already a file on
   `origin/main`? — and (b) the lane's **in-flight reservations**: the
   `**Consumes:**` values of the sibling cards, and any open branch/PR of the
   lane carrying an `ADR-0NNN-…` file. Either hit is a collision on a _claimed_
   number: the worker comments on the card and **blocks** — it never silently
   renumbers. Renumbering is what hides the collision; the reservation is the
   allocator's to re-issue.
10. **A `README.md` ledger conflict resolves as a union.** When the only conflict
    is `docs/adr/README.md`, resolve it by keeping **both** sides' rows in
    ascending numeric order and setting the lane's `Next free` cell to
    `max(consumed)+1` across both — **never pick-a-side**. A pick-a-side
    resolution silently drops the lane's own row, which is how the first OP-105
    collision presented as an ordinary index-only conflict; the union keeps both
    rows, so a duplicate number stays visible to the guard and to the reviewer.
    The mechanical half (a `prettier --write` to normalise the widened column
    padding) is recorded in `docs/CONVENTIONS.md` §11.

Rationale for (A) over serialising same-lane chains: rule (A) is closed under
concurrency _by construction_ — no card computes its number from shared state —
and it costs the allocator one field at card-creation time, where serialisation
costs the lane wall-clock and depends on a cross-chain ordering edge being
remembered. The choice is recorded on card `t_e5485868`.

## §9 — In-flight-aware allocation (2026-10-25, card `t_6b5e0fc9`)

_2026-10-25, card `t_6b5e0fc9` (orchestrator) — the OP-110 lane follow-up that
closes the third same-class number collision._

§7 makes an in-flight allocation count as **taken**; §8 (rule A) has the
**allocator** reserve the number when it creates the card. Neither closed this
collision, because **the reservation itself was derived from a snapshot**: two
cards in one lane, each told to "re-read the lane `Next free` cell", read the same
value on the same trunk and minted the same number. On the OP-110 lane
(`0480`–`0499`) that happened with two independently-rooted **pin** cards:

| pin card                             | branch                                  | commit               | record minted                                  |
| ------------------------------------ | --------------------------------------- | -------------------- | ---------------------------------------------- |
| `t_58320f19` (invoice-number decode) | `OP-110-task-invoice-number-decode-pin` | `2418ce7` @ 17:02:37 | `ADR-0482-op110-invoice-number-decode-pins.md` |
| `t_ffec14e2` (reactivation boundary) | `OP-110-task-reactivation-boundary-pin` | `89dbfd7` @ 17:06:44 | `ADR-0482-op110-reactivation-boundary-pins.md` |

The reactivation lane's gated GREEN (`t_805e17b6`) then minted a further record on
top of its pin branch, so the collision is **two-deep** in a stacked pin→green
pair. The invoice lane landed first (PR
[#346](https://github.com/yahodu/openpic-webapp/pull/346) → squash `c2ebc589`,
trunk `1d1943b`), making `0482` **trunk-owned**; the reactivation lane cannot land
without renumbering both of its records — renumber card `t_c83556f9`, gated on
`t_805e17b6`. That lane's renumbered numbers are still **in flight** and are
deliberately not asserted here. The failure is **invisible on the incoming
branch** — its own guard passes — and only reddens the **trunk's** unit job after
the squash, when `checkAdrDirectory("docs/adr")` sees two `ADR-0482` files.

This is the **third** recurrence of the class: OP-96 (`0147`, the §7 note) and
OP-105 (`0382`; then `0383`+`0384`, the §8 note) came first — hence the durable fix.

11. **In-flight-aware allocation (rule B).** Before the allocator hands a number
    to any card it **enumerates the lane's in-flight reservations** and takes the
    next free number **above the highest in-flight number** — never the number
    named by the trunk `Next free` cell, and never a value derived from a snapshot
    of shared state. The enumeration is:

    - **every live worktree's ADR files** —
      `for d in <repo>/.worktrees/*/; do ls "$d/docs/adr/" 2>/dev/null | grep -E '^ADR-0[0-9]{3}'; done`;
    - **the `Consumes` values of the lane's non-`done` cards** (board DB /
      `kanban_list`);
    - **the lane's open remote refs** — `git ls-remote --heads origin "OP-<n>*"`,
      reading `docs/adr/` at each head where reachable.

    The rule binds **whoever mints a card**, not the orchestrator alone: on this
    board reviewer and testcase-writer cards minted both colliding OP-110 pins. A
    card that mints no number still writes `Consumes: none` (§8 rule A).

12. **Pre-merge duplicate detection on the merged tree.** No ADR-carrying PR may
    squash-merge until the guard has run **on the merged tree** — not on the
    incoming branch — because a lone `docs/adr/README.md` conflict resolves cleanly
    while hiding a duplicate **file**:

    ```
    git fetch origin
    git worktree add --detach <scratch>/probe-adr-merge origin/main
    cd <scratch>/probe-adr-merge && git merge --no-ff <incoming-head>
    # symlink node_modules (root, apps/web, packages/contracts) from the main checkout, then:
    ./node_modules/.bin/vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts   # must pass
    ls docs/adr/ | grep -oE 'ADR-[0-9]{4}' | sort | uniq -d                                       # must be empty
    ```

    This is a **review-time obligation** (consistent with the guard's two
    documented out-of-scope items in `docs/CONVENTIONS.md` §11), **not** a CI
    change.

**Rejected alternative — "reserve the pair, not the number" (candidate 1).** It
covers only a pin+green pair riding **one** branch/PR. The OP-110 collision was
between two independently-rooted follow-up pins (as was OP-105's): a pair
reservation cannot see sibling pin B, which still reads the cell and re-mints A's
number. It is also subsumed by in-flight enumeration — both the pin file and the
reserved green number are visible to rule B — so it is recorded as a compatible
special case **inside** rule B, not as the primary rule.

**Rejected alternative — "land-then-renumber as primary" (candidate 3).** It does
not prevent the collision; it only makes the loser's repair cheap, and adopting it
as primary normalises a duplicate landing and shifts the cost onto the loser's
lane. It remains the **fallback recovery**, invoked only when detection catches a
duplicate: the existing `t_c83556f9` recipe already enumerates every field to
rewrite — file name, H1, every `Consumes`/cross-reference, the two README index
rows, the lane prose paragraph and the `Next free` cell; a `README.md` conflict
resolves as a **union** (§8 item 10) — so it is the canonical checklist and needs
no new script.

Rationale for rule B over reserving at creation alone: rule (A) removes the
_worker's_ snapshot but leaves the _allocator's_, and the allocator is not
serialised either — two follow-up cards created minutes apart each read the same
cell. Enumerating in-flight reservations before reserving makes the number a
function of what is actually outstanding rather than of a stale counter, at the
cost of one enumeration per card creation. The choice is recorded on card
`t_6b5e0fc9`.

## §10 — A block starts above the highest in-flight range END, and a range is exclusive (2026-11-12, finding F-L1, card `t_95e7ed1e`)

_2026-11-12, finding F-L1 (`t_95e7ed1e` lineage) — the OP-129 lane's block was
minted from the uploads lane's `Next free` cell and landed inside its range._

§7 makes an in-flight allocation count as **taken**; §8 (rule A) has the
allocator reserve a number **when it creates the card**; §9 (rule B) makes the
allocator enumerate the lane's in-flight reservations first. All three govern
**one lane's own** numbers. None of them said where a **new lane's block**
starts, and §7 was read as licence to take any unminted number — the OP-129
ledger note states the reading outright: _"a dependent ticket does not continue
its parent's range (ADR-0300 §7)"_. This section **supersedes that reading**. A
dependent ticket (one whose story builds on the holder's code — OP-127 and
OP-128 on the OP-126 uploads lane) **does** continue its parent lane's range; an
independent ticket gets a fresh block **above the highest in-flight range end**;
and no lane may mint a number inside another lane's range, including a gap that
holder has not consumed. The range **end**, not the `Next free` cell, is what
bounds the board, because the cell is a consumed-number counter and the range is
a reservation.

| fact (measured 2026-11-12 on `origin`) | value                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OP-126 uploads lane row                | `0760`–`0779`, `Next free` cell `0771` (branch `OP-128-task-account-status-gate-pins`, `cfed101`)                                                                                                                                 |
| OP-129 attendee-identity lane row      | `0769`–`0788`, `Next free` cell `0770` (PR [#444](https://github.com/yahodu/openpic-webapp/pull/444), branch `OP-129-task-anonymous-attendee-sessions-red-fix`)                                                                   |
| the two rows intersect                 | `0769`–`0779` — eleven numbers reserved twice                                                                                                                                                                                     |
| the collision it produced in flight    | `ADR-0770` exists twice: `ADR-0770-op129-anonymous-attendee-sessions-green.md` and `ADR-0770-op128-account-status-gate-green.md`                                                                                                  |
| why the block started at `0769`        | the allocator note says the lane drew "the allocator's unallocated pool `0769`–`0788`" because `0768` was the uploads cell at the time — i.e. `0769 = 0768 + 1`, a **consumed number plus one**, not the uploads range end `0779` |

13. **A block starts above the highest in-flight range END.** A new lane's block
    starts at **`max(end of every reserved range in flight) + 1`** — never
    `max(consumed number) + 1`, never the `unallocated` cursor alone, never the
    tail of the index. A `Next free` cell is a consumed-number counter: reading
    it and adding one (`0768` → `0769`) mints inside a range that is still open,
    which is exactly how F-L1 happened.
14. **A reserved range is exclusive to its holder.** No other lane may mint a
    number inside it, _including a gap the holder has not consumed_. A gap is
    cheap; a revoked range is not — re-cutting a reserved row means renumbering
    files that are already in flight and rewriting every citation of them.
15. **Dependent versus independent tickets.** A **dependent** ticket — one whose
    story builds on the holder's code (OP-127 and OP-128 on OP-126 uploads) —
    **continues its parent lane's range** and takes the next number inside it.
    An **independent** ticket gets its own block and never extends into another
    lane's range. This supersedes "a dependent ticket does not continue its
    parent's range", which is the sentence the OP-129 allocation relied on.
16. **The cursor follows the ranges.** The `unallocated (future lanes)` cursor
    is `max(closed range end) + 1`; the same commit that adds or re-cuts a row
    moves the cursor. A cursor left below a closed range end invites the next
    lane to start inside it.
17. **The mechanical half.** `checkAdrDirectory`'s `lane-range-overlap` check
    ([ADR-0302](ADR-0302-adr-number-guard-contract.md) §6) reports every pair of
    reserved rows whose **closed** ranges intersect, so an intersecting row is a
    CI failure rather than a review miss. It also reports a range-shaped ledger
    row it cannot parse (`lane-range-malformed`), so a ledger typo is a CI
    failure rather than a silent hole that quietly disables the check. It is the
    only half a tool can enforce: a _file_ numbered inside a foreign range
    remains a review-time defect, because the guard has no file→lane map.

**Rejected alternative — a `reserved:` list inside the README.** Already
rejected in §8/§9 for the same reason: a branch-local marker is a second source
of truth that goes stale the moment the ledger row changes, and a parser keyed
on it fails open when the marker is forgotten.

**Rejected alternative — a per-file lane annotation.** Naming the owning lane in
each ADR file (front matter or the H1) would let a tool check membership, but it
is a second source of truth that drifts from both the ledger and the file name,
and it must be written by the worker whose number is in question — the same
actor the check exists to constrain.

Rationale for keying the rule on the range **end**: the failure was not a
missing check but a wrong _reference value_. The allocator had a legitimate
question ("what is the highest number in use?") and answered it from the nearest
number-shaped cell in the file, which is a consumed count. The range end is the
only value in the ledger that is a reservation bound, and it is readable from
the same row, so the correct rule costs the allocator nothing extra to apply.
The choice is recorded on card `t_95e7ed1e`.

## §11 — An exhausted block draws from the pool; its cell is never repaired (2026-11-17, card `t_949d96c2`, ADR-0314)

**The trigger.** The `OP-129 attendee identity lane` row's `Next free` cell read
`0849` on `origin/main` `a5f06c85` while its range is `0780`–`0798`. The block is
**exhausted**, so the cell named a number that could never be a legitimate value
of that row and that the `unallocated (future lanes)` cursor already held. This
section states the rule the practice needed; ADR-0314 §2 carries the measurement
and moves no cell.

18. **An exhausted block keeps its range and draws from the pool.** A lane whose
    range is exhausted draws every further record from the `unallocated (future
lanes)` cursor (item 16), exactly as a lane with no block would; each draw
    advances **both** the lane cell and the pool cursor.
19. **A cell outside its own range is a symptom, not an allocation.** A value
    beyond the row's range end means "this block is exhausted". No consumer may
    mint from it, and the range end stays the only bound (item 14), because the
    guard (`lane-range-overlap`, item 17) compares reserved _ranges_ and cannot
    see a cell.
20. **The allocator never repairs a foreign cell.** Rewriting an exhausted cell
    back inside its range would invite the next draw to mint a number the pool
    already reserved, and a repair that renumbers landed records is out of
    policy. The fact goes in the ledger note instead.
21. **An exhausted-but-unrepaired cell is not licence to re-cut the range.** The
    block stays reserved, gaps included, and dead to new draws.

**Rejected alternative — treat the out-of-range cell as the lane's next number.**
It is the cheapest reading of the ledger and it is the one that fails: the cell
names a consumed pool number, so the next record would collide with the record
that already holds it. The practice of drawing from the pool is already recorded
ad hoc (ADR-0799, ADR-0800, ADR-0811, ADR-0818); items 18–21 give it a clause.

## §12 — The reservation is written on the card, and the cell only moves up (2026-11-19, card `t_b3edd8a0`)

**The trigger.** Three same-lane ADR-number incidents hit the OP-104 lane
(`0360`–`0379`) in one day, and the rules meant to stop them (§8 rule A, §9 rule
B) were already in force. What still propagated the defect was the **card-body
template**: lane cards were still written as "take the lane `Next free` cell
immediately before committing", so every worker obeyed the template literally and
derived its number from the same shared snapshot. Rules A and B stand unchanged;
this section records the template half that let workers bypass them, plus the two
monotonicity clauses the cell itself needed. It is an in-place amendment: no
number is consumed, `docs/adr/README.md` stays byte-identical, and the board-wide
cell stays at `0318`.

| measured (2026-11-19, `origin/main` `b120866c`) | value                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OP-104 lane cell / highest landed record        | `0369` / `0368`                                                                                                                                                                                                                                              |
| in-flight `OP-104` reservations                 | `0369` on PR [#714](https://github.com/yahodu/openpic-webapp/pull/714) (card `t_a3fcf2e2`), `0370` on PR [#712](https://github.com/yahodu/openpic-webapp/pull/712) (card `t_8f1dac13`) — neither on the trunk; each visible only in a worktree and a PR head |
| the double read                                 | cards `t_d614b82a` and `t_6fdc277b`, both cut off `origin/main` `84378fa0`, both read the OP-104 cell `0366`                                                                                                                                                 |
| what each wrote                                 | `t_6fdc277b` holds `0366` and wrote the cell `0367` on its branch; `t_d614b82a` swept the worktrees, found `0366` held by a worktree with no PR, took `0367` and wrote the cell `0368`                                                                       |
| the landing                                     | the trunk cell had already advanced to `0368`, so the branch's `0367` was a **rewind**; the README-only conflict resolved as a union that kept `0368` and renumbered nothing                                                                                 |
| the cell-versus-PR case                         | PR [#711](https://github.com/yahodu/openpic-webapp/pull/711) held `0368` while the trunk cell also read `0368`, so a card cut from that trunk and obeying "take the cell" would have minted a number a live PR already held                                  |

The card that raised this section also listed a `0362`/`0363` collision between
sibling cards. That instance is **not** cited as evidence: trunk history cannot
reproduce it — `ADR-0362` was added once (`472766ad`), `ADR-0363` once
(`9e2ba5f2`), and both landed together in squash `8c539a3b`; ADR-0362's own
carried-unchanged section carries the no-collision proof ("`0362` and `0363` were
each minted once"). The two instances above are measured, and they are enough:
both are failures of the **cell**, not of the number a worker chose.

22. **The reservation is written on the card, and "take the cell" is retired.**
    Every ADR-minting card body states its number as `**Consumes: NNNN**` — or
    `Consumes: none` for a card that mints nothing — and its lane-facing sentence
    reads "**Your reservation is `NNNN`. Use it as given, and never lower the
    lane `Next free` cell.**" The three phrasings "take the lane `Next free` cell
    immediately before committing", "re-read the cell at your branch cut" and
    "advance the counter to the number you just minted" are **retired from card
    bodies**: each makes the number a function of a value two concurrent cards
    read identically, so the §7/§8 defect re-enters through the template after
    the rule itself was fixed.
23. **The allocation sweep includes every open PR head.** §9 rule B enumerated
    three sources — live worktrees' `docs/adr/` files, the lane's non-`done`
    cards' `Consumes` values, and `git ls-remote --heads origin "OP-<n>*"`. A
    reservation can be invisible to all three: a branch named outside the ticket
    prefix (`wt/<task-id>`, a lane worktree branch) is missed by the prefix glob,
    and a file committed but never pushed is missed by the remote listing. The
    sweep is the union of (a) every live worktree's `docs/adr/` listing,
    (b) `git rev-list --objects --all -- docs/adr` (committed in any reachable
    tree, pushed or not), (c) every non-`done` card's `Consumes` value, and
    (d) **every open PR head** — `gh pr list --state open --json
number,headRefName,headRefOid`, then `git fetch origin <headRefName>` (or
    `git ls-tree <headOid> docs/adr/`) per head. The number handed to a card is
    `max(every number seen above) + 1`, per §9.
24. **The cell never moves down.** A card that lands a ledger row writes the
    lane's `Next free` cell as the **higher** of the value on `origin/main` and
    one more than the highest number consumed in the lane — a high-water mark,
    never a computed count and never the value its own branch carried.
    `t_6fdc277b` wrote `0367` off a cell read of `0366` while the sibling card
    had already put `0368` on the trunk; both computations are individually
    correct against their own snapshot, and only the maximum loses no
    reservation. A lane cell is therefore monotonic, and a lower value is never
    evidence that a number is free.
25. **A merge keeps the higher cell — a lower branch cell is discarded, never
    repaired by renumbering.** On a README-only conflict, §8 item 10's union
    applies with the cell set to the higher of the two sides; when the trunk's
    value is higher, the branch's value is dropped without touching a record. A
    rewind is not a lost number, it is a lost **reservation**: the next card
    reads the rewound value and mints a number a live card already holds. Only a
    duplicate _number_ justifies a renumber (§9 item 9), and renumbering to make
    the ledger look tidy is what this policy exists to end.
26. **A card that mints no number writes `none` and leaves the ledger
    byte-identical.** A sign-off, a review appendix, an in-place amendment such
    as this section, or any docs card whose record already exists consumes no
    number, appends no index row and moves no cell — the PR's
    `git diff --name-only origin/main...HEAD` may then name only the record it
    amends. A card that does consume a number appends its row and advances the
    cell (§8 item 8).

**The card-body template line that changes.** Before:

> Take the lane `Next free` cell from `docs/adr/README.md` immediately before
> committing, and set the cell to the next unallocated number.

After:

> **Your reservation is `NNNN`** — allocator-assigned at card creation. Use it as
> given and do not derive a number from the ledger. **Never lower the lane
> `Next free` cell:** write it as the higher of the trunk's value and one more
> than the highest number consumed in the lane; if the trunk's value is already
> higher, keep the trunk's value.

**Rejected alternative — a CI check on cell monotonicity instead of a template
rule.** A PR checkout does not guarantee a fetched `origin/main` (the guard's
second documented out-of-scope item, `docs/CONVENTIONS.md` §11), both branches of
the `0366` read stayed green under their own guard, and the trunk only reddens
_after_ the squash, by which time the row must be repaired at merge. A check also
cannot see a reservation that is not yet committed.

**Rejected alternative — reserve by writing the trunk ledger from the allocating
card.** This is the reserve-first trunk edit ADR-0312 already rejects: a trunk
write per reservation re-creates the shared-file serialization point that
per-lane ranges were introduced to remove.

**Rejected alternative — have the worker renumber when it sees a lower cell.**
Renumbering hides the collision (§9 item 9) and rewrites every citation of the
number; the cell is the cheap place to lose nothing, and the reservation is the
allocator's to re-issue.

Rationale for stating the rule on the card rather than in the ledger: the ledger
is a value, and a value can only be read; a card is an instruction, and the
instruction was the stale part. The two clauses that need an invariant rather
than a value are the cell's monotonicity (§7 gives it a meaning, nothing gave it
a direction) and its merge resolution (§8 item 10 gave the _rows_ a union and
left the cell to "max(consumed)+1", which computes from the squashed branch's own
view). The choice is recorded on card `t_b3edd8a0`.
