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
  [`README.md`](../../README.md), `package.json`'s `license` field, and
  `apps/web/src/test/unit/dependency-licenses.test.ts` (the D3 licence-inventory pin).

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
| ISC / BSD-2 / BSD-3 / 0BSD / BlueOak-1.0.0 / CC0-1.0 / Zlib / dual                 |       51 | Permissive — no condition                                                                                                                                                                                                                                                                                                                                                                                       |
| MPL-2.0 (`lightningcss`, `lightningcss-linux-x64-gnu`)                             |        2 | File-level copyleft: obligations attach only to modified MPL files; we modify none. It is Next.js's CSS compiler, a build-time tool                                                                                                                                                                                                                                                                             |
| CC-BY-4.0 (`caniuse-lite`)                                                         |        1 | Data, attribution only; build-time data, not shipped to clients                                                                                                                                                                                                                                                                                                                                                 |
| LGPL-3.0-or-later (`@img/sharp-libvips-linux-x64`)                                 |        1 | Weak copyleft: linking does not reach our code. Arrives transitively as `next@15.5.29 → sharp@0.35.5 → @img/sharp-linux-x64@0.35.5`, an unmodified native binary loaded at runtime, and the app is deployed as a service rather than distributed as a binary — so the relink/replacement obligation is not triggered. If the binary is ever shipped to a user, publish its license text and a way to replace it |
| Dev-only remainder (`argparse` Python-2.0, `npm` Artistic-2.0, `spdx-*` CC-BY/CC0) |        3 | Build tooling, never part of the distributed artifact                                                                                                                                                                                                                                                                                                                                                           |

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
- D3 was a manual snapshot of `pnpm-lock.yaml` at this head. The `audit` check in
  CI is a **vulnerability** gate — `pnpm audit --prod --audit-level=moderate` reads
  the advisory database and never reads a package's `license` field — so it says
  nothing about licences, and a GPL dependency would land green. The mechanical
  licence guard is the inventory spec added by card `t_3fffed3c`
  (`apps/web/src/test/unit/dependency-licenses.test.ts`), whose allow-list is D3's
  position: a package outside it reddens CI.
- Forking through GitHub stays possible (Context). Enforcement is legal, not
  technical.

### Review correction (round 1, PR #976)

Round 1 of the review of PR #976 (card `t_a3351538`, 2026-11-25) measured two
statements in this record and found both false. §Consequences claimed the CI
`audit` check was the mechanical licence guard; `pnpm audit` reports vulnerability
advisories and never reads licence metadata, and no workflow reads a `license`
field. The D3 table's permissive group read 46 packages where
`pnpm licenses list --json` counts 51 (ISC 29, BSD-2-Clause 9, BSD-3-Clause 6,
0BSD 1, BlueOak-1.0.0 2, CC0-1.0 1, `(MIT AND Zlib)` 1,
`(BSD-2-Clause OR MIT OR Apache-2.0)` 1, `(MIT OR CC0-1.0)` 1), and the three
dev-only remainder packages were left out of the Packages column, so the column
summed to 537 instead of the measured 542. Both statements are corrected by card
`t_8229f552`, and the licence inventory spec of card `t_3fffed3c` replaces the
manual snapshot. Nothing in the accepted decision is retracted: D1, D2, D3's
conclusion (no dependency forbids a proprietary licence), D4 and D5 stand as
recorded.

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

## Review — round 1 (post-merge verification, PR #976)

Round 1 of the review of PR #976 (card `t_a3351538`) ran after the squash landed,
so it verifies what the trunk carries instead of what a branch proposed. Verdict:
**approved with findings** — four documentation defects, each routed to its own
card, and none of them a reason to unwind the delivery.

### Merge state

