# ADR-0992 — OP-101: `.env.example` is pinned to the schema, and the documentation to the template

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** OP-101 TEST `t_3371e295` (openpic-webapp-testcase-writer), raised by finding **F2** of the review card `t_ac75f547` of PR [#985](https://github.com/yahodu/openpic-webapp/pull/985) (squash `3dbd684b`) · **Branch:** `OP-101-task-config-doc-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ac75f547`
- **Lane:** OP-101 follow-up (configuration docs) · **Consumes:** `0992` — a **pool draw**, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18); the four pool-mirror cells read `0992` at this cut and each advances to `0993`
- **Spec sources:** §7 of OP-70 (`.env.example` is the operator-facing documentation of the configuration contract), `apps/web/src/server/config/env.ts` (`rawSchema`, 26 keys), `docs/Configuration.md` (52 documented names)
- **Consumers:** `apps/web/src/server/config/env-example.test.ts`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the guard conventions this record follows)

## Context

PR [#985](https://github.com/yahodu/openpic-webapp/pull/985) added
`docs/Configuration.md` — 52 documented environment names — and widened
`.env.example` to 48 keys, but nothing read either file against the schema. The
one guard, `apps/web/src/server/config/env-example.test.ts`, asserted `^KEY=`
presence for a **hand-maintained list of 21** keys while `rawSchema` declared
**26**: `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_INGEST_HOST`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `RATE_LIMIT_SALT` were
in the schema and in no list, so deleting their template rows failed nothing.
Its docstring claimed it "keeps the example from drifting behind the schema".
It did not, and `docs/Configuration.md` was pinned by nothing at all.

Measured on the merged trunk before this change:

```text
.env.example active KEY= lines            48  (unique)
docs/Configuration.md backticked names    52  (unique)
rawSchema keys in env.ts                  26
documented minus template                 4   (MONGO_TEST_URI, E2E_PORT, PRODUCTION_PORT, HOSTNAME)
template minus documented                 0
schema minus template                     0   (after #985 widened the template)
```

Two drifts are therefore silent today: a schema key with no template row, and a
template key or a documented name with no counterpart on the other side.

## Decision

**D1 — the key list is derived from `rawSchema`, never written down.** The spec
reads `apps/web/src/server/config/env.ts`, slices the block from
`const rawSchema = z.object({` to the first `\n});` line, and matches every
`^\s+([A-Z][A-Z0-9_]+):` entry. The extraction **throws** when the opener, the
closing line or the entry list is missing: an empty list would make every
derived case vacuous, and a spec that silently pins nothing is worse than no
spec. This is the pin that would have caught the five unguarded keys.

**D2 — one case per derived key, plus a non-vacuity anchor.** `it.each` over the
derived list keeps the per-key failure message the old list had
(`documents the BETTERSTACK_SOURCE_TOKEN key that rawSchema declares`) without a
literal to maintain: a key added to the schema becomes a case on the next run.
The anchor case asserts the derived list still holds `APP_ENV`, `APP_BASE_URL`,
`ALLOWED_ORIGINS` and `MONGODB_URI` — the four always-required names — so a
reformat that silently stops matching cannot pass as an empty list.

**D3 — the documentation is pinned in both directions.** The documented names
are the backticked `UPPER_SNAKE` tokens of the markdown
(`/`([A-Z][A-Z0-9_]{2,})`/g`), and two cases assert:

1. every `.env.example` key is documented — a template key with no row fails;
2. every documented name that is not a template key is one of exactly four
   process-managed names — `MONGO_TEST_URI`, `E2E_PORT`, `PRODUCTION_PORT`,
   `HOSTNAME` — so a new or mistyped row cannot hide behind "process-managed".

A third case asserts those four are still documented, so the exception list
cannot absorb a deleted row. The three-token minimum in the pattern is
deliberate and load-bearing: the doc also names `CI`, which is two characters,
is set by the CI runner, and is in neither `.env.example` nor the exception
list. Consequence, stated rather than hidden: **a future documented name of one
or two characters is invisible to direction 2**; widening the pattern to `+`
would redden the pin on `CI` today.

**D4 — characterization, not RED.** The trunk satisfies all of this, so the spec
is green on arrival and changes no production file. Its value is negative: it
reds when a schema key loses its template row, when a template key loses its
documented row, or when the doc or the schema grows a name no other file knows.
The mutation evidence below is the proof each case is load-bearing.

**D5 — rejected alternatives.** Importing `rawSchema` instead of reading the
source: the object is module-private, `env.ts` validates `process.env` at import
time, and exporting it for a test would add a production export for no operator
value — and the card forbids changing `env.ts`. Keeping the 21-name literal
beside the derived case: it is the defect, restated; the derived `it.each`
replaces it case for case. Pinning the doc's table rows rather than its tokens:
the doc also names variables in prose, and a row-shaped parser would read a
reformatted table as "no rows" instead of failing.

## Evidence

**Counts, measured on this branch** — cut at `origin/main` `2b1615f5`; one spec
file touched, no production file.

```text
focused  apps/web/src/server/config/env-example.test.ts   ->  30 passed (30)   (21 cases before this change)
full     vitest run --project unit (this head)            ->  3543 passed | 3 skipped (3546) / 202 files
full     vitest run --project unit (same tree, spec stashed) ->  3534 passed | 3 skipped (3537) / 202 files
ten      adr-* guard specs                                ->  10 files / 396 passed (396)
typecheck / lint / prettier                                ->  exit 0 / exit 0 / clean
```

**Each pin is discriminating, measured with three mutations** (tracked files
mutated, run, restored; `sha256` of `.env.example`
`d64e221d…4d390cf` and of `docs/Configuration.md` `47e1b082…37837ebd` equal
before and after, `git status --short` naming the spec only):

- **A schema key commented out of the template** (`BETTERSTACK_SOURCE_TOKEN=` →
  `# BETTERSTACK_SOURCE_TOKEN=`): `Tests 2 failed | 28 passed (30)` —
  `documents the BETTERSTACK_SOURCE_TOKEN key that rawSchema declares`
  (`expected [ 'APP_ENV', 'APP_BASE_URL', …(45) ] to include
'BETTERSTACK_SOURCE_TOKEN'`) and `documents no name outside .env.example
except the process-managed four` (`expected [ 'BETTERSTACK_SOURCE_TOKEN' ] to
deeply equal []`). This is the P1 pin biting.
- **A documented row deleted** (`MONGODB_MAX_POOL_SIZE` row removed from
  `docs/Configuration.md`): `Tests 1 failed | 29 passed (30)` —
  `documents every key that .env.example declares`, naming the key. This is P2
  direction 1 biting.
- **The card's own example** (`ATLAS_SEARCH_ENABLED=` commented out of the
  template): `Tests 1 failed | 29 passed (30)`, and the failing case is P2's
  reverse direction, **not** P1 — `ATLAS_SEARCH_ENABLED` is a template-only key
  that is absent from `rawSchema`, so removing it cannot red a
  schema-to-template assertion. The card names this mutation as a P1 probe; that
  attribution is wrong and P1's probe is `BETTERSTACK_SOURCE_TOKEN` above.

