# ADR-0997 — OP-101: a template key is pinned to its own variable cell, not to any row

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** OP-101 TEST `t_325f02d0` (openpic-webapp-testcase-writer), raised by finding **F1** (Low) of the round-1 review of PR [#989](https://github.com/yahodu/openpic-webapp/pull/989) (squash `6c7fc642`) · **Branch:** `OP-101-task-config-row-owner-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ac75f547`
- **Lane:** OP-101 follow-up (configuration docs) · **Consumes:** `0997` — a **pool draw**, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18). The card body drew `0996`, and the layout lane's [ADR-0996](ADR-0996-op101-readme-and-workflow-layout.md) landed on the trunk first, so this record draws the next free number and the four pool-mirror cells that read `0997` advance to `0998` (§Numbering)
- **Spec sources:** `docs/Configuration.md` (67 table rows: 7 header rows, 7 delimiter rows, **53 variable rows**), `.env.example` (48 keys), `apps/web/src/server/config/env.ts` (`rawSchema`, 26 keys)
- **Consumers:** `apps/web/src/server/config/env-example.test.ts`, `apps/web/src/test/helpers/configuration-documentation.ts`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the guard conventions this record follows), [ADR-0995](ADR-0995-op101-config-row-scope-and-short-name-pins.md) (the row scope this record tightens — its D1 row shape, D3 loud failure and D4 token pattern stand, its "inside a table row" scope is superseded), [ADR-0992](ADR-0992-op101-config-template-doc-pins.md) (the two-direction pin this narrows)

## Context

