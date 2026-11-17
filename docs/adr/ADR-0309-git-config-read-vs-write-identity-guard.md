# ADR-0309 — The `git config` read-vs-write identity guard: read with `--get`, set identity only in an explicit local scope

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up (DOCS/ADR) — record the `git config` read-vs-write
  identity guard (`t_cdacca2f`, raised by the orchestrator decision card
  `t_937f0e96`; the defect was reported and repaired by card `t_32fd1711`)
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the
  board-wide `0300`–`0319` range this record draws its number from),
  [ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md) (the sibling
  board-wide rule — a card must not let a wrong fact reach a handoff behind a
  green signal; this defect is the same failure mode one level down, in the
  identity a commit carries)
- **Schema:** n/a · **Contract:** n/a (process only; no application code)

## Context

`git config` is one verb for two operations — **reading** a value and **writing**
one — and it decides which from the shape of its arguments, not from an explicit
subcommand. That is a trap because the two shapes overlap:

- `git config --get <key>` / `git config --list` **read**;
- `git config <key> <value>` **writes** `<key>` with `<value>`;
- `git config <key> --global <value>` writes to the **global** file, but a
  mis-ordered `git config <key> --global` (a _read_ that is missing its value)
  is parsed as a **write** with the literal text `--global` as the value — and it
  writes into the **local** file, because the misplaced flag is consumed as a
  file selector rather than the intended global scope.

On 2026-10-25 the shared checkout `/root/openpic/openpic-webapp` was found with
its **repo-local** config holding the literal string `--global` for both
`user.name` and `user.email`. Every commit a worker authored inside **any**
worktree of that repo — every lane — was therefore attributed
`--global <--global>`. It was caught only because a landing card inspected an
individual commit's author.

The corruption also **re-occurred during its own repair**. The repair card
`t_32fd1711`'s verification step 2 was written as
`git config --global user.name user.email` — two positionals, i.e. a **write**
that sets `user.name = "user.email"` in the **global** file. Running it literally
re-corrupted the global file; the worker noticed the file's mtime matched its own
command, restored `/root/.gitconfig` **byte-exactly** (181 bytes,
credentials-only, both keys unset, `rc=1`), and reported the defective command.
The trap is real enough that the instruction meant to _verify_ the fix caused a
second instance of it.

## Evidence

Reproducible with `git` against `origin/main`, re-verified 2026-10-25.

- **The corruption's signature is a commit author, not a config diff.**
  `git log -1 --format='%an <%ae>' 94f1899` →
  `--global <--global>`; the same for `1011550`. Earlier lane commits `922e8b3`,
  `e55631b`, `28bf4e3` are correctly attributed — the corruption was recent and
  sticky, not a one-commit accident.
- **Trunk is invisible to it, which is why it survived.** GitHub re-authors a
  trunk commit at squash time, so the OP-110 squash `7ab9780` is correctly
  `Ashish Sam T George <77051732+getwithashish@users.noreply.github.com>`. A
  reader checking `main` would see nothing wrong; only branch history, the PR's
  commit list and `git log` attribution carried the wrong author.
- **Mechanism reproduced in a sandbox** (card `t_32fd1711`):
  `git config user.name --global` writes the literal `--global` into the
  **local** config — git consumes `--global` as a file option and the missing
  value defaults to the flag text. The two-positional form
  `git config --global user.name user.email` writes `user.name = "user.email"`
  into the **global** file. Both were observed, the second during the repair.
- **The repaired, healthy state** is two reads with opposite answers:
  repo-local `git config --local --get user.name` → `Ashish Sam T George`
  (`user.email` → `77051732+getwithashish@users.noreply.github.com`), while
  global `git config --global --get user.name` and `--get user.email` are
  **empty** (`rc=1`) — the global file is credentials-only. A throwaway-worktree
  commit then printed the real identity, and the worktree was removed with
  `git worktree remove --force`.