After each restore the focused file reads `30 passed (30)` again.

## Consequences

- Adding a key to `rawSchema` without a `.env.example` line now fails on the next
  unit run, and the failure names the key. Adding a template key without a
  `docs/Configuration.md` row fails too, as does a documented name that is in
  neither the template nor the four-name list.
- The guard reads two tracked files by path from the spec, so a legitimate move
  of `docs/Configuration.md` reds it; that is intended — the spec's job is to
  keep the three files adjacent.
- Reversal condition: a product decision to keep some schema key out of the
  operator template (e.g. a platform-injected name) needs its own exception list
  with a stated reason, the way the four process-managed names have one here.
- The `CI` gap is recorded, not fixed: a two-character documented name escapes
  direction 2. Fixing it means naming `CI` in the exception list and widening
  the token pattern, which is a documentation-contract change for the card that
  owns `CI`'s row.
- Two names still carry no pin in either direction: the 22 template keys that
  are absent from `rawSchema` (the R2, Cashfree, `SESSION_TTL_SECONDS`,
  `NOVU_*`, `ATLAS_SEARCH_ENABLED` and `MONGODB_*` families) are read
  by adapters and scripts, not by the schema, so "the schema is the template's
  superset" is **not** claimed — only that every schema key has a template row.

## Numbering

The four-surface sweep at this cut (`origin/main` `2b1615f5`, squash of
PR [#986](https://github.com/yahodu/openpic-webapp/pull/986)) finds the trunk's
`docs/adr` ending at `ADR-0991`; `git rev-list --objects --all -- docs/adr`
ends at `0991`; the only `docs/adr` tree under `.worktrees/*` is this card's;
`gh pr list --state open` is empty; and no non-`done` card body names `0992` or
`0993` (the only open cards are this one and its queued F3 sibling, which holds
no number). `0992` is therefore a pool draw above the highest in-flight
reservation per [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11
item 18. The four pool-mirror cells (`board-wide / process`, `OP-129 attendee
identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read `0992`;
the higher of `0992` and `0992 + 1` is `0993`, so each advances to `0993` and
none is lowered. Hotspot: `docs/adr/README.md` (this record's ledger row) — merge
as a union keeping the highest value in every cell.
