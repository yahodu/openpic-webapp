# ADR-0317 — A lane workspace path is not durable board state: verify and rebuild at dispatch, reclaim only through the kanban-aware surface

- **Status:** Accepted · **Date:** 2026-11-18
- **Card:** board process (`t_559f577f`, Medium; evidence measured by the orchestrator card `t_f4a1695b`) · **Branch:** `OP-0317-task-lane-workspace-durability` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/adr-0317`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0317`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (number allocation), [ADR-0308](ADR-0308-one-owner-per-branch-landing.md) (one card owns a branch's landing — this record extends the same ownership to the checkout a card runs in), [ADR-0312](ADR-0312-same-lane-adr-card-serialization.md) (the task-graph serialization that keeps two cards off one path)
- **Schema:** n/a · **Contract:** n/a (process rule; no application code)
- **Implementation:** none (no file under `.github/`, `apps/` or `packages/` changes) · **Spec:** none (no code, no test)

## Context

A card's `workspace_path` is a **row value**. It names a directory, not a
guarantee. Between 2026-11-18T10:25Z and 10:46Z about 26 registered git
worktrees under `/root/openpic/openpic-webapp/.worktrees/` were removed —
directory and registration together — while cards that named those paths were
`todo`, `ready` or `running`. The OP-136 lane's shared path
`.worktrees/t_16239628` (named by 8 non-terminal cards) was one of them, and a
reviewer had to rebuild it in the middle of its own run.

The orchestrator card `t_f4a1695b` measured every candidate reaper and ruled
each one out (the table is reproduced in §Evidence). The board-side rule already
exists and held: kanban completion cleanup logged `Deferring workspace cleanup
for task t_16239628 … still used by another non-terminal task`, `hermes kanban
gc` carries the same guard, and `hermes worktree prune --dry-run` prints
`skip-kanban` for every `t_<hex>` tree. The removal was an **out-of-band,
attended reclaim**: a bulk `git worktree remove` sweep (or `rm -rf` plus `git
worktree prune`) run outside any card. No board-side hook can prevent that
surface, because the surface is a human shell.

The observed damage is not only lost files. A `dir`-only lane whose path has no
checkout at all starts in an **empty tree**: `pnpm vitest run` finds no project,
prints no `Tests` line, exits `0`, and the run looks green. That is the failure
class this record closes — silently quiet success on a tree that does not exist.

## Decision

### 1. A lane path is not durable board state — verify and rebuild, then work

`workspace_path` names a checkout that **may be gone when the card is
dispatched**. Before any work, a worker whose `dir` or `worktree` path is
missing, empty, or not a checkout of its lane (no `.git` entry, or `git -C
<path> rev-parse HEAD` exits non-zero) must **not** run. It reconstructs the
tree first, in this order:

1. The row — or the lane's worktree row — names a branch that exists:
   `git -C <repo> worktree add <path> <lane-branch>`. Attaching the branch is
   what recovers committed work; four of the ten rebuilt lanes below recovered
   their commits this way.
2. The row names no branch: `git worktree add -b wt/<card> <path> origin/main`.
3. A `dir`-only lane: `git worktree add --detach <path> origin/main`.

Then, in that tree, `CI=true pnpm install --frozen-lockfile --prefer-offline`.
Board rule `t_a8751258` stands: every tree owns its own `node_modules`, and a
donor symlink from a sibling is not a substitute — the install is part of the
rebuild, not an optimisation after it.

Finally a `kanban_comment` names what was rebuilt (path, ref, head, install
result), so the next worker and the reviewer read a measurement instead of a
clean `git status` that proves nothing.

### 2. Reclaim only through the kanban-aware surface

Operators and agents reclaim with one of two tools, and nothing else:

- `hermes worktree prune` — kanban-named trees are `skip-kanban` (the candidate
  filter skips `^t_[0-9a-f]+$`) and trees with a live process are skipped;
- `git worktree remove <one named path>` — a path chosen deliberately.

Never a bulk `rm -rf .worktrees/*` and never a `git worktree list`-driven loop.
Neither sees which cards name a path, so both delete live lanes. That is exactly
the fingerprint of the incident above.

If a hand reclaim is unavoidable, read the board first and leave those paths
alone:

```
SELECT workspace_path FROM tasks
WHERE status NOT IN ('done', 'archived', 'failed', 'cancelled')
```

Any path that query returns is a live lane. It is not a cache entry, and its age
is not evidence that nobody will use it.

### 3. Card creation verifies existence

Whoever mints a `dir` follow-up that points at an **existing** lane path
verifies `test -d "$workspace_path"` at creation time — the same place the
worktree-collision audit runs. A stale path is rebuilt in that creating run, or
the card is not minted with it. A card that is born pointing at a path that will
be empty at dispatch is a card that fails rule 1 or, worse, satisfies it
vacuously by running in nothing.

Rule 1 makes rule 3 survivable and rule 3 makes rule 1 cheap: creation is the
cheapest place to notice, and dispatch is the last place that may notice.

## Consequences

- A dispatched worker pays one rebuild plus one install when its path is gone.
  That cost is the point: it is the price of a checkout that is actually there.
- Two board queries become routine maintenance, not incident forensics: the
  non-terminal `workspace_path` set (rule 2) and a `misses: 0` check that every
  such path exists at the ref it claims.
- The existing board-side guards are **unchanged**. Completion cleanup, `hermes
kanban gc` and the worktree pruner already behave correctly; this record does
  not add a hook, a cron job or a timer, because none of them was the cause.
- A `dir`-only lane is the most exposed shape: it has no branch to recover from,
  so it is also the one that fails quietest. Rule 1's third step (detached at
  `origin/main`) is what turns that into an explicit, commented rebuild.
