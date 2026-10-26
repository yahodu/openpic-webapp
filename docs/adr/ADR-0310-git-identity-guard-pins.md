# ADR-0310 — OP-110 follow-up TEST: the commit-time git identity guard (validator contract + the worktree hook-firing fact)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up TEST (`t_54545281`) · **Branch:** `OP-110-task-git-identity-guard` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_54545281`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0310`
- **Relates to:** ADR-0309 (the durable board rule: read git config only with `--get`, set identity only with an explicit local scope — minted by the docs card `t_cdacca2f`; unmerged at this head, so referenced by number only), [ADR-0308](ADR-0308-one-owner-per-branch-landing.md), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. This record pins **guard 2** of the routing card `t_937f0e96` (the repo-side commit-time assertion) and establishes the wiring fact it depends on. The behavioural rule itself is ADR-0309, not re-decided here.
- **Gated GREEN:** `t_3ad88600` (implements the validator and its wiring) → `t_5f824ce6` (REVIEW/LAND). This RED card delivers **test files + this ADR + the README ledger cells only**.

## Context

`t_32fd1711` repaired a corruption in the shared checkout
`/root/openpic/openpic-webapp`: its repo-local `user.name`/`user.email` were the
literal `--global`, so every worker commit **in any worktree** was authored
`--global <--global>`. Two mis-ordered `git config` invocations cause it:

- `git config user.name --global` — a _read_ attempt — **writes**
  `user.name = "--global"` into the **local** file (git consumes `--global` as a
  file-scope option and the missing value defaults to the flag text);
- `git config --global user.name user.email` — two positionals — is a _write_
  that sets the **global** `user.name = "user.email"`.

The corruption is invisible on trunk (GitHub re-authors squash commits), silent
(no command errors), and inherited by every worktree of the shared repo — so the
only enforcement point that catches it independently of worker discipline is a
**commit-time guard that fires inside lane worktrees**. CI cannot: CI checks out
clean and `.git/config` is not committed.

## Decision §1 — the validator contract (pinned)

A pure module, no I/O, no `process.exit`:

```
module   scripts/git/identity-guard.ts        (sibling of scripts/check-env.ts)
exports  interface GitIdentity { readonly name: string | undefined;
                                 readonly email: string | undefined }
         isValidGitIdentity(identity: GitIdentity): boolean   — pure predicate
         assertGitIdentity(identity: GitIdentity): void       — throws on invalid
```

`GitIdentity` is the **resolved pair** exactly as `git config --get user.name` /
`git config --get user.email` report it: a string, or `undefined` when the key is
unset (the command exits non-zero with no output).

