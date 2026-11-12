# ADR-0302 — The `docs/adr/` number guard: its mechanical contract and its deliberate scope boundary

- **Status:** Accepted · **Date:** 2026-10-20
- **Card:** OP-101 follow-up (process/ADR) — record the ADR-number guard's contract and scope boundary (`t_2ae626e9`, orchestrator; raised by the review of `t_8675b675`, OP-96 R-1, PR [#229](https://github.com/yahodu/openpic-webapp/pull/229))
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the policy this guard is the mechanical backstop for), [ADR-0128](ADR-0128-op96-green-review-signoff.md) (the OP-96 integration renumber), [ADR-0133](ADR-0133-op96-f1-f4-round2-red.md) (a cross-lane allocation settled by card `t_cf0b1f77`), [ADR-0143](ADR-0143-op96-flush-overlap-single-send-green.md) / [ADR-0145](ADR-0145-op96-f1-unrecorded-flush-bound-green.md) (the collisions the policy ends)
- **Schema:** n/a · **Contract:** n/a (test-only tooling; no application code)
- **Implementation:** `apps/web/src/test/helpers/adr-numbering.ts` · **Spec:** `apps/web/src/test/unit/adr-numbering.test.ts`, `apps/web/src/test/unit/adr-lane-ranges.test.ts`

## Context

[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) replaced "take the
lowest free number at commit time" with **per-lane reserved ranges** and said, in
its §Consequences:

> A purely mechanical duplicate-prefix check (two files in `docs/adr/` sharing an
> `ADR-NNNN`) remains worthwhile as a backstop and **is tracked separately; this
> record is the policy, not the guard.**

