# ADR-0315 — govern the `picomatch` ReDoS advisory (`GHSA-fc5q-39xc-vjpf`) with one `audit.ignore` entry

- **Status:** Accepted · **Date:** 2026-11-17
- **Card:** OP-135 DEPS (`t_b0e2c0dd`, High) · **Branch:** `OP-135-task-picomatch-advisory` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_b0e2c0dd`
- **Lane:** board-wide / process (orchestrator), reserved range `0300`–`0319` · **Consumes:** `0315`
- **Relates to:** [ADR-0301](ADR-0301-ci-audit-dev-vs-prod-scope.md) (the `audit` / `audit-dev` split and the rule this entry follows: extending `audit.ignore` requires a dedicated ADR per GHSA), [ADR-0313](ADR-0313-audit-dev-check-run-non-failing.md) (the `audit-dev` check-run stays `success` while its advisory report stays in the job log), [ADR-0118](ADR-0118-op101-ci-dependency-audit-remediation.md) (the first audit remediation; the `1 high (1 ignored)` report shape), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (number allocation)
- **Schema:** n/a · **Contract:** n/a (dependency-policy configuration only; no application code)

## Context

The blocking `audit` job in `.github/workflows/ci.yml` runs
`pnpm audit --prod --audit-level=moderate` with no `continue-on-error`. On
2026-11-17 the trunk is red on **`GHSA-fc5q-39xc-vjpf`** (CVE-2026-112366,
high — `picomatch` ReDoS through single-branch repeated extglobs), reached from
a **production** dependency of `@openpic/web`:

```
apps__web > better-auth@1.7.7 > vitest@5.0.3 > @vitest/mocker@5.0.3
          > vite@8.3.4 > picomatch@4.0.7            (9 paths; pnpm why picomatch -r)
```

`better-auth` declares `vitest` as an optional peer, and pnpm resolves it from
the workspace's own `vitest` install, so a test-toolchain package sits in the
`--prod` graph and reddens every PR and the trunk.

**The advisory cannot be satisfied.** Measured at this head:

| Probe                                             | Result                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| `registry.npmjs.org/picomatch` `dist-tags.latest` | `4.0.7` (`4.0.8` absent from `versions`)           |
| `…/picomatch-4.0.8.tgz`                           | HTTP `404` (`4.0.7` → `200`)                       |
| advisory `first_patched_version`                  | `null`                                             |
| npm bulk advisory API                             | `vulnerable_versions: "<=4.0.7"`, no patched range |
| `micromatch/picomatch` releases                   | highest `4.0.7`; fix PRs #237/#246 open, unmerged  |

The card's first prescription — a `pnpm.overrides` entry resolving
`picomatch` to `>=4.0.8` — fails at install with
`ERR_PNPM_NO_MATCHING_VERSION`. Bumping the chain is closed too: `vite@8.3.8`
and `vitest@5.1.0` each declare `picomatch: ^4.0.7`, and every `better-auth`
release (including `1.8.0-beta.10`) keeps the same optional `vitest` peer. Every
published version of the chain keeps `picomatch` at `4.0.7`, which the advisory
covers (`last_affected: 4.0.7`).

Five measured peer-pruning attempts also leave the edge in place
(`autoInstallPeers: false`; removing `apps/web`'s redundant `vitest` devDependency;
`resolvePeersFromWorkspaceRoot: false`; `dedupePeerDependents: false`; the same
with `--force`). The suite cannot run without `vitest` installed, and pnpm
always resolves the optional peer from that install. A `pnpm patch` or a vendored
fork changes no `name@version` pair, so it changes nothing the advisory keys on.

## Decision

Add **one** `audit.ignore` entry, with its removal trigger beside it, to the
`audit:` block of `pnpm-workspace.yaml` (the same file and block that carry the
existing withdrawn `braces` entry):

```yaml
audit:
  level: moderate
  ignore:
    - GHSA-vfj7-8cjw-p6xm
    # GHSA-fc5q-39xc-vjpf — picomatch does ReDoS on single-branch repeated
    # extglobs; vulnerable <=4.0.7 and no patched release exists (registry
    # latest is 4.0.7, the 4.0.8 tarball is 404, the advisory's
    # first_patched_version is null). Delete this entry when
    # picomatch@>=4.0.8 publishes; re-run `pnpm audit --prod` before deleting
    # and after. See ADR-0315.
    - GHSA-fc5q-39xc-vjpf
