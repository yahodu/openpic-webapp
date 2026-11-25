# ADR-0991 — Proprietary license, contributor grant, and the dependency-license audit

- **Status:** Accepted
- **Date:** 2026-11-25
- **Card:** `t_a3351538` (docs; branch
  `OP-101-task-readme-contributing-and-license`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_a3351538`, cut from `origin/main`
  `b7c62f17`).
- **Implements:** the repository's licensing position — a new
  [`LICENSE`](../../LICENSE), a new [`CONTRIBUTING.md`](../../CONTRIBUTING.md), a
  new [`README.md`](../../README.md), and `"license": "UNLICENSED"` in the root
  `package.json`. No application code, no test, no fixture and no existing spec is
  touched.
- **Consumes:** `0991` — **pool draw**, because the card body carried no
  `Consumes` value and this is a board-wide ownership decision that belongs to no
  ticket lane. The board-wide / process `Next free` cell, the
  `unallocated (future lanes)` cursor and the two lane cells that mirror the
  cursor all read `0991` at this cut and advance to `0992` (ADR-0300 §11 item 18).
- **Consumers:** [`LICENSE`](../../LICENSE), [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
  [`README.md`](../../README.md), and `package.json`'s `license` field.

## Context

The repository is public on GitHub (`yahodu/openpic-webapp`, homepage
`https://openpic.in`) and carries no `LICENSE` file. With no license, the default
position is "all rights reserved" — but that position is undocumented, unstated to
readers, and silent on the two questions the owner actually needs answered:

1. May someone clone the repository, run the app, or ship it — for free or for
   money? The owner's answer is **no**.
2. May the license change later? The owner's answer is **yes** — and that promise
   is only keepable if every contribution carries a grant wide enough to relicense
   it, because a contributor's copyright would otherwise veto the change.

The owner also asked for a check before the text was written: **no dependency may
forbid this licensing position.** The audit is in the Decision below.

Two platform facts bound what a license can actually achieve here, and neither is
a dependency problem:

- GitHub's Terms of Service let any signed-in user **view and fork a public
  repository** and keep that fork on GitHub, whatever the license says. A
  proprietary license does not switch that mechanism off; it makes the fork's use
  a license breach, enforceable legally rather than technically. Making the
  repository private is the only technical control.
- The repository is `"private": true` in `package.json` (the npm-publish sense),
  which does not restrict anyone; only the `license` field and this notice state
  the position to tooling.

## Decision

### D1 — A proprietary license with a narrow permission set

`LICENSE` ("OpenPic Proprietary License", version 1.0) grants exactly three
permissions — view and study the code, clone and run the tests locally to evaluate
it or prepare a contribution, and quote short passages with attribution — and
prohibits every other use, naming the two the owner called out: no hosting or
running as a service whether paid or free, and no distribution whether paid or
free. Modification, sublicensing, sale, trademark use and notice removal are
prohibited as well.

The license states that it may be replaced in future (§11), and that a released
version stays under the license it shipped with.

### D2 — The contribution grant is what makes D1 reversible

`LICENSE` §6 takes a perpetual, irrevocable, worldwide, royalty-free, transferable
and sublicensable grant from each contributor, expressly including the right to
**relicense** the contribution under any terms, plus a patent grant over the
contributor's own claims. The contributor keeps their copyright; the project keeps
the freedom to relicense. Contributions are accepted only from contributors the
owner adds to the repository (`CONTRIBUTING.md` §1), which keeps the set of grant
holders closed and auditable.

Without D2, D1's "the license can change" is not true for any file a contributor
wrote.

### D3 — The dependency-license audit found no blocker

Measured with `pnpm licenses list --json` over the installed tree (542 packages,
210 of them production) at `origin/main` `b7c62f17`:

| License group                                                                      | Packages | Position for a proprietary application                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT                                                                                |      421 | Permissive — no condition                                                                                                                                                                                                                                                                                                                                                                                       |
| Apache-2.0                                                                         |       63 | Permissive — keep notices                                                                                                                                                                                                                                                                                                                                                                                       |
| ISC / BSD-2 / BSD-3 / 0BSD / BlueOak-1.0.0 / CC0-1.0 / Zlib / dual                 |       46 | Permissive — no condition                                                                                                                                                                                                                                                                                                                                                                                       |
| MPL-2.0 (`lightningcss`, `lightningcss-linux-x64-gnu`)                             |        2 | File-level copyleft: obligations attach only to modified MPL files; we modify none. It is Next.js's CSS compiler, a build-time tool                                                                                                                                                                                                                                                                             |
| CC-BY-4.0 (`caniuse-lite`)                                                         |        1 | Data, attribution only; build-time data, not shipped to clients                                                                                                                                                                                                                                                                                                                                                 |
| LGPL-3.0-or-later (`@img/sharp-libvips-linux-x64`)                                 |        1 | Weak copyleft: linking does not reach our code. Arrives transitively as `next@15.5.29 → sharp@0.35.5 → @img/sharp-linux-x64@0.35.5`, an unmodified native binary loaded at runtime, and the app is deployed as a service rather than distributed as a binary — so the relink/replacement obligation is not triggered. If the binary is ever shipped to a user, publish its license text and a way to replace it |
| Dev-only remainder (`argparse` Python-2.0, `npm` Artistic-2.0, `spdx-*` CC-BY/CC0) |          | Build tooling, never part of the distributed artifact                                                                                                                                                                                                                                                                                                                                                           |

**Zero** GPL, AGPL, SSPL, BUSL, EUPL, OSL or non-commercial (`CC-BY-NC`) packages
in either the full or the production set. **Nothing forbids proprietary
licensing.** The three conditional packages are recorded in `LICENSE` §7 as keeping
their own terms, which is what the LGPL and MPL expect a downstream notice to say.

### D4 — The repository states its position in three places

`LICENSE` (the terms), `CONTRIBUTING.md` §10 (the grant a contributor accepts by
submitting), and `package.json` `"license": "UNLICENSED"` (SPDX's "proprietary, do
not use" marker, which dependency scanners read). `README.md` links all three.

### D5 — The documentation split

`README.md` is the front door: positioning, the three planes, features, stack,
layout, getting started, scripts, testing, the API at a glance, a documentation
index, contribution and license summaries. Depth stays in the documents that
already own it — the API contract, the diagrams, the design notes, the
conventions and the ADR set — so the README does not become a second, stale copy.
`CONTRIBUTING.md` carries the workflow for humans **and** agents, because this
repository is driven by both and a rule an agent cannot read is a rule that does
not exist for half its contributors.

## Consequences

- A reader can no longer mistake the repository for open source. GitHub renders the
  license as "Other"; the badge and `README.md` say "Proprietary".
- Every future contribution needs the §6 grant to be enforceable. The PR template
  is unchanged; `CONTRIBUTING.md` §10 states that submitting a contribution accepts
  it. If the owner wants a signed CLA instead of an inbound grant, that is a new
  decision and a new record.
- The license names **India** as the governing law and leaves the copyright holder
  line as `OpenPic`. Both are the owner's to confirm; a change is a text edit, not a
  renumbering, and does not touch any code.
- The audit is a snapshot of `pnpm-lock.yaml` at this head. A new dependency can
  change the answer, so the `audit` check in CI remains the mechanical guard: a
  package with an incompatible license arrives as a red check, not a surprise.
- Forking through GitHub stays possible (Context). Enforcement is legal, not
  technical.

## Alternatives

- **MIT / Apache-2.0.** Rejected: it grants exactly what the owner wants to forbid —
  free and commercial reuse, including hosting the app.
- **Business Source License or another source-available license.** Rejected: it
  converts to an open-source license on a date or event the owner has not chosen,
  and its "additional use grant" wording invites a licensing argument on every
  use.
- **Creative Commons BY-NC.** Rejected: CC licenses are not designed for software
  (no patent grant, no source/compiled distinction) and "NC" is unresolved for
  SaaS.
- **No `LICENSE` file at all.** Rejected: it is the same position as D1 but
  undocumented, unenforceable in practice and invisible to `CONTRIBUTING.md`'s
  grant.
- **A signed CLA instead of an inbound grant.** Rejected for now: a CLA needs
  tooling and a signature store the repository does not have, and the inbound grant
  in §6 achieves the same relicensing freedom for the contributors the owner admits
  by hand.