**Failure surface: `assertGitIdentity` throws.** It returns `void` on a valid
identity and throws an `Error` on an invalid one; it never calls `process.exit`.
Translating the throw into an exit code and a stderr line is the CLI wrapper's job
(the GREEN's wiring), so the pure contract stays unit-testable and reusable.

**Invalid** when either field:

1. is `undefined`, or contains no non-whitespace character (git returned nothing
   usable);
2. **trims** to `--global`; or
3. **trims** to `user.email`.

**Valid** otherwise. The guard deliberately does **not** grow into an RFC-5322
email validator — that would refuse legitimate identities and is not what the
card asks for.

**Message contract** (the pinned, observable part of the throw): the `message`
names the offending config key(s) — `user.name` and/or `user.email` — and carries
the repair hint `git config --local`, so the hook prints an actionable line. When
both fields are garbage, one message names both keys.

The **trim rule** (§Decision §1.2/§1.3) is this record's own decision, and it is
the only rule here that the card did not state literally: `--global ` and
`user.email ` are the same defect as their unpadded forms, and treating a
surrounding space as "a different, valid identity" would let the corruption
through. It is pinned explicitly (two rows of 12) so the GREEN cannot miss it.

## Decision §2 — the wiring fact (empirical)

**`core.hooksPath` resolves per worktree and a fresh worktree has no hook script.**

Measured on the shared repo (`/root/openpic/openpic-webapp`, `origin/main`
`571bfde`, then `9cd36f5`):

| Fact                                                                  | Command                                         | Result                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| hooks path set in the **shared** config                               | `git config --show-origin --get core.hooksPath` | `file:.git/config` → `.husky/_`                                                    |
| worktrees inherit it (no per-worktree cfg)                            | `git config --get extensions.worktreeConfig`    | unset (rc 1)                                                                       |
| it is **relative**, so git resolves it against **each worktree root** | same key read from a worktree                   | `.husky/_`                                                                         |
| a fresh worktree carries the **tracked** hook body                    | `ls <wt>/.husky` at `git worktree add`          | `pre-commit` present                                                               |
| …but **not** husky's generated shim dir                               | `ls <wt>/.husky/_`                              | **absent** (`.husky/_/.gitignore` is `*`, so a new worktree never materialises it) |

**Probe A — fresh worktree, commit: the hook does NOT fire.**

```
git -C /root/openpic/openpic-webapp worktree add --detach <scratch>/probe-wt origin/main
cd <scratch>/probe-wt && echo probe > PROBE_FILE.txt && git add PROBE_FILE.txt
git commit -m "probe: does the hook fire"
  → [detached HEAD d5c0714] probe: does the hook fire
      1 file changed, 1 insertion(+)
    commit_rc=0
```

Exit `0`, and **not one line of `lint-staged` output** — `pnpm lint-staged` never
ran. A hook that does not fire cannot guard.

**Probe B — same worktree after `pnpm install`: the hook fires.**

The root `package.json` runs `prepare: husky`, so a worktree that has installed
its dependencies gets its own `.husky/_` and the hook starts working:

```
cd <scratch>/probe-wt && CI=true pnpm install --frozen-lockfile --offline
  → . prepare$ husky   /   . prepare: Done
ls <scratch>/probe-wt/.husky/_        → applypatch-msg commit-msg h … pre-commit …
git commit -m "probe: hook after pnpm install"
  → … . prepare$ husky / . prepare: Done
    → No staged files match any configured task.        ← the hook ran (lint-staged)
    [detached HEAD 151c66a] probe: hook after pnpm install
```

**Probe C — the mechanism the GREEN card suggests actually works in a _fresh_
worktree.** An **absolute** `core.hooksPath` pointing at the main checkout's
husky dir makes the hook fire even before any install:

```
git -C /root/openpic/openpic-webapp worktree add --detach <scratch>/probe-wt2 origin/main
# per-command config injection, so the shared .git/config is NOT modified:
cd <scratch>/probe-wt2 && echo hook2 > P2.txt && git add P2.txt
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath \
GIT_CONFIG_VALUE_0=/root/openpic/openpic-webapp/.husky/_ \
  git commit -m "probe: absolute hooksPath in a fresh worktree"
  → … → No staged files match any configured task.     ← the hook ran without any install
    [detached HEAD c738daf] probe: absolute hooksPath in a fresh worktree
git -C /root/openpic/openpic-webapp config --get core.hooksPath   → .husky/_   (unchanged)
```

**Conclusion for the GREEN.** Adding the guard to `.husky/pre-commit` is enough
for the _normal_ lane state (a worktree that has run `pnpm install`), but it is a
**silent no-op in a worktree that has not** — which is exactly the state in which
a worker first commits. To be unconditional, the hook must be resolved from a
location that exists in every worktree: pin `core.hooksPath` to an **absolute**
path into the main checkout's `.husky/_` in the shared repo-local config (Probe C
proves it fires), or an equivalent that provably runs on a worktree commit. The
GREEN owns that choice and must record its own probe for both the corrupted and
the healthy identity. All three probe worktrees were removed (`git worktree
remove --force` + `git worktree prune`); the main checkout's `.git/config` was
never modified.

## The pin (RED)

`apps/web/src/test/unit/git-identity-guard.test.ts` — 29 assertions over the pure
contract, importing the module by its relative path
(`../../../../../scripts/git/identity-guard`, the `scripts/`-from-`apps/web/src/test`
convention) because it must live in the `unit` Vitest project to run at all:

- **3 accept rows** — a normal name + well-formed email; a unicode name + a
  plus-tagged email; a single-word name + a plain email — each `true`, and one
  explicit "does not throw";
- **12 reject rows** (`it.each`) — `--global` and `user.email` as `user.name` and
  as `user.email`; empty as each; whitespace-only as each; **unset** as each; and
  the two padded forms (`" --global "`, `"user.email "`) — each `false` through
  the predicate **and** `toThrow` naming the offending key plus the repair hint;
- **1 both-garbage row** — one message naming `user.name`, `user.email` and
  `git config --local`.