[ADR-0995](ADR-0995-op101-config-row-scope-and-short-name-pins.md) D1 narrowed
direction 1 from "anywhere in the document" to "inside a table row", and built
the set as `documentedNamesOf(rows.join("\n"))` — the token set of **all 67 rows
joined**. A row therefore satisfied the pin if the key appeared in _any_ cell of
_any_ row, including a neighbour's cross-reference. The round-1 review of PR
[#989](https://github.com/yahodu/openpic-webapp/pull/989) approved the delivery
and then measured the residual on the merged trunk `6c7fc642` with deletion
probes of the tracked doc (mutate, focused spec, restore):

```text
A  delete R2_ENDPOINT's own row (it survives in STORAGE_PROVIDER's Credentials cell)      85 passed (85)
B  delete LOG_TRANSPORTS' own row (it survives in BETTERSTACK_SOURCE_TOKEN's Notes cell)  85 passed (85)
C  delete MONGODB_MAX_POOL_SIZE's own row, re-add the name in MONGODB_URI's Notes cell    85 passed (85)
D  delete MONGODB_MAX_POOL_SIZE's own row, re-add it in a brand-new unrelated table       85 passed (85)
E  control: delete MONGODB_SERVER_SELECTION_TIMEOUT_MS's own row (no cross-mention)       2 failed | 83 passed (85)
```

**11 of the 48 template keys** already carry a second-row mention on this tree —
`LOG_TRANSPORTS`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`R2_ENDPOINT`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_ORIGINALS`, `R2_BUCKET_THUMBNAILS`, `R2_BUCKET_EXPORTS`,
`R2_BUCKET_BRANDING` — so for exactly those keys the own row was unpinned: the
pin read green while the row an operator copies from was gone.

The commissioning card of ADR-0995 asked for a key documented "inside a markdown
table row", so PR #989 followed its contract and this is a tightening, not a
defect in that PR.

There is no live defect on this tree. The census at this cut: **53 distinct
variable rows** own 53 names, `template − ownRow = []` (all 48 template keys own
exactly one first-cell row), and the 11 cross-mentions are legitimate
cross-references — not duplicate rows to delete. Only the pins change.

## Decision

**D1 — direction 1 reads the key's own variable cell.** A row **owns** a name
when its first (`Variable`) cell — the cell between the leading `|` and the next
`|` — is **exactly one** backticked `UPPER_SNAKE` token. Every `.env.example`
key must be owned by a row. A mention in another variable's cell is a
cross-reference, not documentation of that variable: the operator copies the
default, the allowed values and the failure mode out of the variable's own row.

**D2 — one derived case per template key, and the case name states the key.** The
pin stays `it.each(TEMPLATE_KEYS)` — one case per template key, 48 cases, no
literal to maintain — and the case name reads `owns the %s variable cell of a
Configuration.md table row`, so deleting one row reds exactly one case whose name
names the key.

**D3 — the mention-level case is kept.** `mentions every key that .env.example
declares` still reads the whole document (`documentedNamesOf`), so under a
mutation that deletes a row _and_ leaves a cross-mention the mention case stays
green while the own-cell case reds: the gap stays visible in one run, and a doc
that loses the name **entirely** reds both.

**D4 — the parser owns the cell shape, and it fails loudly.**
`variableCellNamesOf(rows)` in
`apps/web/src/test/helpers/configuration-documentation.ts` reads the first cell of
each row and:

- **skips** a delimiter row (`| --- | --- |`, alignment colons allowed) and a
  header row — a row whose successor is a delimiter row, which is how markdown
  defines a table's header — because neither is a variable row;
- **throws** on any other row whose first cell is not a single backticked token
  (`| plain prose | … |`, ``| `A` / `B` | … |``), so a reformatted table fails
  loudly instead of quietly shrinking to the rows that still parse;
- **throws** when the rows own no name at all (a row-shaped document with zero
  owners), and when it is handed no row;
- **returns** the owned names in first-appearance order, deduplicated — the same
  shape `documentedNamesOf` returns.

Seven fixture cases pin those shapes in the spec: the header and delimiter rows
skipped (one owner read), a prose first cell (throws), two names in one cell
(throws), a name that appears **only inside another row's cell** (not owned), a
first-cell name the template does not declare (owned by the parser, so the key
pin is what rejects it — direction 1 is not a "unknown name" guard), a
row-shaped document with no owner (throws), and the empty row list (throws).

**D5 — characterization, not RED.** The trunk already satisfies the tightened
pin: no production file, no `.env.example` value and no variable row of the doc
changes. This spec's value is negative — it reds when a template key loses its
**own** row even while the name remains visible in a neighbour's cell.

**D6 — a duplicate own row is not pinned.** If a variable's own row were written
twice, the deduplicated owner set would still contain the name and direction 1
would pass. That is deliberate: a duplicated row is a rendering defect of the
doc, not a configuration-contract defect, direction 2 already reds a row naming a
name no file knows, and a `count === 1` pin would red the suite on a legitimate
documentation refactor. If a duplicate ever ships, the right change is a
dedicated row-uniqueness pin, not a widening of this one.

**Rejected alternatives.** Keeping the joined-row token set and adding a second,
stronger case: the weak case stays green under exactly the mutation that matters,
so it would report "documented" for a variable the doc no longer documents.
Skipping every non-owning row silently instead of throwing: a reformatted table
would read as "fewer variables", which is the failure mode ADR-0995 D3 closed.
Matching the first cell with a looser pattern (`` `([A-Z][A-Z0-9_]*)` `` anywhere
in the cell): it accepts ``| `A` / `B` |`` and prose that mentions a name, which
is the same bug one level down. Pulling in a markdown table parser: no dependency
is warranted for a line-shape rule that must fail loudly, and a permissive parser
tolerates a malformed table badly. Pinning the doc's row count (53): it is a
maintenance tax on a legitimate doc edit and adds nothing to the template-key
contract.

## Evidence

Measured on this branch (`ae59a659` + `db89cba1`), one spec file and one test
helper changed, no production file:

```text
focused  apps/web/src/server/config/env-example.test.ts   ->  92 passed (92)     (85 before this change)
full     vitest run --project unit (this head)            ->  3619 passed | 3 skipped (3622) / 203 files
full     vitest run --project unit (origin/main files)    ->  3612 passed | 3 skipped (3615) / 203 files
prettier --check (both changed files)                     ->  clean
eslint (both changed files)                               ->  0 errors, 1 warning (security/detect-non-literal-fs-filename on the spec's readRepositoryFile — the same single warning the spec carried before, delta 0)
pnpm typecheck                                            ->  exit 0
pnpm lint                                                 ->  0 errors, 193 warnings (repo total, unchanged)
```

**Each probe is discriminating, measured with the tracked `docs/Configuration.md`
mutated, the focused spec re-run, the doc restored** — `sha256
47e1b082…b80837ebd` equal before and after every probe, `git status --short`
empty after each restore, and no mutation committed:

- **A — `R2_ENDPOINT`'s own row deleted** (the name survives in
  `STORAGE_PROVIDER`'s credentials cell): `1 failed | 91 passed (92)`, the red
  case named `owns the R2_ENDPOINT variable cell of a Configuration.md table row`
  (`expected [ 'APP_ENV', 'APP_BASE_URL', …(50) ] to include 'R2_ENDPOINT'`).
  The **pre-change** spec read `85 passed (85)` under exactly this mutation —
  finding F1, reproduced and closed.
- **B — `LOG_TRANSPORTS`' own row deleted** (survives in
  `BETTERSTACK_SOURCE_TOKEN`'s notes cell): `1 failed | 91 passed (92)`, the red
  case named `owns the LOG_TRANSPORTS variable cell of a Configuration.md table
row`.
- **C — `MONGODB_MAX_POOL_SIZE`'s own row deleted and the name re-added inside
  `MONGODB_URI`'s notes cell** (one occurrence of the token left in the file,
  inside a row): `1 failed | 91 passed (92)`, the red case named `owns the
MONGODB_MAX_POOL_SIZE variable cell of a Configuration.md table row`, while the
  **pre-change** spec read `85 passed (85)`. This is the discriminating half: the
  token is still in a row, so only the own-cell scope can catch it.
- **D — the control, the real tree unchanged**: `92 passed (92)` before and after
  the change.

A fifth datum, not a mutation: with the spec and helper in place and this record
absent, the whole `unit` project reported `1 failed | 3618 passed | 3 skipped
(3622)` — `adr-source-references.test.ts > reports the repository's real source
tree as reference-clean` naming the two changed files as citing a record that did
not exist yet. The citation sweep reads the new references, and the red clears
when this record lands in the same PR.

## Consequences

- A template key whose own row is deleted now reds the suite and names the key,
  **even when the doc still cross-references it** in another variable's row. The
  eleven keys with a second-row mention are pinned like the other 37.
- A variable that gains a row of its own is picked up automatically: the owner
  set is derived from the doc, and the template-key set from `.env.example`.
- A reformatted table fails loudly — a row whose first cell is not exactly one
  backticked token throws with the row text in the message, so a table that turns
  into prose, or a first cell that carries two names, cannot read as "fewer
  variables". A delimiter row and a header row are the only tolerated non-owning
  shapes.
- The parser reads cells by splitting on `|`, so a pipe inside a code span would
  need escaping. `docs/Configuration.md` has none today; a future cell that wants
  a literal pipe must escape it, and the first cell must never carry one.
- Not covered on purpose: a duplicated own row (D6), whether a row's _value_ cell
  matches `.env.example`'s value, and whether the doc's prose matches the rows.
  Direction 2 still owns "no unaccounted name", the mention-level case still owns
  "every key is mentioned somewhere", and `DISCORD_WEBHOOK_URL` stays unpinned
  because it is a GitHub repository secret, not app configuration.
- Reversal condition: if the doc ever needs a variable documented outside a table
  row, the right change is another row, not a second scope for direction 1. If a
  legitimate row must name two variables in one cell, the right change is two
  rows — not a two-name parser arm, which would disarm the loud failure for every
  row at once.

## Numbering

The four-surface sweep at this cut (`origin/main` `ae59a659`, working tree
`db89cba1`):

1. the trunk's `docs/adr` ends at `ADR-0996`;
2. `git rev-list --objects --all -- docs/adr` also ends at `ADR-0996`, so no ref
   holds `0997`;
3. the `docs/adr` trees under `.worktrees/*` are this card's and the layout
   lane's (`op101-readme-workflow`, detached at `79e62ae4`), which holds
   `ADR-0996` and no `0997`;
4. `gh pr list --state open` returns **no** open PR, so no PR head holds a
   number, and no non-`done` card body but this card's names `0997` (it is the
   "cells advance to" value).

The card body drew `0996` and stated that `0996` was on no ref, in no worktree and
in no open PR. That was true when the card was written; the layout lane's
[ADR-0996](ADR-0996-op101-readme-and-workflow-layout.md) landed on `origin/main`
before this card ran, and its own §Numbering advanced the four pool-mirror cells
from `0996` to `0997`. Re-drawing `0996` would duplicate a number, so this record
draws **`0997`** — the next free number above the trunk's high-water mark under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §3 — and no number is
reissued. The four pool-mirror cells (`board-wide / process`, `OP-129 attendee
identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read `0997`; the
higher of `0997` and `0997 + 1` is `0998`, so each advances to `0998` and none is
lowered. Hotspot: `docs/adr/README.md` (this record's ledger row and the four
cells) — merge as a union keeping the highest value in every cell. The number is
re-swept against every open PR head immediately before the merge (`§9.1` G7).
