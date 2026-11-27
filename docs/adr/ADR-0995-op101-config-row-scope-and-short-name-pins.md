# ADR-0995 — OP-101: the configuration doc is pinned row by row, and short names are visible

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** OP-101 TEST `t_b49dc690` (openpic-webapp-testcase-writer), raised by findings **F2-a** (Low) and **F2-b** (Info) of the review card `t_3371e295` of PR [#987](https://github.com/yahodu/openpic-webapp/pull/987) (squash `49c4e3c8`) · **Branch:** `OP-101-task-config-row-scope-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ac75f547`
- **Lane:** OP-101 follow-up (configuration docs) · **Consumes:** `0995` — a **pool draw**, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18); `0994` is held by the in-flight sibling card `t_c4d4393e`, so this record draws above it and the four pool-mirror cells that read `0994` advance to `0996`
- **Spec sources:** `docs/Configuration.md` (67 table rows, 53 documented names), `.env.example` (48 keys), `apps/web/src/server/config/env.ts` (`rawSchema`, 26 keys)
- **Consumers:** `apps/web/src/server/config/env-example.test.ts`, `apps/web/src/test/helpers/configuration-documentation.ts`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the guard conventions this record follows), [ADR-0992](ADR-0992-op101-config-template-doc-pins.md) (D5 and §Consequences — the deviation and the blind spot this record reverses)

## Context