The spec is RED at the head as a **module-not-found** failure (the honest red for
a new module — the module is the GREEN's to create), and was proved
**type-correct** first: with a throwaway stub at the exact pinned path, both
`tsc` projects exited `0` and all 29 assertions failed at assertion level
(`AssertionError: expected 'stub' to contain 'user.name'`), so nothing in the
spec fails for an incidental reason. The stub was deleted before handoff
(`git status` shows only the new spec).

## Evidence at the RED head

- `npx vitest run --project unit apps/web/src/test/unit/git-identity-guard.test.ts`
  → `Test Files 1 failed (1)` · `Tests no tests`, with
  `Error: Cannot find module '../../../../../scripts/git/identity-guard' imported from …/git-identity-guard.test.ts`.
- Stub probe (deleted): `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
  `npx tsc -p tsconfig.json --noEmit` exit `0`; vitest `Tests 29 failed (29)`.
- `npx eslint apps/web/src/test/unit/git-identity-guard.test.ts` → exit `0`,
  0 problems; `npx prettier --check` clean.
- **Test files + this ADR + `docs/adr/README.md` only** — no file under
  `scripts/`, `.husky/` or `package.json` is touched, and no existing test,
  production, mock, fixture or factory file is modified.

## Open items (for the GREEN)

- The **wire format of the thrown message** is pinned only by tokens (the
  offending key, the repair hint). Exact prose is the GREEN's.
- The **CLI wrapper** — its path, its exit code, its `package.json` script name —
  is the GREEN's, as is the `core.hooksPath` mechanism (Probe C is the proven
  option).
- The guard's decision on a **non-empty but malformed email** is deliberately
  unpinned: this spec neither requires nor forbids a syntax check beyond the three
  listed defect classes, so a GREEN that adds one is not contradicted unless it
  starts refusing the three accepted rows.

## ADR number allocation

The board-wide / process range is `0300`–`0319`. `0300`–`0307` are consumed on
`main`; `0308` by [ADR-0308](ADR-0308-one-owner-per-branch-landing.md) (PR #345,
`9cd36f5`) and `0309` by the docs card `t_cdacca2f` (in flight on
`OP-110-task-git-identity-guard-adr`) — both count as taken under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7. This record takes
**`0310`**, the number the orchestrator routed for this card (`t_937f0e96`,
`board_wide_cell_after: 0310`), and advances the README `Next free` cell from
`0309` to `0311`. `0309`'s in-flight branch advances the same cell to `0310`+ in
its own hunk; the landing card must union-resolve the cell to `0311` and must not
let a sibling hunk rewind it. No number outside `0300`–`0319` is touched.

## GREEN realization (card `t_3ad88600`)

The pins above are unchanged and the spec is untouched. This section records what
the GREEN built and **which wiring it chose** (`Consumes: none` — no new ADR row
is minted here; `0309` remains the docs lane's).

**Files.** `scripts/git/identity-guard.ts` (the pure validator, exactly the
pinned contract, import-safe); `scripts/git/check-identity.ts` (the CLI wrapper:
resolves `user.name`/`user.email` with `git config --get`, calls
`assertGitIdentity`, writes the message to stderr and exits `1` — the wrapper,
not the validator, owns the exit code); `scripts/git/pin-hooks-path.mjs` (the
wiring assertion, run from `prepare`); `.husky/pre-commit` (runs the wrapper
first, then `lint-staged`); `package.json` (`check:git-identity`, `prepare`).

**The wiring decision — `core.hooksPath` names the tracked `.husky`, not
husky's generated `.husky/_`.** Both settings are one value in the _shared_
repo-local config, and both are worked out by the same trigger (`prepare`), so
the choice is not about durability. It is about _where the hook body comes from_:

- a relative `core.hooksPath` is resolved against **each worktree root**, and a
  fresh `git worktree add` worktree has no `.husky/_` (its contents are
  `.gitignore`d `*` and only an install generates them), so husky's default is a
  silent no-op exactly where the corruption is inherited (Probe A);
- the card's suggested **absolute** `core.hooksPath` → the main checkout's
  `.husky/_` (Probe C) does fire, but husky's `_/h` resolves the hook body two
  levels up from _itself_, so the body would always be the **main checkout's**
  `.husky/pre-commit`. A lane could not run its own hook change until `main`
  caught up — including this very card, whose guard would then be unreproducible
  in a probe — and the value is a machine-specific absolute path that no diff can
  verify;
- pinning to the **tracked `.husky` directory** keeps the relative, per-worktree
  resolution but points it at a directory that _does_ exist in every worktree, so
  the hook body is always **the worktree's own tracked file**, it fires with no
  install step, and the setting is the stable string `.husky` that anyone
  reproduces by running `pnpm install`.

`scripts/git/pin-hooks-path.mjs` re-asserts the pin after `husky` in `prepare`
(husky's own step resets the key to `.husky/_` on every install, so the
assertion has to follow it), and is a no-op outside a git work tree. `husky`
itself is untouched and still runs, so `.husky/_` keeps being generated; the
14 shims it writes were already behaviourally inert for the 13 hook names that
have no `.husky/<name>` body — the `h` script exits `0` when the body is absent.

The hook's `lint-staged` step is guarded by `[ -x node_modules/.bin/lint-staged ]`
because the hook now runs _before_ an install in a fresh worktree: skipping it
there reproduces the previous behaviour exactly (no hook ran at all) instead of
triggering an install mid-commit. In an installed worktree the step runs as
before.

**Recorded probe (both cases), at head `8950c2c`.** A throwaway worktree of the
same commit, outside the checkout, never installed
(`git worktree add --detach $SCRATCH/probe-guard 8950c2c`; `ls -d node_modules
.husky/_` → both absent; `git config --get core.hooksPath` → `.husky`). The
corruption is injected per command with `GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, so
the shared `.git/config` is never modified:

```
# PROBE 1 — corrupt identity: the commit is REFUSED (no commit object created)
$ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=--global \
    git commit -m "probe: corrupt identity must be refused"
The shared repo-local git identity is corrupt: user.name must be a real name and email
(git wrote a flag or a config key into the value). Repair it with
`git config --local user.name "<name>"` and `git config --local user.email "<email>"`.
commit_rc=1

# PROBE 1b — corrupt email: REFUSED
$ GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0=user.email git commit -m …
The shared repo-local git identity is corrupt: user.email must be a real name and email (…)
commit_rc=1

# PROBE 2 — healthy identity: the commit SUCCEEDS (lint-staged skipped: no deps)
$ git commit -m "probe: healthy identity must succeed"
[detached HEAD 350c1f4] probe: healthy identity must succeed
 1 file changed, 1 insertion(+)
commit_rc=0

# NEGATIVE CONTROL — same fresh worktree with husky's default relative `.husky/_`:
$ GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.husky/_ \
  GIT_CONFIG_KEY_1=user.name GIT_CONFIG_VALUE_1=--global git commit -m …
[detached HEAD 7346119] probe: corrupt identity with husky default hooksPath
commit_rc=0        # no hook fired — the corruption sails through; the pin is load-bearing
```

The probe worktree was removed (`git worktree remove --force` + `git worktree
prune`). The wiring itself is live in the shared repo-local config
(`core.hooksPath` = `.husky`) and re-asserted by `prepare`; the commit that
carries this GREEN was made through it.

**Residual, unchanged from before.** A brand-new clone has no `core.hooksPath`
until its first `pnpm install` (the same window husky itself has), and a manual
`npx husky` outside `prepare` resets the key until the next install.

## Review sign-off — 2026-10-25 (card `t_5f824ce6`, round 1 · artifact + execution lens)

Append-only: nothing above is retracted or edited. This section records the
REVIEW/LAND of [PR #348](https://github.com/yahodu/openpic-webapp/pull/348) by the
card `t_5f824ce6`, and it consumes **no** ADR number — the board-wide `Next free`
cell and `docs/adr/README.md` are unchanged.

**Heads.** Reviewed head `a545ebe` (PR #348, branch `OP-110-task-git-identity-guard`).
Post-merge head `2019aa2`, after absorbing `origin/main` `10358d5`. Squash-merge
`2f5a0806` — `git merge-base --is-ancestor 2f5a0806 origin/main` exits `0`, and
local `main` == `origin/main` == `2f5a0806` at land time.

**Guard-firing evidence (the point of the change).** Reproduced independently in a
throwaway worktree of the reviewed SHA that was never installed (`node_modules`
ABSENT, `.husky/_` ABSENT, `core.hooksPath` = `.husky`): a corrupt
`user.name = --global` → commit **rc=1** with the guard's stderr message; a corrupt
`user.email = user.email` → **rc=1**; a healthy identity → **rc=0**; and a
**negative control** with husky's default `core.hooksPath = .husky/_` and a corrupt
name → **rc=0** (no hook fires, so the `.husky` pin is load-bearing). Re-run at the
merged head `2019aa2` and again on the merged trunk `2f5a0806`: same results.

**Validator contract.** RED reproduced (`Cannot find module
'../../../../../scripts/git/identity-guard'` with the module hidden) → GREEN
`29 passed (29)`. An independent node probe over 12 classes (valid; `--global` /
`user.email` as either field; empty; whitespace-only; unset; padded `" --global "`)
matched the contract with `probe_failures=0`; the CLI exits `0` on a healthy
identity and `1` with the message on stderr for either corrupt field, printing the
config-key **names** only.

**Gates at the head.** ESLint 0 problems, `prettier --check` clean, `tsc` on both
projects exits `0`, full unit **115 files / 2005 passed | 3 skipped**, the
`adr-numbering` guard **29/29** with no duplicate `ADR-NNNN`.

**Ledger conflict (integration, not a renumber).** `origin/main` landed `ADR-0309`
(PR [#353](https://github.com/yahodu/openpic-webapp/pull/353), `10358d5`) mid-review,
so `docs/adr/README.md` conflicted at three places. The numbers are distinct and the
guard is green on the merged tree, so it was resolved as a union: cell `0311`
(highest), rows `0309` + `0310` ascending, the `0309` prose taken from main's landed
wording with "Next free in the block is `0311`". No deliverable file was edited by
the reviewer.

**CI evidence at `2019aa2`.** `CI` (pull_request) success, `PR Checks`
(pull_request) success, `CI Evidence Guard` (push) success, `CodeQL PR #348`
success — all with `head_sha = 2019aa280c208ccd21c9d55ccc26b922f573c057`.

**Findings routed (not fixed here).**

- **F1 (Low).** `scripts/git/pin-hooks-path.mjs` swallows a failed `core.hooksPath`
  pin in a bare `catch {}`, so a checkout where the pin cannot be written silently
  loses the guard → TEST card `t_60e20c44` → gated GREEN card `t_de160aea`.
- **F2 (Info).** This record's own "ADR-0309 … unmerged at this head" wording is
  head-scoped and predates ADR-0309 landing. Recorded; no card.
- **F3 (Info).** The guard is bypassable with `git commit --no-verify` and does not
  cover server-side commits. Inherent to a hook and covered by the durable rule in
  ADR-0309. Recorded; no card.

No ADR number is asserted for the still-unmerged follow-ups: they are cited by card
id (`t_60e20c44`, `t_de160aea`) and PR number only.

## CI fix sign-off — 2026-10-26 (card `t_ee30e3b7`)

Append-only: nothing above is retracted or edited. This section records the
FIX/LAND of [PR #362](https://github.com/yahodu/openpic-webapp/pull/362) — the
card that restored the `Version Bump` workflow — and it consumes **no** ADR
number (no row in `docs/adr/README.md` is touched).

**The failure, as designed.** The `Version Bump` workflow
(`.github/workflows/version_bump.yml`) failed on every `main` push from
`2f5a0806` (PR #348, 2026-10-25T17:51Z) onwards, four runs in a row, all at
`@semantic-release/git`'s `git commit -F -` with the guard's refusal message.
This is the guard **working as designed**: the pinned pre-commit hook fires on
every commit the hook path can observe, and on a GitHub runner it observed a
corrupt identity (runner images carry a non-empty but unusable
`user.name`/`user.email`; `git commit` accepts it, the guard refuses it). CI
cannot see the workers' identity (ADR-0309 §Evidence), but the runner's own
identity is exactly the corruption class the guard rejects.

**The fix.** The workflow now provisions a repo-local identity — ADR-0309
clause 3, applied to the machine that owns the release commit — and validates
it with the guard itself before `semantic-release` runs:

```yaml
- name: Configure release git identity
  run: |
    git config --local user.name "semantic-release-bot"
    git config --local user.email "semantic-release-bot@users.noreply.github.com"
    pnpm check:git-identity
```

Writes name their scope (`--local`); the check is a `--get` read; no env
sniffing was added to `check-identity.ts`. A GitHub runner has no identity in
any scope at checkout, so the old job also died to git's own
`Author identity unknown` before the guard could fire; provisioning makes both
git and the guard agree, deterministically, on every runner.

**Probe (local, `git 2.4x` on the dev box).** Fresh clone of `1f60a95` in a
scratch dir — no identity in any scope, mirroring the runner: git's own commit
refuses; injecting the corrupt pair (`--global` / `user.email`) via
`GIT_CONFIG_COUNT` reproduces the exact CI stderr and `rc=1`; after the two
`git config --local` writes, `pnpm check:git-identity` exits `0` and the same
`chore(release): 1.41.0 [skip ci]` commit succeeds, authored
`semantic-release-bot <semantic-release-bot@users.noreply.github.com>`. The
mechanism (`pnpm install` → `prepare` → `husky` + `pin-hooks-path.mjs` →
`core.hooksPath = .husky` → the hook in the runner's checkout) matches the
failed runs' logs, where the guard's message is the last line before the plugin
reports exit code 1.

## Round-1 review sign-off — 2026-10-26 (card `t_ee30e3b7`)

Append-only: nothing above is retracted or edited. This section records the
round-1 REVIEW/LAND of [PR #362](https://github.com/yahodu/openpic-webapp/pull/362)
by the card `t_ee30e3b7` (the CI fix whose sign-off is the section immediately
above), and it consumes **no** ADR number — the board-wide `Next free` cell and
`docs/adr/README.md` are unchanged.

**Verdict / landing.** PR #362 reviewed (artifactId, round 1) and
squash-merged; merge commit `f0d79d42`; local and remote trunk synced at
`68cab8d` (release commit included).

**Independent verification performed by the reviewer (not the implementer's):**

- Guard refusal reproduced in a scratch `git init` with no identity in any
  scope — exact CI stderr: `The shared repo-local git identity is corrupt:
user.name and user.email …` — and with the corrupt pair
  (`user.name=--global`, `user.email=user.email` via `GIT_CONFIG_COUNT`) —
  both rc=1.
- After the PR's two `git config --local` writes: `pnpm check:git-identity`
  rc=0 and the identical `chore(release): 1.41.0 [skip ci]` commit succeeds.
- Env bypass attempt (`GIT_CONFIG_COUNT` on top of a valid local identity)
  still refused — the guard never reads `process.env`; not weakenable, as
  designed.
- Guard suite at head `c82d005`: `git-identity-guard.test.ts` +
  `adr-numbering.test.ts` = 58/58 (29 identity + 29 ADR-numbering); suite
  untouched by the PR.
- Prettier clean on both changed files; PR scope exactly 2 files (+60/−0);
  `git merge-tree --write-tree origin/main <head>` exit 0 (MERGEABLE —
  `BLOCKED` was only the ruleset review gate).

**End-to-end proof (post-merge, the real gate).** Version Bump run
`40274211839` on merge `f0d79d42` → **success**; `chore(release): 1.41.0
[skip ci]` (`68cab8d`) on `main`; tag `v1.41.0`; GitHub release published by
`yahodu-version-bump-bot[bot]` covering the whole backlog since `v1.40.1`
(feat ×2, fix ×3). Release commit scope = CHANGELOG.md + package.json only.
Merged-trunk `ci`/`unit_test`/`test_coverage`/`lint`/`secret-scan` green on
`f0d79d4`.

**Correction to the parent card's figures.** The release run's analyzed range
included `fix(git) 3950c22 (#356)` and the PR itself, so the release notes
list five commits, not four — still v1.41.0 (minor). Nothing in §D\* of the
previous sign-off is retracted.

## Accuracy note — 2026-10-26 (card `t_19afcb0d`)

Append-only: nothing above is retracted or edited. This section records the
Low finding routed from the round-1 review of [PR #362](https://github.com/yahodu/openpic-webapp/pull/362)
(card `t_ee30e3b7`): the CI-fix sign-off above states two contradictory
identity mechanisms for the runner.

**The contradiction.** (a) "runner images carry a non-empty but unusable
`user.name`/`user.email`; `git commit` accepts it, the guard refuses it", vs
(b) "A GitHub runner has no identity in any scope at checkout, so the old job
also died to git's own `Author identity unknown` before the guard could fire".

**Reconciliation (gold evidence favours (a)).** The failed runs' last line is
the **guard's** message, and git's `Author identity unknown` aborts _before_
any pre-commit hook runs — so a hook firing implies git had already resolved
an identity it accepted. Mechanism (a) is kept; claim (b) is dropped. The
YAML comment on the new step ("no git identity in any config scope") is the
same oversimplification — this note is the reconciliation, and no code PR was
opened for it (a one-line alignment may land with any future touch of
`.github/workflows/version_bump.yml`).

**Factual signature.** The landed release commit is authored
`semantic-release-bot <semantic-release-bot@martynus.net>` —
`@semantic-release/git`'s **plugin-default** identity (no `gitAuthor` in
`.releaserc.json`), which it injects via env; the workflow-configured
`semantic-release-bot@users.noreply.github.com` therefore never appears as
the commit author. The configured local identity exists to satisfy the
guard's `git config --get` read (guard + git agree, deterministically). If
exact noreply authorship ever matters, set `gitAuthor` in `.releaserc.json`
— out of scope here, recorded as a note.
