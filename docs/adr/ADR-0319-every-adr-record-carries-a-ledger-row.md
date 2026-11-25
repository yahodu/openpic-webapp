# ADR-0319 — Every ADR record carries its own ledger row

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** board process decision `t_e93ba35d` (openpic-orchestrator); the pin hardened by `t_c5302256`; landed by `t_d2034cab` · **Branch:** `OP-140-task-adr-row-mandatory` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-adr-row-mandatory`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0319`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§6 the block, §11 the cell), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the ADR guard contract), and the records this one amends: [ADR-0879](ADR-0879-op136-sweep-drain-shapes.md), [ADR-0910](ADR-0910-op140-consent-acknowledgement-service.md), [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md), [ADR-0963](ADR-0963-op140-attendee-selfie-rejected-and-active-slug-resolver-green.md)
- **Schema:** n/a · **Contract:** n/a (process rule; no application code) · **Implementation:** none (docs only) · **Spec:** `apps/web/src/test/unit/adr-ledger-shape.test.ts` (§S3, hardened by the parent)

## Context

Measured at the branch head `423d97fd` — `origin/main` `40af157a` merged with the
pin branch `OP-140-task-adr-row-pin-hard` `cf26c02f` — 2026-11-23, with the census
in §Evidence:

- **457** records (`docs/adr/ADR-NNNN-*.md`), **456** ledger rows
  (`^| \[[0-9]{4}\]\(` in `docs/adr/README.md`).