[ADR-0992](ADR-0992-op101-config-template-doc-pins.md) pinned `.env.example` to
`rawSchema` and pinned `docs/Configuration.md` to `.env.example` in both
directions. The round-1 review of PR [#987](https://github.com/yahodu/openpic-webapp/pull/987)
approved the delivery and then measured two weaknesses in the new pins with
mutation probes on the merged tree (`49c4e3c8`).

**F2-a — the row scope was not pinned.** `documentedNamesOf()` read the **whole**
of `docs/Configuration.md`, so direction 1 ("every `.env.example` key is
documented") was satisfied by a prose mention. On the merged tree, deleting the
`MONGODB_MAX_POOL_SIZE` table row and appending the sentence "The
`MONGODB_MAX_POOL_SIZE` knob caps the driver pool." left `30 passed (30)`. The
commissioning card asked for a documented **row**; ADR-0992 D5 recorded the
deviation as a rejected-alternative trade-off. Measured again on this branch
against the pre-change spec, the same mutation still reads `30 passed (30)`.

**F2-b — a short name was invisible.** The token pattern
`` `([A-Z][A-Z0-9_]{2,})` `` needed three characters, so direction 2 could not
see a one- or two-character documented name. Appending
``| `ZZ` | probe | all | - | - |`` to the doc left `30 passed (30)`. `CI` is
the only such token in the doc today: the CI runner sets it, and it is in
neither `.env.example` nor the four process-managed names. ADR-0992
§Consequences recorded the blind spot with a reversal condition — "naming `CI`
in the exception list and widening the token pattern". This record is that
reversal.

There is no live defect on this tree. The census before the change: 48 template
keys, 52 documented names, `template − documented = []`, `documented −
template` = exactly `E2E_PORT`, `HOSTNAME`, `MONGO_TEST_URI`, `PRODUCTION_PORT`,
and all 48 template keys already sit in table rows. Only the pins change.

## Decision

**D1 — direction 1 reads the doc's table rows, not its whole text.** A table row
is a line whose first non-space character is `|` (leading indentation is kept, so
a table nested in a list still counts, and a prose line that merely contains a
pipe is not a row). Every `.env.example` key must appear as a backticked token
**inside a table row**. A prose mention is not documentation of an operator
setting: an operator copies a value from a row, and a sentence cannot carry the
default, the allowed values or the failure mode the row carries.

**D2 — one derived case per template key, and the mention-level case stays.** The
row pin is `it.each(TEMPLATE_KEYS)("documents the %s key in a Configuration.md
table row")`, so a deleted row reds exactly one case and its **name states the
key** (48 cases today, one per template key, no literal to maintain). The
pre-change aggregate case is kept as `mentions every key that .env.example
declares`: it is the weaker summary, and keeping it makes the gap visible in the
failure output — under the F2-a mutation the row case reds while the mention case
stays green.

**D3 — the loud-failure contract is kept and is now tested.** The parsers throw
when the document carries **no table row** and when the rows name **no**
backticked variable. A reformatted table therefore fails loudly; it never reads
as "no rows" and it can never make the derived cases vacuous. Because the
parsers are the thing that must throw, they move to
`apps/web/src/test/helpers/configuration-documentation.ts`
(`tableRowsOf`, `documentedNamesOf`) and the spec feeds them fixture strings: a
document with no row throws, rows with no code span throw, an indented row counts
and a prose line with a pipe does not.

**D4 — the token pattern accepts a single leading character.** The pattern is
`` `([A-Z][A-Z0-9_]*)` ``. On this tree the widening changes the census by
exactly one name (`CI`, 52 → 53), and it closes the class rather than the
instance: a one-character name is visible too, which is why the spec pins
`Q`, `ZZ` and `CI` against fixture rows and the direction-2 mutation probes use a
two-character and a one-character name.

**D5 — `CI` gets its own documented exception.** `RUNNER_MANAGED_NAMES = ["CI"]`
carries a one-line reason in the spec ("the CI runner sets it: it turns on
Playwright retries and the GitHub reporter"), and it is a **separate list** from
`PROCESS_MANAGED_NAMES` because the two have different owners — a test process
versus the CI runner. Direction 2 admits a name from the template, from the four
process-managed names or from the runner list, and nothing else. A non-vacuity
case asserts `CI` is still documented, so the exception list cannot absorb a
deleted row — the same shape the four process-managed names have had since
ADR-0992.

**D6 — characterization, not RED.** The trunk satisfies all of this. The spec is
green on arrival and changes no production file, no `.env.example` value and no
variable row of the doc. Its value is negative: it reds when a template key loses
its row, when a documented row names a name no file knows, or when a short name
appears that nothing accounts for.

**Rejected alternatives.** Pinning only the row scope and leaving the pattern at
three characters: it would leave `CI` invisible and keep the reversal condition
open for the next short name. Widening the pattern without the `CI` exception:
that reddens the tree on `CI`, and the only ways to green it are to delete the
`CI` row (it is true and useful) or to weaken direction 2 — both wrong. Matching
rows with a markdown table parser: no dependency is warranted for a
line-shape rule, and the rule must fail loudly, which a permissive parser
tolerates badly. Reading the doc's rows only and dropping the mention-level case:
the pair is what shows the F2-a gap in one run.

## Evidence

Measured at `da78128a` (this card's pin commit), one spec file and one test
helper, no production file:

```text
focused  apps/web/src/server/config/env-example.test.ts   ->  85 passed (85)     (30 before this change)
full     vitest run --project unit (this head)            ->  3602 passed | 3 skipped (3605) / 203 files
full     vitest run --project unit (spec aside, same tree)->  3547 passed | 3 skipped (3550) / 203 files
prettier --check (both changed files)                     ->  clean
eslint (both changed files)                               ->  0 errors, 1 warning (security/detect-non-literal-fs-filename on the spec's readRepositoryFile, the same single warning the spec carried before)
pnpm typecheck                                            ->  exit 0
```

**Each pin is discriminating, measured with four mutations** (tracked
`docs/Configuration.md` mutated, focused spec re-run, file restored; `sha256`
`47e1b082…7837ebd` equal before and after every probe, `git status --short`
empty after the restore, no mutation committed):

- **A — a template key's row replaced by prose** (`MONGODB_MAX_POOL_SIZE` row
  deleted, the sentence "The `MONGODB_MAX_POOL_SIZE` knob caps the driver pool."
  appended): `1 failed | 84 passed (85)`, the red case named
  `documents the MONGODB_MAX_POOL_SIZE key in a Configuration.md table row`
  (`expected [ 'APP_ENV', 'APP_BASE_URL', …(50) ] to include
'MONGODB_MAX_POOL_SIZE'`). The mention-level case stayed green, and the
  **pre-change** spec read `30 passed (30)` under the same mutation: this is
  finding F2-a, reproduced and closed.
- **B — a row naming an unknown name** (``| `ZZZ_PROBE` | probe | all | - | - |``
  appended): `1 failed | 84 passed (85)`, the red case named `documents no name
outside .env.example except the four process-managed names and CI`
  (`expected [ 'ZZZ_PROBE' ] to deeply equal []`).
- **C — a two-character name** (``| `ZZ` | probe | all | - | - |`` appended):
  `1 failed | 84 passed (85)`, the same case (`expected [ 'ZZ' ] to deeply equal
[]`). This is the widened pattern biting, not merely being wider.
- **D — a one-character name** (``| `Q` | probe | all | - | - |`` appended):
  `1 failed | 84 passed (85)`, the same case (`expected [ 'Q' ] to deeply equal
[]`). The class is closed, not just the `CI` instance.

A fifth datum, not a mutation: with the new spec in place and the ADR absent, the
whole `unit` project reported `1 failed | 3601 passed | 3 skipped (3605)` —
`adr-source-references.test.ts > reports the repository's real source tree as
reference-clean` naming the spec and the helper as citing a record that did not
exist yet. The citation sweep reads the new references, and the red clears when
this record lands in the same PR.

## Consequences

- Deleting a template key's table row now fails, and the failure names the key —
  even when the doc still mentions the key in prose. Adding a row that names a
  name no other file knows fails too, including one- and two-character names.
- `CI` is now a documented exception beside the four process-managed names, and a
  case keeps it documented. A future short documented name, or a short typo in a
  row, reds direction 2 rather than passing silently.
- The rule is row-shape based, so a legitimate reformat must keep rows shaped
  `|`-first; a doc that loses every table row throws at collection instead of
  reporting green. That is intended, and it is pinned against fixtures.
- Reversal condition: if the doc ever needs to name a variable outside a table
  (a narrative section that must stay prose), the right change is another row in
  a table, not a second scope for direction 1 — the row scope is the operator
  contract. If a documented name is legitimate, short and neither template nor
  process- or runner-managed, it joins an exception list with a stated reason the
  way `CI` did, and the non-vacuity case keeps that list honest.
- `DISCORD_WEBHOOK_URL` stays unpinned by this card's scope decision: it is a
  GitHub repository secret, not app configuration.

## Numbering

The four-surface sweep at this cut (`origin/main` `0422e5a0`, working tree
`da78128a`):

1. the trunk's `docs/adr` ends at `ADR-0993`;
2. `git rev-list --objects --all -- docs/adr` also ends at `ADR-0993`;
3. the only `docs/adr` tree under `.worktrees/*` is this card's, which ends at
   `ADR-0993`;
4. `gh pr list --state open` returns **no** open PR, so no PR head holds a
   number; and no non-`done` card body names `0995`.

The one in-flight reservation in the sweep is `0994`: the sibling card
`t_c4d4393e` (chained behind this card) states "draw `0994`" in its body, and its
body is part of the board state that ADR-0300 §11 item 18 reads. This record
therefore draws **`0995`**, above the highest in-flight reservation, and leaves
`0994` to that card — a gap above the trunk's high-water mark is expected and
cheap under ADR-0300 §3, and no number is reissued. The four pool-mirror cells
(`board-wide / process`, `OP-129 attendee identity lane`, `OP-136 jobs lane`,
`unallocated (future lanes)`) read `0994`; the higher of `0994` and `0995 + 1` is
`0996`, so each advances to `0996` and none is lowered. Hotspot:
`docs/adr/README.md` (this record's ledger row and the four cells) — merge as a
union keeping the highest value in every cell.
