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