```

**Removal trigger, verbatim:** "Delete this entry when `picomatch@>=4.0.8`
publishes; re-run `pnpm audit --prod` before deleting and after."

Scope, stated explicitly:

- This ignores **one** GHSA, in **both** audit jobs. Per ADR-0301 an `ignore`
  entry suppresses the advisory from `audit` and `audit-dev` at once; the
  `audit`, `audit-dev` job definitions, `audit.level: moderate`, and the
  blocking (non-`continue-on-error`) property of `audit` are **unchanged**.
- **This is the first live, unpatched exception on this list.** The other entry,
  `GHSA-vfj7-8cjw-p6xm`, is a **withdrawn** advisory (withdrawn 2026-10-23)
  against `braces`, and it is left exactly as found. No ADR ever recorded adding
  it, so it is not a precedent for the governance this record sets.
- No dependency, override, lockfile, workflow or application file changes:
  `pnpm-lock.yaml` is byte-identical (`sha256 8ed4cd30…` before and after) and
  `pnpm why picomatch -r` still resolves `4.0.7` and `2.3.2` on the same paths.

## Consequences

- The blocking production-supply-chain gate returns to green with the exception
  on the record instead of a permanently red trunk that every PR merges past with
  `--admin`.
- The advisory stays **reported**: `pnpm audit --prod` prints
  `1 vulnerabilities found / Severity: 1 high (1 ignored)` and still exits `0`,
  and `pnpm audit --dev` keeps all 16 dev-lane entries (`7 moderate | 9 high
(1 ignored)`), so nothing is hidden from the job log. No second advisory is
  suppressed and no second `ignore` line is added.
- The risk accepted is bounded and stated: `picomatch@4.0.7` remains in the
  resolved graph, and ReDoS needs an attacker-controlled glob pattern. This
  instance is `better-auth`'s optional toolchain peer and no shipped code path
  passes caller-supplied patterns to it.
- The exception can outlive its justification if left unattended, which is why
  the removal trigger is both in this record and in a comment next to the entry.
  A follow-up card (`t_f4a45d1c`) re-runs the gate across the open PRs and the
  trunk.

## Alternatives considered

- **`pnpm.overrides` / chain bump (the card's first prescription).** Impossible:
  no `picomatch@4.0.8` exists, so the install refuses
  (`ERR_PNPM_NO_MATCHING_VERSION`) and no published version of the chain
  re-resolves the range above `4.0.7`.
- **Leave the gate red (status quo).** Rejected: `main`'s `audit` check has been
  `failure` since the advisory published, every PR carries that red, and the
  signal a blocking gate exists to give is lost.
- **Downgrade the gate (`--audit-level=high`, `|| true`, `continue-on-error`,
  `.pnpmrc` allowlist).** Rejected by ADR-0301/ADR-0313 and the card: it would
  drop every future moderate advisory in the shipped tree, not this one.
- **Suppress the advisory by removing the `better-auth` → `vitest` peer edge.**
  Measured to be impossible without removing `vitest` from the workspace
  (five attempts above).
- **Patch or vendor a fixed `picomatch`.** No fix release exists, and the
  advisory keys on `name@version`, not on the code.

## Numbering

Allocated as **`0315`** from the allocator-owned **board-wide / process** range
(`0300`–`0319`) under [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md).
The `Next free` cell read `0315` on `origin/main` `f3bb846a` immediately before
this record was written, the sweep for `0315` was empty (no `ADR-0315*` file on
the trunk, in any `.worktrees/*/docs/adr`, in `git rev-list --objects --all --
docs/adr` or on an open PR head), and this record advances the cell to `0316`.
No number outside `0300`–`0319` is touched.

## Evidence (measured, this head)

- RED before: `pnpm audit --prod --audit-level=moderate` → rc `1`,
  `1 vulnerabilities found / Severity: 1 high`, `GHSA-fc5q-39xc-vjpf`,
  `Patched versions >=4.0.8`, 9 paths all via `apps__web > better-auth > vitest`.
- GREEN after: same command → rc `0`,
  `1 vulnerabilities found / Severity: 1 high (1 ignored)`.
- Dev lane unchanged: `pnpm audit --dev --audit-level=moderate` → rc `1`,
  `16 vulnerabilities found / Severity: 7 moderate | 9 high (1 ignored)` (the
  same 16 entries as before the change; one is now tagged ignored).