- `gh pr view 976` → `state=MERGED`, `mergedAt=2026-11-25T13:11:47Z`, `headRefOid=201674c3`, `mergeCommit=295426ce`, `baseRefName=main`.
- `git merge-base --is-ancestor 295426ce origin/main` → exit `0`.
- Reviewed head against the squash, scoped to this PR's paths
  (`CONTRIBUTING.md`, `LICENSE`, `README.md`, this record, `docs/adr/README.md`,
  `package.json`): `git diff --stat 201674c3 295426ce` → empty. The whole-tree
  difference is one file, `AGENTS.md` (+7/−1), and it is `fa72b733` (PR #975) — a
  trunk commit that landed between the branch cut and the squash, not a change of
  this lane.

### Gate evidence

- CI on the head: 15 of 15 rollup entries `COMPLETED`/`SUCCESS` — the fourteen
  gates that ran against `201674c3` (`ci`, `audit`, `audit-dev`, `secret-scan`,
  `lint`, `unit_test`, `test_coverage`, `validate-branch-name`,
  `validate-pr-title`, `env-changes`, three CodeQL jobs, `Assert CI evidence`)
  plus the `notify-discord` close side-effect.
- Local suite, re-run for this section rather than copied from the review comment:
  at `201674c3` `201 files / 3479 passed | 3 skipped`; at `37ec9ec3`
  `202 files / 3534 passed | 3 skipped`, the extra file and cases being the
  licence inventory of card `t_3fffed3c`.
- The ten `adr-*` guards: `10 files / 396 passed (396)` at `201674c3` and again at
  `37ec9ec3`.
- `pnpm format:check` → "All matched files use Prettier code style!".
- The six `shieldcn.dev` badge URLs in `README.md` and the `ci.yml` workflow badge
  all answer `200` with `image/svg+xml`.

### The dependency-licence conclusion, re-verified

`pnpm licenses list --json` was reproduced independently at `37ec9ec3`, whose lock
file and `package.json` are byte-identical to the reviewed head's: 542 packages,
210 of them production, 17 licence keys — MIT 421, Apache-2.0 63, the permissive
group 51, MPL-2.0 2, CC-BY-4.0 1, LGPL-3.0-or-later 1, and three dev-only
remainder packages. Zero GPL, AGPL, SSPL, BUSL, EUPL, OSL or CC-BY-NC packages in
either the full or the production set, so D3's conclusion holds: no dependency
forbids a proprietary licence. The permissive group counts 51 here, which is the
number the corrected D3 row carries.

### Findings beyond the pinned acceptance criteria

Four defects that the delivery's acceptance criteria did not name. Each is cited
by card id; the follow-up's own record documents what followed it.

- **F1 — Medium.** The accepted Consequences section called the CI `audit` check
  the mechanical licence guard. `pnpm audit` queries the advisory database and
  never reads a package's licence field, so a GPL dependency would have landed
  green. Card `t_3fffed3c` pins the inventory guard that answers that gap.
- **F2 — Medium.** `README.md` advertised a Stripe payment adapter that does not
  exist; selecting it fails closed with a `ConfigError`. Card `t_085913bc`.
- **F3 — Low.** `README.md` denied the browser UI while `apps/web/src/app/layout.tsx`
  and `apps/web/src/app/page.tsx` exist as App Router pages. Card `t_085913bc`.
- **F4 — Low.** The D3 permissive row read 46 where the measured set is 51,
  leaving the Packages column three short of the measured 542. Card `t_8229f552`.

Nothing in the accepted decision is retracted. The licence position (D1), the
contribution grant that makes it reversible (D2), the audit conclusion that no
dependency forbids it (D3), the three-places statement (D4) and the documentation
split (D5) stand as recorded; the four findings are wording and count defects
around that decision, not a disagreement with it.

### Post-review status

All four findings are closed on the trunk at the time of writing: `t_3fffed3c`
landed as PR #977 (`7c4ed37b`), `t_085913bc` as PR #978 (`03a9b0b5`), and
`t_8229f552` as PR #979 (`37ec9ec3`). One further documentation follow-up, card
`t_b56eeaea`, is open — it adds the licence inventory spec to this record's
`Consumers:` line — and this section makes no claim about it.
