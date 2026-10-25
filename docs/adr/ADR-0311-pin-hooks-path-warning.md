# ADR-0311 — OP-110 follow-up TEST: report a failed `core.hooksPath` pin instead of swallowing it

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up TEST (`t_60e20c44`) · **Branch:** `OP-110-task-pin-hooks-path-warning` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_54545281`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0311`
- **Relates to:** [ADR-0310](ADR-0310-git-identity-guard-pins.md) (the guard's pinned contract and the `core.hooksPath` wiring fact), [ADR-0309](ADR-0309-git-config-read-vs-write-identity-guard.md) (the durable identity rule the guard enforces), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md) (a card must not complete on an unmerged deliverable)
- **Supersedes:** nothing. This record pins one **observability** contract for the `prepare` step `scripts/git/pin-hooks-path.mjs`; it re-decides neither the guard (ADR-0309) nor the `.husky` wiring (ADR-0310 §2).
- **Gated GREEN:** `t_de160aea` (reports the failed pin; must base its branch on this branch's tip, not bare `origin/main`). This RED card delivers **one test file + this ADR + the README ledger cells only**.

## Context

`scripts/git/pin-hooks-path.mjs` (added by PR #348, squash `2f5a0806`) is the
`prepare` step that pins `core.hooksPath` to the tracked `.husky` directory, which
is what makes the commit-time identity guard (ADR-0309) fire in **every**
worktree, including a fresh `git worktree add` worktree that has run no install
(ADR-0310 §2). It wraps **both** git calls in one bare `catch {}`:

```js
try {
  git(["rev-parse", "--is-inside-work-tree"]);
  git(["config", "core.hooksPath", ".husky"]);
} catch {
  // No work tree to configure (e.g. an install from a source tarball).
}
```

The tolerance is correct for the "no work tree" case (a source tarball install),
but the bare catch cannot tell that case apart from a **failed pin**: a read-only
`.git/config`, a `.git` owned by another user (git refuses with
`detected dubious ownership`), or any other `git config` failure all collapse into
the same silent no-op. The guard is then **silently absent** in every worktree of
that checkout — the exact state it exists for — with no diagnostic anywhere in
the install output. Routed as finding **F1 (Low)** by the REVIEW/LAND card
`t_5f824ce6`.

## Decision §1 — the seam (pinned)

The runner logic must be reachable from a spec without touching the real
`.git/config`, so the module exposes a decision function whose I/O is injected:

```
module   scripts/git/pin-hooks-path.mjs        (unchanged path; still the `prepare` runner)
exports  pinHooksPath(deps): number            — returns the process exit code
deps     { runGit(args: readonly string[]): void;   // throws on any git failure
           stderr: { write(chunk: string): unknown } }  // the diagnostic sink
```

Behaviour, in order:

1. `runGit(["rev-parse", "--is-inside-work-tree"])` **throws** → the process is
   not inside a work tree → write **nothing**, return `0`, and never attempt the
   `core.hooksPath` write. The tarball tolerance is preserved exactly.
2. rev-parse succeeds and `runGit(["config", "core.hooksPath", ".husky"])`
   **throws** → write **one** line to stderr that names `core.hooksPath` and
   carries the underlying git failure, then still return `0`. The `prepare`
   chain must stay non-fatal: a failed pin is **reported**, never thrown.
3. both succeed → write nothing, return `0`, having pinned the load-bearing
   value `.husky` after confirming the work tree.

Importing the module must have **no side effect**: the runner (reading the real
git and `process.stderr`) runs only when the file is the process entry point,
never on import. Otherwise the spec's own import would mutate the worktree config
or exit the test process.

## Decision §2 — the seam lives in the `.mjs`, not in a new `.ts` module

The card suggested moving the decision into an importable module; the sibling
lane uses a pure `.ts` module (`scripts/git/identity-guard.ts`) plus a separate
`.ts` CLI wrapper (`scripts/git/check-identity.ts`). That shape is **not**
available here:

- `package.json`'s `prepare` wiring is fixed by the GREEN card's constraints to
  `husky && node scripts/git/pin-hooks-path.mjs` — a bare `node`, no
  `--experimental-strip-types`. The runner therefore cannot import a `.ts` seam
  through a Node whose default type-stripping is off (`engines: node >=22.12.0`;
  type stripping became default only in Node 22.18/23.6).
- A `.mjs` seam imported by both the runner and the spec needs no loader and no
  `package.json` change, and `apps/web/tsconfig.json` already sets `allowJs:
true`, so the spec can import it and `tsc` stays clean.

The seam is therefore the existing `scripts/git/pin-hooks-path.mjs` itself. The
GREEN owns the main-module guard (`import.meta.url` vs `process.argv[1]`) and the
real `runGit`/`process.stderr` wiring; nothing else about the wiring decision is
re-opened here.

## The pin (RED)

`apps/web/src/test/unit/pin-hooks-path.test.ts` — 7 assertions over the seam,
imported by its relative path
(`../../../../../scripts/git/pin-hooks-path.mjs`, the `scripts/`-from-`apps/web/src/test`
convention) so it lives in the `unit` Vitest project:

- **2 not-a-work-tree rows** (`it.each`) — "not a git repository at all" and
  "the repository is bare" — each asserting exit `0`, **no** stderr line, and
  exactly one git invocation (`rev-parse`), which pins that the `core.hooksPath`
  write is never attempted (the tarball tolerance);
- **3 failed-write rows** (`it.each`) — a locked config file, a dubious-ownership
  repository and a read-only file system — each asserting exactly **one** stderr
  line that contains `core.hooksPath` **and** the underlying git message, ends in
  `\n`, and that the exit code is still `0`;
- **1 no-rethrow case** — a failed pin does not throw, so `pnpm install` cannot
  fail on it;
- **1 happy-path case** — the git invocations are exactly
  `["rev-parse", "--is-inside-work-tree"]` then
  `["config", "core.hooksPath", ".husky"]` (order and the load-bearing `.husky`
  value pinned), with no stderr line and exit `0`.

The spec reads the export through a typed guard that throws a message naming the
missing export (`scripts/git/pin-hooks-path.mjs must export pinHooksPath(deps)`),
so the RED is a _named_ failure rather than an opaque import/member error, and
`tsc` stays clean at this head even though the export does not exist yet.

## Evidence at the RED head

Head: branch `OP-110-task-pin-hooks-path-warning` off `origin/main` `5ecfc18`.

- Focused RED:
  `npx vitest run --project unit apps/web/src/test/unit/pin-hooks-path.test.ts`
  → `Test Files 1 failed (1)` · `Tests 7 failed (7)`, every failure raising
  `Error: scripts/git/pin-hooks-path.mjs must export pinHooksPath(deps): number — the injectable seam this pin drives (see ADR-0311).`
- Full unit project → `Test Files 1 failed | 118 passed (119)` ·
  `Tests 7 failed | 2042 passed | 3 skipped (2052)`; the only failing file is the
  new spec. Baseline (this spec moved aside) is therefore **118 files / 2045
  tests** — measured at this head, not copied from the parent card, whose
  `115 files / 2005` figure belongs to an older head (the OP-111 lane landed
  since).
- `npx tsc -p apps/web/tsconfig.json --noEmit`, `npx tsc -p tsconfig.json --noEmit`
  and `npx tsc -p packages/contracts/tsconfig.json --noEmit` → all exit `0`.
- `npx eslint apps/web/src/test/unit/pin-hooks-path.test.ts` → exit `0`,
  0 problems; `npx prettier --check` clean.

**Discrimination probe (two throwaway seam stubs, deleted — the `.mjs` was
restored byte-identically, `sha256 7b5135b3…dafd`, `git status` shows only the
new spec):**

- a stub reproducing today's bare-`catch` behaviour → `Tests 4 failed | 3 passed (7)`,
  the four failures being exactly the diagnostic cases
  (`AssertionError: expected [] to have a length of 1 but got +0`), with both
  not-a-work-tree rows and the happy-path row still green (the tolerance and the
  pin attempt are already correct today);
- a stub implementing the contract above → `Tests 7 passed (7)`.

So the pin is satisfiable, it fails today **only** on the missing diagnostic, and
it cannot be satisfied by a seam that drops either the tarball tolerance or the
actual `core.hooksPath` write.

## Out of scope (deliberately not tested)

- **The runner's own wiring.** The spec drives the decision through injected I/O;
  it does not spawn `node scripts/git/pin-hooks-path.mjs` against a real
  repository. Producing a real "inside a work tree but the write fails" state
  deterministically is not possible here (the sandbox runs as root, so `chmod` on
  `.git/config` does not deny the write), which is exactly why the card asks for
  the injectable seam. The runner's exit code and stderr wiring are the GREEN's
  to prove.
- **The diagnostic's exact prose.** Pinned only by tokens (`core.hooksPath` + the
  underlying message + a trailing newline); the wording and any `[prefix]` are the
  GREEN's.
- **A `rev-parse` failure caused by something other than "not a work tree".**
  `detected dubious ownership` can make `git rev-parse --is-inside-work-tree`
  fail _before_ the write is attempted; under the pinned behaviour 1 that is
  treated as "not a work tree" and stays silent. Distinguishing it would require
  an error-class contract the card does not ask for — flagged here as a **residual
  observability gap**, not pinned.
- **`husky`'s own reset of the key** and the `prepare` ordering; unchanged and
  covered by ADR-0310 §2.

## ADR number allocation

The board-wide / process range is `0300`–`0319`. On the fresh `origin/main`
`5ecfc18` the README `Next free` cell read **`0311`** (`0300`–`0309` consumed,
`0310` by [ADR-0310](ADR-0310-git-identity-guard-pins.md)), so this record takes
`0311` — the cell's value re-read immediately before committing — and advances
the cell to `0312`. No number outside `0300`–`0319` is touched.

## GREEN realization

Not yet recorded — the gated GREEN is `t_de160aea`, which must base its branch on
this branch's tip and append its realization section here without minting a new
ADR number.