- Records with **no** row: **exactly one**,
  `ADR-0963-op140-attendee-selfie-rejected-and-active-slug-resolver-green.md`
  (`Accepted`, landed by PR #835 `b6cad7ea`). Rows with no record: **zero**.
- The two precedents that claim a row-less GREEN both contradict the file they sit
  in: row `0910`'s title and ADR-0910 §7 say the GREEN sibling `0911` "writes no
  ledger row", while row `0911` **exists** (`README.md:568`); ADR-0879 says `0880`
  "writes no ledger row; a later docs card owns that index row", while row `0880`
  exists, written by that later card. So the practice was a **deferral**, and it
  failed exactly once — `ADR-0962` §4 deferred `0963` and named no owning card, so
  nothing ever wrote the row.
- The cost that made the question visible: `t_f5e7e108` → `t_7482fc94` (a ledger row
  and the record it indexes drifted on `Status`, twice), and the pin `t_2433ea7b`
  could only _warn_ on a missing row while the convention was undecided.

## Decision

1. **A ledger row is mandatory, and it lands with the record.** Every ADR record
   that lands in `docs/adr/` carries exactly one `| [NNNN](ADR-NNNN-*.md) |` row in
   `docs/adr/README.md`, added by the same pull request that adds the record. A
   GREEN's row may be one sentence naming its RED sibling; it may not be omitted,
   and "a later docs card owns that row" is not an accepted plan.
2. **The invariant is set equality, both ways.** At every merged head the set of
   record numbers under `docs/adr/` equals the set of ledger-row numbers. A row
   whose record file is absent is the same defect as a record with no row.
3. **The guard enforces it, not review.** The `adr-ledger-shape` spec's missing-row
   case is a hard failure — the list of row-less records must be empty, with no
   warning list and no allowlist — so a pull request that adds a record without a
   row turns its own `unit_test` red before it can merge.

## Consequences

- `0963`'s gap is repaired with its already-minted number: one row, **no new ADR
  number**, no cell move.
- The six sentences that assert the no-row convention are corrected to point here
  (§Evidence lists the sites): README row `0910`, ADR-0910 §7, ADR-0962 §4,
  ADR-0963 §4, ADR-0879's numbering bullet and README's `0879` prose block.
- `docs/CONVENTIONS.md` §9 and its mirror `.github/pull_request_template.md` gain
  the DoD bullet: a record carries its own ledger row in the same PR, and a record
  with no row or a row with no record is a DoD failure.
- Cost accepted: one ledger line per record. The ledger already carries 456 lines
  for 457 records, and a GREEN's line is allowed to be short — the alternative is a
  record that no index reaches.
- Boundary: the guard reads one tree, so it constrains the pull-request head and the
  merged trunk. A docs-only PR that repairs a record which **already landed** is a
  fix, not a plan: the rule is that the row lands _with_ the record.

## Alternatives considered

- **A record may omit its row (rejected).** Then `0963` is compliant and the
  missing-row case must stay a warning for ever; a row-less record becomes
  indistinguishable from the row/record drift that cost the two `0910` review
  rounds; and the ledger stops being a complete index of the records.
- **A deferral to a named later docs card (rejected).** It is the practice that
  produced both precedents: `ADR-0879` deferred `0880` and a card was minted, so the
  row exists; `ADR-0962` deferred `0963` and named no card, so the row never landed.
  A rule whose satisfiability depends on a card minted later cannot be checked at the
  head the record lands at; "in the same pull request" can.
- **Row optional for GREEN records only (rejected).** Same failure, and the GREEN is
  the record most likely to be forgotten — the only row-less record in the tree is a
  GREEN (`0963`).

## Numbering

`0319`: the last free slot of the board-wide / process block `0300`–`0319`
(occupancy at `40af157a`: `0300`–`0318` present, `0319` absent). The pre-push sweep
re-run at this head over every surface — `git rev-list --objects --all -- docs/adr`,
every `.worktrees/*/docs/adr` tree, the nine open PR heads' `docs/adr` file sets, and
every non-`done` card's `Consumes` — found no `0319` (§Evidence quotes the commands).
The block is now **exhausted**: the `Next free` cell becomes `0320` (a value one past
the range end is the sanctioned encoding of "exhausted", ADR-0300 §11 item 19), and
any later board-wide record draws from the `unallocated (future lanes)` cursor —
`0964` at this head — and advances both cells (ADR-0300 §11 items 18–19). No cell is
lowered, no range re-cut.

## Evidence

Every number below is quoted from a command run on this head, never remembered.

The census (records, rows, row-less records, rows without a record), before the
repair and after it:

```
$ python3 - <<'EOF'
files={re.match(r'ADR-(\d{4})-',os.path.basename(p)).group(1) for p in glob.glob('docs/adr/ADR-*.md')}
rows=set(re.findall(r'^\| \[(\d{4})\]\(', open('docs/adr/README.md').read(), re.M))
print(len(glob.glob('docs/adr/ADR-*.md')),"records;",len(rows),"rows; rowless",sorted(files-rows),"; orphans",sorted(rows-files))
EOF
457 records; 456 rows; rowless ['0963'] ; orphans []
```

The `0319` sweep surfaces:

```
$ git rev-list --objects --all -- docs/adr | grep -c 'ADR-0319'
0
$ ls -d /root/openpic/openpic-webapp/.worktrees/*/docs/adr/ADR-0319* 2>/dev/null | wc -l
0
$ gh pr list --state open ...   # nine open PR heads, recursive trees read with gh api
9 open PRs
841 2f305244 1644 paths []
840 cf26c02f 1642 paths []
832 16913b23 1638 paths []
829 1e769a7b 1633 paths []
828 54ca4fdb 1633 paths []
826 ab7cbdad 1632 paths []
755 c90ae3ba 1535 paths []
743 40df0afd 1520 paths []
272 d5be9af4 684 paths []
$ # every non-done card body, for a `Consumes` naming 0319
326 non-done cards; ['t_460708c6', 't_6c327503', 't_d2034cab']
```

The two foreign cards are archived OP-101 docs cards that name the range
`0300`–`0319` and explicitly consume no number; `t_d2034cab` is this record's own
card.

The guard, before and after the `0963` row:

```
$ pnpm exec vitest run --project unit apps/web/src/test/unit/adr-
 Test Files  1 failed | 7 passed (8)
      Tests  1 failed | 275 passed (276)      # the row-less 0963 case only
 Test Files  8 passed (8)
      Tests  276 passed (276)                 # after this row
```

The census after the repair, the `0963` row, the prettier result and the full unit
run:

```
458 records; 458 rows; rowless [] ; orphans []
$ grep -c '^| \[0963\]' docs/adr/README.md
1
$ prettier --check "docs/adr/**/*.md" docs/CONVENTIONS.md .github/pull_request_template.md
All matched files use Prettier code style!
$ pnpm exec vitest run --project unit
 Test Files  195 passed (195)
      Tests  3296 passed | 3 skipped (3299)
```

## Review sign-off — 2026-11-25 (S1c, ledger block contiguity)

- **Verdict: APPROVED WITH FINDINGS** — card `t_1bb6d2c3` (`openpic-webapp-reviewer`, artifact + execution lens), a **post-merge** verification of the landed rule: PR [#938](https://github.com/yahodu/openpic-webapp/pull/938) answers `state=MERGED`, `head 2657c64f…`, `mergeCommit 0ccc18f4…`. The rule this record's `Spec:` line names was re-measured at that squash and at the trunk `cd878591` (`#937`), and every count below came from a command on one of those two trees. Two findings were routed — both about the block's **edges**, not about the rule — and both are closed by the follow-up PR [#942](https://github.com/yahodu/openpic-webapp/pull/942) `00f0d022`, measured in the seventh bullet.
- **What landed.** `0ccc18f4` touches exactly two files, `+229/−18`: `apps/web/src/test/helpers/adr-ledger-shape.ts` (`+113/−17`, blob `2d3af5e5…`) and `apps/web/src/test/unit/adr-ledger-shape.test.ts` (`+116/−1`). **S1c:** between the header's delimiter row and the last **row-shaped line in the document**, every line must be a ledger row — reported as `{ line, reason }`, `reason` `blank-line` for an empty line and `non-row` for a non-empty line that is not a `| [NNNN](ADR-*.md) | …` row — inside S1's own `issues` array, so `ok` stays `rows > 0 && issues.length === 0` and the existing real-tree case covers the new rule without a second census case. `docs/adr/README.md` is **byte-identical** across the squash: the census found no violation, so no row, no cell and no number moved.
- **The measured why.** At the squash `fc8fab29` (PR [#931](https://github.com/yahodu/openpic-webapp/pull/931)) a blank line sat between the `0987` and the `0988` row. A render of the header plus those rows (`gh api -X POST markdown -F text=@probe.md -f mode=gfm`) answers **3** `<tr>` — header, `0986`, `0987` — and the `0988` row as `<p>| … </p>` outside `</table>`, so this record held only textually while the ten `adr-*` guards stayed at **340 passed (340)** (`10 passed (10)` files, re-run at `fc8fab29`). Pointed at that blob, the landed helper answers `{ ok: false, columns: 3, rows: 493, issues: [{ line: 652, reason: "blank-line" }] }`: the last row-shaped line is still counted, and the detached row is named by line.
- **The review's own numbers**, each re-measured by this card: ten `adr-*` guards **343 passed (343)** (`10` files) at `0ccc18f4` and again at the trunk `cd878591`; whole `unit` **201 files / 3426 passed | 3 skipped (3429)** at `cd878591`; the real ledger at `cd878591` reads **494** rows, `0` issues, `checkedRows 494`, `missingRows 0`. Two mutation arms on the reviewed squash, each restored byte-identically (`sha256 36025fac…` for `README.md`, `f14c6f78…` for the helper, `git status --porcelain` empty): restoring the blank line between the `0987` and `0988` rows reds **1 failed | 342 passed (343)** with the real-ledger case the only red; deleting the `contiguityIssuesOf` call reds **2 failed | 341 passed (343)**, exactly the two synthetic S1c cases.
- **The two findings this review routed**, cited by card id because no record number was minted for them. **F-R1 (Low)** — the delimiter row (`headerLine + 1`) is read by no rule: deleting the ledger's delimiter row, or narrowing it to `| --- |`, leaves all ten guards green while GFM answers **0** `<tr>` and **1** `<p>`, i.e. the whole ledger as prose. Routed to the TEST card `t_1b8282ca` (pins, draft PR [#940](https://github.com/yahodu/openpic-webapp/pull/940)) and the GREEN card `t_62fab14d`. **F-R2 (Info)** — the block's end is the last row-shaped line **in the document**, so prose below the ledger that itself carries a row-shaped example sits **inside** the block (measured: `3` issues — `blank-line`, `non-row`, `blank-line`), while S1c's docblock sentence "so no prose region is inside the block" overstates the rule. Routed to `t_1b8282ca` as a characterization case, with the wording owed by the GREEN.
- **The block's edges are what the two findings are about, and the rule itself is unchanged.** S1's row shape, S1c's contiguity, S2's status agreement and S3's missing-row list are the same four rules at `0ccc18f4` and at `00f0d022`; `{ line, reason }` remains the issue shape, `ok` remains `rows > 0 && issues.length === 0`, and the real-tree case remains the single census case.
- **What followed, measured at `00f0d022`.** PR [#942](https://github.com/yahodu/openpic-webapp/pull/942) squashed as `00f0d022` implements the delimiter rule as **S1d** (`delimiter-missing` / `delimiter-cells`, reported at `headerLine + 1` in S1's own `issues`), carries the pin pack byte-identically, and replaces the over-broad sentence with "Prose therefore leaves the block only when nothing below it is row-shaped: a row-shaped example line pulls the notes above it inside the block, and those notes are then measured". The pin pack's draft PR [#940](https://github.com/yahodu/openpic-webapp/pull/940) is `CLOSED` (2026-11-25T04:19:39Z) as superseded, so both findings are closed by a merged commit rather than by an open card. At `00f0d022`: ten `adr-*` guards **347 passed (347)**, whole `unit` **201 files / 3430 passed | 3 skipped (3433)**, real ledger **494** rows with `0` issues, and the helper blob is `5194f6d4…` — a reader at the trunk sees a wider helper than the `2d3af5e5…` measured above, because S1d adds a rule beside S1c rather than inside it.
- **No number, no row.** This append consumes no ADR number, mints no record and adds no ledger row: `git diff --stat` names exactly this one file, `git diff --stat -- docs/adr/README.md` is empty, and the `adr-numbering` guard over the real directory is green.
- **This append's own delivery.** One file, this record, `+13/−0`, appended after the last fence with no byte above it edited; `prettier --check "docs/adr/ADR-0319-*.md"` is clean.
- **Nothing is retracted.** No section of this record is withdrawn: §Decision (the row is mandatory and lands with the record, the invariant is set equality both ways, the guard enforces it), §Consequences, §Alternatives considered, §Evidence and §Numbering (the block is exhausted; the `Next free` cell advances to `0320`) all stand as written. S1c and S1d harden the guard module §Decision item 3 makes the enforcement point; neither amends a decision.

## Review sign-off — 2026-11-25 (S1e, ledger order)

- **Verdict: APPROVED WITH FINDINGS** — card `t_f4793b77` (`openpic-webapp-reviewer`, artifact + execution lens), a **post-merge** verification of the landed rule: PR [#946](https://github.com/yahodu/openpic-webapp/pull/946) answers `state=MERGED`, head `f11cba89…`, `mergeCommit 3138f6d6…`. The squash touches exactly two files, `+217/−4` — `apps/web/src/test/helpers/adr-ledger-shape.ts` (`+92/−4`) and `apps/web/src/test/unit/adr-ledger-shape.test.ts` (`+125/−0`) — and no `docs/` byte, no ADR number and no ledger row. Every figure below came from a command on `3138f6d6`, on the trunk this section lands on (`d68bc6fe`), on a defective tree, or on the blob `e7e92304`.
- **S1e is decided: taken in file order, the ledger's `NNNN` values ascend strictly, and a gap is allowed.** A number is skipped while it is in flight, so the sequence is not a contiguous census. The precedent is ADR-0986's round-1 review sign-off (`docs/adr/ADR-0986-op101-actor-exemption-namespace-agnostic-pin.md:212`), which reads `0982`, `0983`, `0986` _ascending with `0986` directly after `0983` because `0984`/`0985` are then still reserved in flight_, and the four pool-mirror cells (`README.md:43`, `:74`, `:76`, `:80`) read `0991` beside the last row `0990` (`:654`) at this cut — a rule that demanded contiguity would red on the real ledger's own pool cells.
- **A repeated number is an issue too** — equal is neither an ascent nor a gap, so two rows claiming one number is the same defect class. The rule's four committed cases fix the shape: a descent reports `{ line: 5, reason: "0971 precedes 0973 on line 4" }`, a repeat `{ line: 4, reason: "0970 repeats on line 3" }`, `0970`, `0973`, `0974` stays `ok: true` / `issues: []`, and the real ledger reads ascending over every row it counts. The report joins S1's own `issues` array, so `ok` stays `rows > 0 && issues.length === 0` and no second census case is needed.
- **The measured failure it closes.** Both descents shipped with the guard family green: on the PR [#933](https://github.com/yahodu/openpic-webapp/pull/933) squash `0058bb13`, which carries `0971` after `0973` (`:636`) and `0986` after `0989` (`:651`), the ten `adr-*` guards answer `10 passed (10)` / `340 passed (340)` — no rule compared consecutive numbers. PR [#937](https://github.com/yahodu/openpic-webapp/pull/937) `cd878591` moved the `0989` row and PR [#941](https://github.com/yahodu/openpic-webapp/pull/941) `88d8ff0b` moved the `0973` row, each `1 1` on `docs/adr/README.md` and no other path, leaving `0` descents.
- **The rule reproduces on the defective blob.** On `e7e92304` (494 rows, `0001`–`0989`, both descents) the landed helper answers `{ ok: false, columns: 3, rows: 494, issues: [{ line: 636, reason: "0971 precedes 0973 on line 635" }, { line: 651, reason: "0986 precedes 0989 on line 650" }] }`, and the same blob with the `orderIssuesOf` call removed answers `{ ok: true, columns: 3, rows: 494, issues: [] }` — re-measured by this card at `d68bc6fe`.
- **Attribution, corrected by measurement.** The card and both docblocks name PR #885 for the `0973` trio; measured, `01b649df` (#885) wrote the `0973` row **in the right place** (`476` rows, `0001`–`0973`, `0` descents there), and the descent arrived with PR [#894](https://github.com/yahodu/openpic-webapp/pull/894) `8f4e126e`, which inserted the `0971`/`0972` rows **above** it (`:627`/`:628` after the `0973` row at `:626`). That is F1's own shape — a row inserted at the wrong position while its record legitimately held the number — and no behaviour, count or guarded claim moves with the attribution.
- **Where the rule lives, and what it does not touch.** Test helper only: `orderIssuesOf` walks the rows `ledgerTableOf` already parsed, in file order, so a line insertion cannot shift the sequence. No production code, **no new ADR number, no new ledger row** — `docs/adr/README.md` is byte-identical across the squash (`a254067c…` at `3138f6d6^` and at `3138f6d6`), no cell moves, and no range is re-cut.
- **The real tree at the trunk this section lands on.** At `d68bc6fe` and again at `a3cf6aa1` — the trunk it lands on after PR [#949](https://github.com/yahodu/openpic-webapp/pull/949), which adds no ledger byte: header `README.md:158`, delimiter `:159`, **495** rows on `:160`–`:654`, `0001`–`0990`, distinct `495`, **0** descents, **0** repeats, `0` row-shaped lines above the header; the ten `adr-*` guards read `10 passed (10)` / `356 passed (356)` at `d68bc6fe` and `10 passed (10)` / `357 passed (357)` at `a3cf6aa1`, the extra case being #949's multi-descent pin.
- **Routed findings, stated and not fixed.** **F1 (Info)** — both shipped descents came from a row **inserted at the wrong position** while its record legitimately held the number, so the repair is always a **move**, never a renumber; measured, #937 and #941 are `1 1` on the ledger and touch no other path. **F2 (Info)** — the ledger gains rows mid-review: `2345326c` (PR [#943](https://github.com/yahodu/openpic-webapp/pull/943), ADR-`0990`) took it from **494** rows (`2345326c^`, `0001`–`0989`) to **495** (`0001`–`0990`) while `t_f4793b77` was in flight, so any census quoted in a docblock is point-in-time and the real-tree case counts the rows it reads (an independent row-shaped-line count with a `>= 495` floor) instead of pinning an exact total.
- **The two follow-ups this review routed, by card id because neither mints a number.** `t_4cc4a7d2` (TEST, Low) — the S1e cases never proved more than one descent (a first-descent-only `orderIssuesOf` stayed green at `354 passed`) — landed as PR [#949](https://github.com/yahodu/openpic-webapp/pull/949) `a3cf6aa1`, `+30/−0` on the same spec and no helper change, before this section merged. `t_d93a538b` (Low) is **decided**: the row set is scoped to the lines strictly below the ledger header, so a row-shaped preamble example is not a ledger row, and the decision is routed as `t_9c43bbf4` (pin) / `t_0cc5a04a` (GREEN) / `t_434adad5` (its own sign-off). Neither changes what S1e reads on the real tree, where `0` row-shaped lines sit above the header.
- **Nothing is retracted.** No section of this record is withdrawn: §Decision (the row is mandatory and lands with the record, the invariant is set equality both ways, the guard enforces it), §Consequences, §Alternatives considered, §Evidence and §Numbering (the block is exhausted; the `Next free` cell advances to `0320`) all stand as written. S1e hardens the guard module §Decision item 3 makes the enforcement point; it amends no decision.
- **This append's own delivery.** One file, this record, `+15/−0`, appended after the last fence with no byte above it edited; `prettier --check "docs/adr/ADR-0319-*.md"` is clean, `docs/adr/README.md` is untouched, and this append consumes no ADR number and adds no ledger row.

## Review sign-off — 2026-11-25 (S1d, delimiter-row indentation)

- **Verdict: APPROVED** — card `t_0c6c984c` (`openpic-webapp-reviewer`, artifact + execution lens), a **post-merge** verification of the landed rule: PR [#950](https://github.com/yahodu/openpic-webapp/pull/950) answers `state=MERGED`, head `9e90a35d…`, `mergeCommit daa7db6d…` (2026-11-25T06:28:34Z), and `git merge-base --is-ancestor daa7db6d origin/main` exits `0`, so the squash is on the trunk this record is about. The helper at the merged head carries the union member (`:290`), the private `leadingColumns` with its tab-stop arithmetic (`:583`) and the precedence arm (`:627`), and its S1d docblock names the rule and all four rejected tab shapes (`:96`, `:99`).
- **The shape-issue reason set gains exactly one code: `delimiter-indented`.** It is reported on the delimiter's own line (`headerLine + 1`), and the order inside `delimiterIssueOf` is shape, then indentation, then cell count: a line that is no delimiter row at all stays `delimiter-missing`, and an indented one reports `delimiter-indented` even when its cell count is also wrong. `delimiter-missing` and `delimiter-cells` keep their meanings, and no issue field was added.
- **The boundary is GFM's four-column start.** Leading indentation of fewer than four columns is accepted — a space is one column, and a tab reaches the next four-column stop — while four or more columns, a leading tab included, is reported; indentation is leading only, so a tab after the closing pipe stays accepted. Measured on this record's own ledger with `README.md:159` indented, at the trunk `a1995cbe`: four spaces, one tab, one space plus a tab, two spaces plus a tab and three spaces plus a tab all answer `{ ok: false, columns: 3, rows: 495, issues: [{ line: 159, reason: "delimiter-indented" }] }`, three spaces and a trailing tab answer `{ ok: true, columns: 3, rows: 495, issues: [] }`, and four spaces plus a one-cell row answers `delimiter-indented` rather than `delimiter-cells` — the precedence, measured.
- **The measured oracle that motivated it, reproduced.** With `README.md:159` indented by four spaces, by one tab, or by one space plus a tab, the helper at `aab6bcad` — the tree before PR [#950](https://github.com/yahodu/openpic-webapp/pull/950) — answers `{ ok: true, columns: 3, rows: 495, issues: [] }`, so the whole ledger passed as a table while GitHub's renderer (`gh api -X POST markdown -F text=@probe.md -f mode=gfm`) emitted **0** `<tr>` and **0** `<td>` and one `<p>`, the header a paragraph; the same renderer on the flush row emits **2** `<tr>` and **3** `<td>`. That false green is pre-existing from [#942](https://github.com/yahodu/openpic-webapp/pull/942) and had no trunk impact, because this ledger's delimiter row (`README.md:159`) sits flush at zero columns.
- **The landing, measured at `a1995cbe`.** The squash `daa7db6d` touches exactly two paths, `+50/−7` on `apps/web/src/test/helpers/adr-ledger-shape.ts` and `+184/−1` on `apps/web/src/test/unit/adr-ledger-shape.test.ts`, and no `docs/` byte; `docs/adr/README.md` is byte-identical across the squash (`git diff --exit-code daa7db6d^ daa7db6d -- docs/adr/README.md` exits `0`) and on this append's branch against `origin/main`, so no row, cell or number moved. The ten `adr-*` guards read `10 passed (10)` / **365 passed (365)** and the whole `unit` project **201 files / 3448 passed | 3 skipped (3451)**, both at `a1995cbe`; PR [#952](https://github.com/yahodu/openpic-webapp/pull/952) (`a1995cbe`, card `t_8519ceba`) is what pinned the two remaining tab-stop arms after the squash, and it adds no ledger byte.
- **The rule measures the delimiter line only, and the sibling class is decided rather than open.** Measured at `a1995cbe` on this record's ledger: indenting the header line (`README.md:158`) by four spaces answers `{ ok: true, columns: 3, rows: 495, issues: [] }`, and so does indenting the first body row (`:160`), while GFM emits **0** `<tr>` and renders that header as a `<pre><code>` block — the same false green, one line up and in a different shape. Card `t_554620ec` decided that class as **option 1** (the same four-column boundary extends to the header line and the body rows) and routed it as `t_2426a4f5` (TEST) → `t_82c65698` (GREEN) → `t_89423e89` (its own DOCS append); this paragraph does not name the reason codes that class will mint, because each paragraph of this record states what its own landing measured.
- **Nothing is retracted.** No section of this record is withdrawn: §Decision (the row is mandatory and lands with the record, the invariant is set equality both ways, the guard enforces it), §Consequences, §Alternatives considered, §Evidence and §Numbering (the block is exhausted; the `Next free` cell advances to `0320`) all stand as written. S1d hardens the guard module §Decision item 3 makes the enforcement point; it amends no decision.
- **This append's own delivery.** One file, this record, `+11/−0`, appended after the last fence with no byte above it edited; `prettier --check "docs/adr/ADR-0319-*.md"` is clean, `docs/adr/README.md` is untouched, and this append consumes no ADR number and adds no ledger row.

## Decision record — 2026-11-25 (F2, ledger row-set scope)

- **The decision.** A ledger row is a `| [NNNN](ADR-*.md) | …` line strictly **below** the `| ADR | Title | Status |` header. A row-shaped line at or above the header is preamble prose, not a ledger row: it is not counted in `rows`, and it takes no part in S1's cell-count report, S1c's block end, S1e's order sequence, S2's status agreement or S3's present-row set. Card `t_d93a538b` decided it (option 1), card `t_9c43bbf4` pinned it, and card `t_0cc5a04a` landed it as PR [#953](https://github.com/yahodu/openpic-webapp/pull/953), squash `3d1a0edd` — the commit every figure below was measured on.
- **What it repairs.** `ledgerTableOf` pushed every row-shaped line of the document into `rows`, so `rows` counted lines a reader never sees as table rows. That over-count was cosmetic while S1 alone read it; S1e, which compares consecutive numbers, turned the surplus line into a **wrong failure** whose message named a line that is not in the table. At `3d1a0edd` the loop skips every line at or above the header (`apps/web/src/test/helpers/adr-ledger-shape.ts:517`) and the module docblock states the contract (`:26`–`:29`).
- **The measured failure (F2 of card `t_f4793b77`).** An eight-line probe document — the prose sentence `A row-shaped line above the ledger is an example, not a row.`, a blank line, `| [0999](ADR-0999-example.md) | the example | Accepted |`, a blank line, the header, the delimiter, then the `0001` and `0002` rows — answers `{ ok: false, columns: 3, rows: 3, issues: [{ line: 7, reason: "0001 precedes 0999 on line 3" }] }` on the helper at `802166cf` (`3d1a0edd^`), and `{ ok: true, columns: 3, rows: 2, issues: [] }` at `3d1a0edd` — both re-measured by this card, the second helper being a copy of the first with the one skip removed. The line the old message named (`on line 3`) is **above** the table, and the row it blamed (`line: 7`, a real `0001` row) is inside it.
- **The same document, read by S3.** With a record file for `0999` present and its only row-shaped line above the header, the `802166cf` helper answers `rows: 2` and `missingRows: []` — a **false green on the one failure S3 exists to prevent** — while `3d1a0edd` answers `rows: 1` and `missingRows: [{ number: "0999", file: "ADR-0999-example.md" }]`. The two committed cases are `apps/web/src/test/unit/adr-ledger-shape.test.ts:1091` (the probe document, cell count and order) and `:1526` (the S3 false green).
- **Unreachable on the real tree at this cut.** An independent census of `docs/adr/README.md` reads header `:158`, **495** rows on `:160`–`:654` (`0001`–`0990`, distinct `495`, three cells each), **0** row-shaped lines at or above the header, **0** descents and **0** repeats — identical at `aab6bcad`, at `802166cf` and at `3d1a0edd`. The shape is therefore pinned **before** it can appear on the trunk: this repairs a report that no delivered byte triggers, not a live defect.
- **The safety half.** Scoping cannot hide the class the document-wide reading catches: a real record's row moved above the header is not in the rendered table, so its record has no row and S3's hard-pinned empty list fails. Measured at `3d1a0edd` on a document whose `0998` row sits above the header: `rows: 1` and `missingRows: [{ number: "0998", file: "ADR-0998-example.md" }]`. A header with nothing below it still fails: `{ ok: false, columns: 3, rows: 0, issues: [] }`, because `ok` is `rows > 0 && issues.length === 0`.
- **What did not change.** S1e's reason strings (`0971 precedes 0973 on line 4`-shape, `0970 repeats on line 3`), the S1c frozen characterization case (a blank line above the header still precedes a correct delimiter and reports nothing), S1d's delimiter rule and its four-column indentation boundary, and the fenced-block posture all stand as they read before this squash. No production code was touched: the squash names two files, both under `apps/web/src/test/`, `+92/−15`, and the helper's own change is the three-line skip plus docblock wording.
- **Where it stands.** PR [#953](https://github.com/yahodu/openpic-webapp/pull/953) answers `state=MERGED`, `mergeCommit 3d1a0edd…`; at `3d1a0edd` the ten `adr-*` guards read `10 passed (10)` / **371 passed (371)**, and the focused spec carries `50` `it(` declarations with the two cases above among them.
- **Nothing is retracted.** No section of this record is withdrawn: §Decision, §Consequences, §Alternatives considered, §Evidence and §Numbering (the block is exhausted; the `Next free` cell reads `0320`) all stand as written. The row-set scope is S1's own reading of what a row **is**; it amends no decision and relaxes no failure.
- **This append's own delivery.** One file, this record, `+13/−0`, appended after the last fence with no byte above it edited; `prettier --check "docs/adr/ADR-0319-*.md"` is clean, `docs/adr/README.md` is untouched, and this append consumes no ADR number and adds no ledger row.