- **AGENTS.md §2.1/§7 make attribution a requirement**, not a nicety: commits use
  Conventional Commits and are attributed to the GitHub account, which the
  `git-commit-authorship` skill encodes (the account's noreply email).
- **CI cannot see any of this.** CI checks out a clean tree; `.git/config` and
  `~/.gitconfig` are never committed and never present, so no workflow can
  assert the identity a worker's commit will carry. The only point that observes
  the resolved identity is **commit time, inside a worktree** — which is why the
  enforcement arm is a hook, not a job.

## Decision

**Read git config and identity only with `--get` (or `--list`); write identity
only with an explicit local scope; never use `--global` on either side of an
identity command as a read; whoever provisions a checkout or worktree sets the
repo-local identity explicitly and validates it before the first commit.**

Four clauses:

1. **Reads are explicit.** Read a value with
   `git config --get <key>` / `git config --get-all <key>` / `git config --list`
   (optionally `--show-origin`). Never `git config <key> --global` — that is a
   write of `--global` into the local file. Never
   `git config --global <key> <value>` as a read — that writes `<value>` into the
   global file.
2. **Writes name their scope.** Set identity only with an explicit local scope:
   `git -C <repo> config --local user.name "…"` /
   `… --local user.email "…"`, or per-invocation
   `git -c user.name="…" -c user.email="…" commit …`. The global file is not a
   valid target for a worker's identity write: it is shared by every repo and by
   non-repo tooling, and it is what the trap corrupts.
3. **Provisioning sets and validates.** Whoever provisions a checkout or worktree
   sets the repo-local identity explicitly (the two `config --local` writes), and
   **validates it before the first commit** — `git config --local --get user.name`
   must equal the real name (a worktree inherits the shared checkout's
   repo-local `.git/config`, so the fix lands once and every lane keeps it).
4. **The enforcement arm is a commit-time assertion.** The board lane
   `OP-110-task-git-identity-guard` carries a validator that **fails the commit**
   when the resolved identity is `--global`, `user.email`, or empty, wired into
   `.husky/pre-commit` so it fires inside **lane worktrees** — the only place the
   resolved identity is observable. CI cannot observe it (clause 3's provisioning
   validation is discipline a hurried worker can skip); the hook is the assertion
   that does not depend on anyone remembering. It fits existing infrastructure:
   the repo already runs husky `^9.1.7` with `.husky/pre-commit` →
   `pnpm lint-staged`.

## Consequences

- A worker no longer has to remember which argument order writes and which reads;
  the rule is a shape, not a mnemonic: **an identity read carries `--get`, an
  identity write carries `--local` (or `-c`)**.
- The failure is silent, sticky and board-wide, so the guard must be too. A
  single bad invocation on the shared checkout corrupts **every lane's** branch
  history, survives unnoticed because trunk re-authors squashes, and re-infects
  each new worktree until someone inspects an individual commit — the exact
  properties that make a per-commit assertion worth a hook.
- **A read that is really a write is worse than a wrong value**: it silently
  mutates the file it was supposed to inspect, so the checking tool becomes the
  corrupting tool (the repair card's step 2). Clause 1 forbids the ambiguous
  shape entirely rather than documenting the correct one.
- The corruption is not repair-able by history rewrite (AGENTS.md forbids it) and
  the wrong authors remain on the affected branch commits; the durable outcome is
  the guard, not a cleanup.
- The rule is board-wide, not lane-local: identity lives in the shared
  checkout's repo-local config, which every worktree inherits, so no single lane
  can own it.

## Alternatives

- **Document the correct command shape only, with no guard.** Rejected: that is
  what the board already had — the `git-commit-authorship` skill and the repair
  card both stated the right command, and the trap still fired twice (once to
  corrupt, once during the repair). The failure mode is a mis-ordered argument,
  which discipline alone does not reliably stop.
- **Add a CI check for the identity.** Rejected: CI has no access to the worker's
  `.git/config` or `~/.gitconfig` (they are not committed), and a fresh CI
  checkout resolves no identity at all, so a CI check is vacuous. The commit-time
  hook is the only vantage point (clause 4).
- **Forbid `user.name`/`user.email` in the global file outright.** Rejected:
  out of scope and fragile — the environment's global file is
  credentials-only today by choice, but a guard that polices a file outside the
  repository cannot be enforced by a repository hook, and the guard's job is the
  identity a commit carries, not the rest of the user's git config.
- **Rewrite the corrupted branch history to fix the authors.** Rejected:
  AGENTS.md §2.1/§7 forbids history rewrite for a config defect, the affected
  lane is already merged (and trunk squashes re-author correctly), and the wrong
  authors are on rebase-free feature commits whose only remaining trace is the
  PR's commit list.

## ADR number allocation

`0300`–`0307` are consumed on `main` (`0304` by
[ADR-0304](ADR-0304-stale-draft-pr-reconciliation.md), PR #259; `0305` by
[ADR-0305](ADR-0305-ci-evidence-conflicting-pr-suppression.md), PR #260; `0306` by
[ADR-0306](ADR-0306-op101-stale-branch-deletion.md); `0307` by
[ADR-0307](ADR-0307-unmerged-pr-blocks-card-completion.md)), and `0308` is now
consumed too — [ADR-0308](ADR-0308-one-owner-per-branch-landing.md) landed as PR
#345 (`9cd36f5`), the number `t_58139e6e` had reserved in-flight at this card's
creation. So this card consumes the orchestrator-reserved `0309`, and the
board-wide `Next free` cell advances to `0310` (`max(consumed)+1`, with
`0300`–`0309` consumed). No number outside `0300`–`0319` is touched.