- Nothing about application code, specs, CI workflows or the lockfile changes
  here. This record is a dispatch-time precondition plus an operator rule.

## Alternatives considered

- **Exempt kanban trees from all pruners.** Rejected: the loss was
  out-of-band, so no pruner can be exempted — the exempting rule would sit in
  code that demonstrably did not run. Every candidate reaper was measured and
  each one either already skips these trees or left a log line this event does
  not have (§Evidence). The durable fix is dispatch-time verification (rule 1)
  plus an operator rule (rule 2), not another exemption for a tool that is not
  the culprit.
- **Harden a board-side reaper further.** Rejected for the same measurement:
  kanban completion cleanup and `gc` already defer on a non-terminal card naming
  the path, and the pruner already answers `skip-kanban`. There is no defect to
  fix in them.
- **Let the worker proceed and create the directory inline.** Rejected: an empty
  tree runs a suite that finds nothing and exits `0` (see §Context). The failure
  is silence, so the remedy must be loud — a rebuild plus a comment, never an
  implicit `mkdir`.
- **Make `workspace_path` durable by copying each lane into a board-owned
  directory.** Rejected as out of scope and untested: it changes the workspace
  contract every profile and every card body already speaks, to defend against a
  surface that an operator rule covers at zero migration cost.

## Numbering

Allocated as **`0317`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md),
on the cell the allocator reserved at card creation. The sweep for `0317` on
`origin/main` `53051b91` was empty: no `ADR-0317` file on the trunk, in
`git rev-list --objects --all -- docs/adr`, in any live `.worktrees/*/docs/adr`
tree, on any remote head or in any open PR. This record advances the block cell
to `0318`. No number outside `0300`–`0319` is touched; the OP-136 jobs-lane
range `0849`–`0868` is not read or written.

## Evidence

Measured by `t_f4a1695b` over 2026-11-18T10:20Z–11:06Z. Every candidate reaper
was checked against the window; none of them performed the removal.

| Candidate                          | Measurement                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| kanban completion cleanup          | Its shared-use guard fired correctly: `Deferring workspace cleanup for task t_16239628 … still used by another non-terminal task`. The guard covers `todo`/`ready`/`running`; no run closed in the window.             |
| `hermes kanban gc`                 | Archived rows only, and the same shared-use guard applies.                                                                                                                                                             |
| startup / cron worktree pruner     | `hermes worktree prune --dry-run --json` prints `skip-kanban` for every `t_<hex>` tree and `skip-young` for a fresh probe; the candidate filter skips `^t_[0-9a-f]+$`. Build `4e58c721` is unchanged since 2026-10-22. |
| scratch pruner                     | Runs hourly per profile, 24 h idle cutoff. The last pass was 10:23:42 — before the act — and left no matching log line. The probe was 15 minutes old.                                                                  |
| hermes cron                        | Zero executions in the window.                                                                                                                                                                                         |
| host cron / systemd timers         | Only `x-agent` hourly at minute 0 and `systemd-tmpfiles` at 19:10; neither fits the 10:25–10:46 window.                                                                                                                |
| disk-cleanup plugin                | Never installed for any profile, and its scope is `HERMES_HOME` only.                                                                                                                                                  |
| gateway housekeeping               | Media cache, paste sweep, checkpoint prune, `state.db` maintenance, curator, plugin check, MCP reconcile — no workspace chore.                                                                                         |
| every agent session, every profile | All profile `state.db` tool calls between 10:20 and 10:40 were scanned; none ran `worktree remove`, `prune` or `rm -rf`.                                                                                               |

The fingerprint that is left is a bulk out-of-band reclaim: `.worktrees` went
from 34 entries at 10:25:58 to 8 at 10:46, about 26 registered checkouts gone,
directory and registration together, siblings untouched. One checkout completed
at 10:25:13, its files were missing at 10:25:17 and its `cwd` was deleted by
10:25:40; a re-add of the same path at 10:28:22 raised no "already registered"
error, which is what proves the **registration** went with the directory. Nine
paths were still named by non-terminal cards.

Repair, completed and verified before this record was written — 10 checkouts on
18 rows, each rebuilt on the right ref:

| Path                | Action                                                            | Head       |
| ------------------- | ----------------------------------------------------------------- | ---------- |
| `op136-sweep-drain` | attach lane branch (commits recovered)                            | `65807857` |
| `t_72d33d02`        | attach lane branch (commits recovered)                            | `e8cf60b0` |
| `t_b0b12dc9`        | attach lane branch (commits recovered)                            | `9bda367e` |
| `t_e9340c72`        | attach lane branch (commits recovered)                            | `f98e83db` |
| `op135-spec-split`  | new branch `wt/t_6006f885` from `origin/main`                     | `7e3f642d` |
| `t_5d080821`        | new branch `wt/t_5d080821` from `origin/main`                     | `7e3f642d` |
| `t_7da4009d`        | new branch `wt/t_7da4009d` from `origin/main`                     | `7e3f642d` |
| `t_a99f5cce`        | new branch `wt/t_a99f5cce` from `origin/main`                     | `7e3f642d` |
| `t_bc01c854`        | detached at `origin/main` (`dir`-only lane, would have run empty) | `7e3f642d` |
| `t_ca95e452`        | detached at `origin/main` (`dir`-only lane, would have run empty) | `7e3f642d` |

Verification after the repair: the board query reports `misses: 0` for every
non-terminal `dir`/`worktree` row; `.worktrees/t_16239628` exists and all 8
non-terminal cards that name it resolve; 20 `git worktree list` entries for 18
directories (two cards share a path).