That promise is now due. The guard landed on `main` as `eda4e1b` (PR
[#229](https://github.com/yahodu/openpic-webapp/pull/229)):
`apps/web/src/test/helpers/adr-numbering.ts`, its spec
`apps/web/src/test/unit/adr-numbering.test.ts`, and
`docs/CONVENTIONS.md` §11. Its **contract** and, more importantly, its
**deliberate scope boundary** currently live only in a `docs/CONVENTIONS.md`
section and in TSDoc. That is thin for a rule that is easy to "improve" in the
wrong direction: a future engineer who reads ADR-0300's prose ledger
(`docs/adr/README.md` § "ADR number allocation") may reasonably try to make the
guard verify reserved ranges — the exact brittleness the boundary exists to
avoid. This record pins the contract and the boundary so the next reader
inherits the _why_, not just the _what_.

## Decision

The guard `apps/web/src/test/helpers/adr-numbering.ts` enforces **exactly two
mechanical invariants**, and its boundary is fixed:

### 1. The two invariants

1. **No duplicate number.** No two in-scope files in `docs/adr/` share an
   `ADR-NNNN` prefix. Two or more well-formed names carrying the same four-digit
   number are reported together as **one** `duplicate` issue.
2. **Well-formed names only.** Every in-scope `ADR-*.md` file name matches

   ```
   ^ADR-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$
   ```

   a four-digit number and a lowercase `[a-z0-9]`-only dashed slug. A wrong
   number length (`ADR-96-x.md`, `ADR-12345-x.md`), an uppercase slug
   (`ADR-0146-X.md`), a non-`.md` extension or a name that does not start with a
   case-sensitive `ADR-` is **malformed**.

**Scope is case-sensitive and name-based.** Only names matching
`^ADR-.*\.md$` are looked at; `README.md`, a lowercase `adr-…` and any other
non-ADR markdown are ignored silently. A lowercase `adr-0146-x.md` is therefore
_not_ an ADR reference — it is out of scope, not a malformed ADR.

### 2. Report semantics

- One `duplicate` issue per shared number, listing **its names sorted**
  ascending.
- Each malformed in-scope name produces **its own** `malformed` issue and never
  joins a duplicate group (a malformed name with the same _digits_ as a
  well-formed one does not collide with it).
- `ok === (issues.length === 0)`.
- Ordering is **deterministic**: issues sort by numeric ADR number ascending,
  with `malformed` issues (`number === null`) last, then by `code`, then by the
  first file name. `files` within an issue is sorted ascending. The same input in
  any order yields the same report — `fs.readdir` order is not guaranteed and CI
  logs must be stable.

### 3. One directory, no recursion

`checkAdrDirectory(dir)` reads **exactly one** directory (a synchronous
`readdirSync` filtered to files) and **never recurses**. A nested `archive/` copy
of an ADR cannot produce a phantom duplicate.

### 4. The deliberate scope boundary — the load-bearing part

The guard does **not**:

- verify that a number sits inside its lane's **reserved range**, or
- cross-check the number against **`origin/main`** (or any other ref).

Both remain **review-time obligations for the reviewer**, not CI checks. The
reasons are structural, not incidental:

- The range ledger is **prose** in `docs/adr/README.md` § "ADR number
  allocation". Parsing prose in CI is brittle: the ledger's format is a
  documentation choice, and coupling a merge gate to it trades one failure mode
  (a human miss) for a worse one (a false red on a doc-format tweak).
- A PR checkout **does not guarantee a fetched `origin/main`**. A cross-ref check
  would either fail closed on an unfetched remote or fail open on a stale one —
  both worse than the reviewer checking it.

**Mechanising either of these is a decision that requires a superseding ADR.**
Absent one, they are reviewer duties: CONVENTIONS.md §11 records them as such,
and the reviewer confirms a new number is both inside its lane's range and free
on `main`. The _disjointness_ half was mechanised on 2026-11-12 under ADR-0300
§10 (finding F-L1) — see §6 below, which supersedes it; range membership is
unchanged.

### 5. Where it runs, and non-vacuity

- The guard runs under **`pnpm test:unit`**, an existing CI step in
  `.github/workflows/ci.yml`; there is no bespoke job to add or maintain.
- It lives under `apps/web/src/test/**`, which is **excluded from coverage**, so
  it cannot move the coverage thresholds.
- It is **non-vacuous**: injecting a synthetic `ADR-0142` duplicate into
  `docs/adr/` makes the full unit project fail naming `0142`; removing it
  restores a green run. (Reproduced independently in the review of `t_8675b675`.)

### 6. The lane-range disjointness invariant (2026-11-12, finding F-L1)

Ledger finding F-L1 showed two reserved rows can intersect while every file name
stays unique on its own branch: the OP-126 uploads lane held `0760`–`0779` and
the OP-129 lane held `0769`–`0788`, so `ADR-0770` came to exist twice in flight.
That is a _row_ defect, and unlike range membership it is mechanical, so the
guard now enforces it. This section supersedes the **disjointness half** of §4;
range membership and `origin/main` freshness stay review-time.

- **Invariant.** Two rows of the reserved-range ledger in `<dir>/README.md`
  whose **closed** ranges intersect are a failure —
  `a.start <= b.end && b.start <= a.end`. One issue is reported per intersecting
  pair, in the existing report shape:
  `{ code: "lane-range-overlap", number: null, files: [holderA, holderB] }`,
  where `files` carries the two **holders** (the ledger's row labels, not file
  names) sorted ascending. Touching neighbours — `0760`–`0779` and `0780`–`0798`
  — are disjoint and clean.
- **Scope: rows only, closed ranges only — but a range-shaped row is never
  dropped silently.** A row contributes a range only when its second cell is a
  closed `` `NNNN`–`NNNN` `` pair (`–` U+2013 or `-`) whose start is not above
  its end. A cell that is **range-shaped** — two backticked 3–4 digit tokens with
  one dash-family separator (`–`, `-`, `—`, `−`, `~`) and nothing else in the
  cell — but fails that test is **reported**, not skipped:
  `{ code: "lane-range-malformed", number: null, files: [holder] }`, one issue
  per row, holder trimmed verbatim (finding F1 follow-up). Still **skipped**, and
  named here so a later "fix" cannot red the board: the open-ended
  `unallocated (future lanes)` cursor (`` `0700`+ … ``), a single-number cell,
  the header and `---` separator rows, any prose mention, the ADR index rows
  (their titles quote numbers — the real `0341` row reads "the `` `402`/`403` ``
  denial split"), an **indented** row (the row shape requires a leading `|`), and
  an **annotated** range cell such as `` `0789`-`0808` (20 per lane) `` (the
  accepted cell is fully anchored). A missing, empty or row-less `README.md` adds
  no issue.
- **Why range notation, not "any non-alphanumeric separator".** The F1 pins
  describe a row as "two backticked number tokens with a non-alphanumeric
  separator between them"; applied literally to a whole cell that also catches
  the `0341` index row and would call an annotated range malformed. The
  implementation therefore gates on _range notation_ — one dash-family separator
  inside an otherwise fully anchored cell. This is the one place the rule is
  narrower than the pins' wording, and it is settled by the harder requirement
  that `checkAdrDirectory("docs/adr")` on this repository stays exactly
  `{ ok: true, issues: [] }`.
- **A malformed row never feeds the overlap predicate.** `0780`-`0760` matches
  the accepted pattern and would parse as `{ start: 780, end: 760 }`, inventing
  an overlap against a lane at `0760`-`0799` that no lane reserved.
  `parseLaneRanges` drops a descending pair (its result for every valid row is
  unchanged), and the malformed issue is the only report that row produces.
- **Measured (F1 follow-up).** An inverted (`0780`-`0760`), em-dash
  (`0760`—`0779`), minus-sign, tilde and three-digit (`760`-`779`) row each
  produce exactly one `lane-range-malformed` issue; an indented copy of the
  inverted row produces none; the real ledger is `{ ok: true, issues: [] }` over
  31 parsed ranges. **Why the silent direction was worse than the false
  positive:** a skipped row is indistinguishable from a lane that reserved
  nothing, so the guard reports clean while the ledger's promise is broken — the
  same silence that let F-L1 ship. A false positive is a one-line ledger fix in
  the PR that introduced it, and the code names the offending row.
- **Parser.** `parseLaneRanges(markdown: string): LaneRange[]` in the same
  module returns one `{ holder, start, end }` per closed row — holder trimmed
  verbatim, leading zeros dropped, document order preserved. It is row-shape
  based and does **not** require the `### Reserved ranges` heading: the row is
  the reservation, and the heading carries a date that is re-worded more often
  than the rows are written.
- **Ordering.** Overlap issues join the numbering issues and pass through the
  same deterministic sort (§2): `number: null` places them with the malformed
  issues, then `code`, then `files[0]`. Two overlaps that share a first holder
  tie on that key and keep insertion order — the report pins the key, not
  README-row-order independence.
- **What it still cannot see.** A _file_ numbered inside a foreign range. The
  guard has no file→lane map, and must not infer one from the `Next free` cell
  (a consumed count, not a reservation bound — ADR-0300 §10), so that remains a
  review-time defect.

### 7. The record link-target invariant (vi) (2026-11-12, finding F3)

Every **markdown link target** inside a `docs/adr/ADR-*.md` record must name a
file that exists in `docs/adr/`. The records were the one tree the source sweep
never read, so a renamed record's links rot in silence: three OP-129 records
pointed at pre-rename file names while every guard stayed green.

- **Scope: records, not the ledger.** Only names matching `^ADR-.*\.md$` are
  swept. `docs/adr/README.md` is deliberately out, because its ledger notes keep
  pre-rename names on purpose, and flagging them would force the record of a
  collision to stop describing it.
- **Prose is not a link.** A fenced code block and an inline code span are
  prose: a `](…)` shape inside backticks documents the shape, it does not
  navigate.
- **Shapes read (2026-11-12, finding F1 of card `t_e042ab22`).** A markdown
  inline link's target is read in **three** shapes — bare `](ADR-….md)`,
  **titled** `](ADR-….md "title")`, and **angle-bracket** `](<ADR-….md>)` — and
  all three resolve on the leaf, so a dangling target in any of them is reported.
  A title is peeled before resolution and is **not** part of the reported
  `target`; the brackets are likewise stripped, so the report quotes
  `ADR-….md` and never `<ADR-….md> "title"`, while a `#fragment` stays in the
  report after the bracket is removed. Every shape read is counted in
  `checkedLinks`, because `ok: true` alone would also pass on a rule that
  silently skips it. An image link (`![alt](ADR-….md)`) is a target too: it
  navigates like a text link.
- **Shapes not read — stated so a later change cannot widen the rule by
  accident.** A `./ADR-….md` and every other path-bearing target (the leaf
  predicate rejects a path separator, now and by decision), a reference-style
  `[label][ref]` with its `[ref]: ADR-….md` definition, a bare autolink
  `<ADR-….md>`, and a target containing `(` or `)` are **not** targets: they are
  neither resolved nor counted. The combined `](<ADR-….md> "title")` is read by
  the same two peels but is deliberately **not pinned** — the trunk carries no
  such link, and pinning it would widen the shape matrix past the two shapes this
  section records.
- **Exact leaf matching.** Any `#fragment` is stripped, and the leaf must carry
  no path separator, start `ADR-` and end `.md`. It resolves only against a file
  name **equal** to the leaf — never a prefix and never a number-only match,
  which is how `0029-domain-event-outbox.md` (the record is the plural
  `…-domain-events-outbox.md`) and `0306-red-branch-pipeline.md` (0306 is now
  `0306-op101-stale-branch-deletion.md`, a different decision) passed as valid.
- **The ratchet, and its retirement.** The invariant landed as a ratchet: the
  real-tree case pinned the trunk's observed debt exactly — **32 occurrences of
  16 distinct targets** in other lanes' records — so it failed on a new dangling
  link _and_ on a repair, which coupled every docs fix to this file. The repair
  retargeted all 16 and retired the list to `{ ok: true, issues: [] }` over 292
  records and 881 links; the case keeps its non-vacuity bounds (`>= 250`
  records, `>= 800` links), so a silently narrowed sweep still cannot pass. Two
  targets had no live record to point at — `ADR-0360`/`ADR-0361`, the OP-104
  lane's records, which exist only on the unmerged
  `OP-104-task-entitlements-usage-endpoints` branch — and are named as prose
  there.

## Consequences

- The mechanical half of ADR-0300 is enforceable and gated: a duplicate number or
  a malformed name is caught by CI, not by a reviewer's memory.
- The guard's boundary is now a recorded decision, so "why doesn't the guard
  check the range?" is answered by an ADR rather than re-litigated — and changing
  the boundary is explicitly a superseding-ADR decision, not a drive-by "fix".
- The reviewer keeps two duties that no tool covers (range membership and
  `origin/main` freshness). That asymmetry is intentional and accepted.
- `pnpm test:unit` is now a required pre-merge check for any PR that touches
  `docs/adr/**`; a new ADR must satisfy the very guard it is subject to.

## Alternatives

- **Mechanise the range check by parsing `docs/adr/README.md`.** Rejected: it
  makes the prose ledger's format a CI contract, so a harmless table reflow can
  red the whole board — the serialization/brittleness ADR-0300 set out to remove,
  reintroduced as a parse dependency.
- **Mechanise a cross-ref check against `origin/main`.** Rejected: a PR checkout
  cannot assume a fetched `origin/main`; the check would be unreliable (stale =
  false green, unfetched = false red) and so strictly worse than a reviewer
  looking.
- **Extend the guard to recurse into `archive/` subdirectories.** Rejected: an
  archived ADR legitimately keeps a number that has been superseded; recursing
  would produce phantom duplicates and force renumbers of frozen history.
- **Fold this contract into ADR-0300.** Rejected: ADR-0300 is the allocation
  _policy_ and says so ("this record is the policy, not the guard"); keeping the
  guard's contract separate lets the boundary change without rewriting the
  policy, and matches the "one decision per record" rule.

## Review sign-off (RED rounds 1–2, execution lens)

- **Verdicts: round 1 — CHANGES REQUESTED (one High finding); round 2 — APPROVED.** Nothing in
  §Decision is retracted: the round-1 finding was inside the RED's spec, not in this contract, and
  the GREEN closed it before the guard landed. Recorded here, inside the delivered ADR, so the
  sign-off consumes no new ADR number.
- **Reviewer:** `openpic-webapp-reviewer` (card `t_2aaa8a18`) · **RED card:** `t_e23bb540` ·
  **GREEN card:** `t_94a437c4` · **PR:** [#448](https://github.com/yahodu/openpic-webapp/pull/448) ·
  **Branch:** `OP-96-task-adr-lane-range-guard` · **Reviewed heads:** `440b00b` (round 1) →
  `d327e47` (round 2).

### Scope

The sign-off covers the RED deliverable of card `t_e23bb540`: the pins for `parseLaneRanges` and
for the `lane-range-overlap` report shape that later became §6. That card delivered them on PR
#448 as a **draft, RED-by-design**. The draft itself was never merged — the GREEN card `t_94a437c4`
promoted the same PR, added the implementation, ADR-0300 §10, this §6 and the README bullets, and
the guard review + land card `t_c8727284` approved and squash-merged it as `d85de6f`. "Never
merged" therefore describes the pre-GREEN draft only, not PR #448 as a whole.

### Round 1 (artifact lens) — CHANGES REQUESTED, one High finding

- **F1 (High, spec brittleness).** The real-ledger case pinned the ledger's then-last row,
  `OP-122 queue lane 0680`–`0699`. Any new lane row inserted above the pool row therefore turned
  the guard's own spec red while the guard still reported the ledger clean — the pin would have
  blocked an allocation the guard correctly accepted.
- **Measured.** With a faithful stub: `54 passed (54)`. Inserting `| OP-129 attendee identity lane | 0780–0798 | 0782 |` above the pool row: `1 failed | 53 passed`.
- The finding was in the pin, not in the contract: §6 as written needed no change.

### Round 2 (execution lens) — APPROVED

- **F1 closed** by deriving the last closed row from the file (`closedRows()`) instead of naming it. The reviewer re-ran the same insert at **both ends** of the table; both stayed `54 passed (54)`, while the pre-fix spec failed the same probe.
- The `TS2532` follow-on fix in `d327e47` (`noUncheckedIndexedAccess` on the derived-row helper)
  weakens no assertion.
- **Red state on the reviewed head** (`d327e47`): `adr-numbering.test.ts 3 failed | 34 passed (37)`, `adr-lane-ranges.test.ts 17 failed (17)`, and the full unit project `20 failed | 2380 passed | 3 skipped` with only those two specs. `lint`, `secret-scan`, `audit`, `audit-dev`, `env-changes`, branch-name, PR-title and CodeQL green; `unit_test` red by design on exactly those 20 cases.
- **Contract untouched.** The specs' only removed lines were one import and four docblock lines;
  `checkAdrNumbers` and `parseAdrNumber` bodies were not edited.

### The acceptance proof, measured in a throwaway worktree

- An intersecting row, or the live bug itself (uploads rows `0700`–`0779` with OP-129 still at
  `0769`–`0788`), turns `finds no intersecting pair among the repository's reserved ranges` **and**
  the delivered `checkAdrDirectory(realAdrDir)` case red: `2 failed | 52 passed`.
- The destination state (uploads `0700`–`0779`, OP-129 `0780`–`0798`, pool `0799`+) is
  `54 passed (54)`, and that is the ledger `main` now carries.
- That measured bite is why the lane repair card `t_da4088d2` was gated on the guard: the guard
  cannot be green on a ledger that still carries the live overlap.

### Recorded, no change requested

- The RED spec pins the real ledger **by row shape**, not by the `### Reserved ranges` heading —
  the heading carries a date that is re-worded more often than the rows are written.
- `ranges[0]` stays positional by convention in the overlap cases.
- The derived last-row assertion is near-redundant with the count check, but still catches a wrong
  `end`, so it was kept deliberately.
- The helper is **exempt from the coverage gate**: `vitest.config.ts` `include` covers only
  `packages/contracts/src/**`, `apps/web/src/app/api/**` and `apps/web/src/server/**`, and
  `exclude` carries `**/*.test.ts`, `**/__tests__/**` and `**/test/**`; so no defensive branch had
  to be deleted to hold 80 %.
- **F1 (Low) from the guard's land review `t_c8727284`** — recorded, with no change to §6. A
  range-shaped ledger row that does not parse is skipped silently: an inverted `0780`–`0760` cell
  parses as `{ start: 780, end: 760 }` and reports `{"ok":true,"issues":[]}` even with another
  lane inside the intended span; an em dash and three-digit pairs behave the same way. That is
  inside §6's documented "skipped, never thrown on" scope, so it is a limitation, not a contract
  violation. Follow-ups: card `t_4f74644d` (TEST, pins `lane-range-malformed`) → card
  `t_00321ecb` (GREEN, implements it and amends §6 in place).

### Post-review status

The open items are carried by card, never by an ADR number: `t_c8727284` (guard review + land —
done, squash `d85de6f`), `t_4f74644d` → `t_00321ecb` (the Low F1 above), `t_da4088d2` (lane repair
— done, delivered on PR #444), `t_b8c449d4` (OP-129 stack land — done, squash `741b607`). Nothing
recorded above is retracted; those cards' own records document what followed.

## Review sign-off (F1 GREEN, round 1 — artifact lens, landed)

### Scope

The GREEN for the Low F1 recorded under the RED sign-off above: card `t_00321ecb`
(GREEN, report `lane-range-malformed` for a range-shaped ledger row that does not
parse), delivered on PR [#481](https://github.com/yahodu/openpic-webapp/pull/481),
reviewed at head `fb50c7e` and landed as squash `fc4ad00`. This section records that
round only; it amends no contract and mints no number.

### What shipped

- `lane-range-malformed` joins `AdrNumberIssue["code"]`; `scanLaneLedger` reports
  `{ code: "lane-range-malformed", number: null, files: [holder] }` for a
  range-shaped row that is not an accepted ascending four-digit pair.
- The accepted cell form, the `parseLaneRanges` contract for valid rows and the
  `lane-range-overlap` shape are unchanged, so a valid ledger reports exactly what
  it reported before.
- §6 above and ADR-0300 §10 rule 17 were amended in place: the scope bullet now
  names the reported malformed row, and the policy rule states that a ledger typo
  is a CI failure rather than a silent hole.

### Verification (reviewed head `fb50c7e`)

- Pins carried byte-identical through the squash: `adr-numbering.test.ts` blob
  `3174d4a`, `adr-lane-ranges.test.ts` blob `3ad145a`; the PR diff carries no test
  path.
- Focused `adr-numbering` + `adr-lane-ranges`: **83 passed (83)**.
- Real ledger: `{"ok":true,"issues":[]}` over **31** parsed ranges.
- Full unit: **162 files, 2637 passed | 3 skipped (2640)** against the then-trunk's
  **2625 passed | 3 skipped (2628)** — delta **+12**, exactly the new pins.
- `tsc -p apps/web/tsconfig.json --noEmit` exit 0; eslint 0 errors with the helper
  warnings identical to the trunk; prettier clean; 14/14 PR checks.

### Load-bearing probes

- Dropping the `start <= end` guard → **4 failed**.
- Narrowing the range shape to four digits → **2 failed**.
- Measured silent edges: an indented row → `{ok:true,issues:[]}`; an annotated cell
  `` `0789`-`0808` (20 per lane) `` → `[]`; an inverted row beside a `0760`-`0799`
  lane → the malformed issue only, no phantom overlap.

### Landing

- Squash `fc4ad00`. The four reviewed paths are byte-identical between `fb50c7e`
  and the squash; the only other tree difference is trunk-owned `18f2056` (the
  OP-129 ADR-0781 sign-off, +48 lines), which landed while PR #481 was open.
- Re-run at the squash: focused **83 passed**, `tsc` exit 0. `docs/adr` holds
  **289** records, with no duplicate number.

### Open item routed, not fixed

The §6 guarantee that a malformed row never feeds the overlap predicate was
regression-invisible at that head: re-adding a descending four-digit pair to the
range list left the focused suite at **83 passed**, and the indented-row and
descending-pair-drop edges were asserted only in comments. That is a **coverage
gap, not a defect in the shipped behaviour**. It was routed to card `t_ce88dbcb`
(TEST, characterization pins; needs no GREEN), which landed three pins on PR
[#484](https://github.com/yahodu/openpic-webapp/pull/484) as squash `beae024`, each
proven load-bearing by a helper mutation:

- `adr-numbering.test.ts`, phantom-overlap pin:
  `reports only the malformed row when the inverted span would intersect a real lane`.
  Mutation "also push the range-shaped row into `ranges`" → **3 failed | 83 passed
  (86)**; the failure is the phantom
  `lane-range-overlap [OP-201 alpha lane, OP-204 delta lane]` instead of
  `lane-range-malformed [OP-201 alpha lane]`.
- `adr-numbering.test.ts`, indented-row pin:
  `stays silent for an indented row: the row shape requires a leading pipe`.
  Deleting the `line.startsWith("|")` continue → **1 failed | 85 passed (86)**,
  that case only.
- `adr-lane-ranges.test.ts`, descending-pair pin:
  `drops an inverted pair instead of returning the inverted span`. Dropping the
  `start <= end` guard → **6 failed | 80 passed (86)**.

With those pins on the merged trunk (`beae024`), the focused pair is **86 passed
(86)** — the 83 above plus the three pins. The later OP-128 pin scoping
(`ff0d03c`, PR [#477](https://github.com/yahodu/openpic-webapp/pull/477)) adds six
cases to `adr-numbering.test.ts` without changing any assertion cited here, so the
same pair is **92 passed (92)** on the trunk this section is appended to.

### Figure correction (Info)

The implementer handoff quoted a trunk baseline of `2632 passed`. The real baseline
was **2625 passed | 3 skipped (2628)** — no test file changed on `main` between
`a08d2aa` and `18f2056` — so the correct relation is 2625 + 12 pins = 2637. This is
a figure correction, not a defect.

### Post-review status

Nothing in §6 or in the RED rounds 1–2 sign-off above is retracted. The F1 item in
this section is carried by `t_ce88dbcb`, which is done (squash `beae024`). The card
ids are the record, not an ADR number.
