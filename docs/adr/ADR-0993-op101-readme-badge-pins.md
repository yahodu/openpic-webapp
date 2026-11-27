# ADR-0993 — OP-101: the README badge strip is pinned to one host, and the CI badge to the live workflow status

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** OP-101 TEST `t_836686f4` (openpic-webapp-testcase-writer), raised by finding **F3** of the review card `t_ac75f547` of PR [#985](https://github.com/yahodu/openpic-webapp/pull/985) (squash `3dbd684b`) · **Branch:** `OP-101-task-readme-badge-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ac75f547`
- **Lane:** OP-101 follow-up (README housekeeping) · **Consumes:** `0993` — a **pool draw**, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18); the four pool-mirror cells read `0993` at this cut and each advances to `0994`
- **Spec sources:** the centred header block of `README.md` (7 markdown badge images, 2026-11-27)
- **Consumers:** `apps/web/src/test/unit/readme-badges.test.ts`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the guard conventions this record follows)

## Context

PR [#985](https://github.com/yahodu/openpic-webapp/pull/985) was filed because the
`CI | passing` badge looked wrong beside the other six. The measured cause was two
hosts and two geometries in one strip — the state before that squash
(`3dbd684b`), read from `git show 3dbd684b^:README.md`:

```text
shieldcn.dev/badge/...                                     6 badges (license, Next.js, TypeScript, Node.js, pnpm, MongoDB)
github.com/…/actions/workflows/ci.yml/badge.svg?branch=main  1 badge (CI)
```

`3dbd684b` moved all seven onto `img.shields.io` and kept the CI badge **live**:
`img.shields.io/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml?branch=main&label=CI`,
which the reviewer measured as `200` with `aria-label="CI: passing"`. Nothing
pinned that outcome. Both halves of the defect can therefore return silently: a
new or restored badge on another host re-splits the strip's geometry, and a CI
badge "simplified" into a static `badge/CI-passing-brightgreen` renders a status
string that can never go red — worse than no badge, because it asserts a fact.

Finding **F3** of the review of `3dbd684b` is that gap, and the implementer
listed it as a coverage gap too. There is no live defect on the trunk: 7/7 badge
images are on `img.shields.io`, the CI badge uses the workflow-status endpoint,
and `shieldcn.dev` appears nowhere in the file.

## Decision

**D1 — the badge set is read from the real README's centred header block.** The
spec slices the text between the first `<div align="center">` and its closing
`</div>` and extracts every markdown image target (`!\[[^\]]*\]\((https?://[^)\s]+)\)`).
Scoping to the header block keeps the pin precise: a screenshot or a diagram
added further down the document is not a badge. A missing opener, a missing
closer or an empty block **throws** — an empty block would make the host
assertion vacuous, and a spec that silently pins nothing is worse than none.
This is the same real-tree, path-from-the-spec style as
`apps/web/src/server/config/env-example.test.ts`.

**D2 — every badge in the block is served from `img.shields.io`.** The case maps
the extracted URLs to their distinct hosts (`new URL(url).host`) and asserts the
set is exactly `["img.shields.io"]`, so the failure names the offending host
(`expected [ 'shieldcn.dev', 'img.shields.io' ] to deeply equal …`) rather than a
boolean, and an empty strip fails as well instead of passing vacuously. The count
is deliberately **not** pinned: eight badges on one host are fine, one badge on a
second host is the defect.

**D3 — the CI badge stays on the live workflow-status endpoint.** One case
requires a badge whose host is `img.shields.io` and whose `pathname` is exactly
`/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml`. The query string
is left free (`?branch=main&label=CI` today), so relabelling or retargeting a
branch does not red the pin, while a static `badge/CI-passing-brightgreen` path
cannot satisfy it by construction. This is the half that forbids "simplifying"
the badge into a status string.

**D4 — `shieldcn.dev` must not return.** A final case asserts the README source
contains no `shieldcn.dev`, which catches the exact pre-`3dbd684b` host wherever
in the file it reappears, not only inside the header block.

**D5 — rejected alternatives.** Fetching the badge URLs and asserting `200` /
the rendered `aria-label`: it makes a `unit` case depend on the network, where a
DNS blip reds a repository that has not changed, and the card's own contract says
this pin stays hermetic — the live status was verified out of band by the
reviewer, twice. Asserting the exact count of seven: it couples the spec to the
current strip, so a legitimate new badge fails a pin that is not about counting.
Asserting the whole URL byte for byte: a label change (`label=CI` → `label=build`)
is legitimate and must not red a host/endpoint pin. A markdown snapshot of the
header: it renders the diff of a styling change as a wall of text and says
nothing about the two properties this record is about. Reading the rendered HTML
instead of the source: the strip is a source-text contract, and the render adds a
build step to a spec whose whole value is that it is cheap.

## Evidence

**Counts, measured on this branch** — cut at `origin/main` `49c4e3c8`; one spec
file and this record's ledger row, no production file.

```text
focused  apps/web/src/test/unit/readme-badges.test.ts  ->  4 passed (4)
full     vitest run --project unit (this head)         ->  3547 passed | 3 skipped (3550) / 203 files
full     vitest run --project unit (spec moved aside)  ->  3543 passed | 3 skipped (3546) / 202 files
ten      adr-* guard specs                             ->  10 files / 396 passed (396)
typecheck / lint / prettier                            ->  exit 0 / exit 0 (0 errors, 1 new warning) / clean
```

The unit delta is exactly this spec: `+4` cases and `+1` file, with the other
`3543` cases unchanged. The new lint warning is
`security/detect-non-literal-fs-filename` on the `readFileSync` helper — the
same single warning `env-example.test.ts:36` carries for the same reason (the
path is built from `import.meta.url`), and the repo is at `0` errors.

**Each pin is discriminating, measured with two mutations** (a tracked file
mutated, run, restored; `sha256 README.md` `c240efab…5ea9b163` equal before and
after, `git status --short` naming the spec only):

- **A — one `shieldcn.dev` URL restored** (the license badge, i.e. the exact
  pre-`3dbd684b` host): `Tests 2 failed | 2 passed (4)` —
  `serves every badge image from img.shields.io`
  (`expected [ 'shieldcn.dev', 'img.shields.io' ] to deeply equal [ 'img.shields.io' ]`)
  and `carries no leftover shieldcn.dev badge host`
  (`expected '<div align="center">…' not to contain 'shieldcn.dev'`). D2 and D4
  bite; D3 stays green because the CI badge is untouched.
- **B — the live CI URL swapped for `https://img.shields.io/badge/CI-passing-brightgreen`**
  (same host, so D2 is blind by design; this is the "simplify the badge" fix):
  `Tests 1 failed | 3 passed (4)` —
  `keeps the CI badge on the live GitHub Actions workflow status endpoint`, whose
  message lists every badge URL the block declares (`README badge URLs:
https://img.shields.io/badge/license-Proprietary-red.svg,
https://img.shields.io/badge/CI-passing-brightgreen, …`). D2, D4 and the
  non-vacuity anchor stay green, which is what makes D3 load-bearing rather than
  a restatement of D2.

After each restore the focused file reads `4 passed (4)` again.

**Characterization, not RED.** The trunk satisfies every pin, so the spec is
green on arrival. Its value is negative: it reds when a badge moves host, when
the CI badge stops reading the workflow status, or when the old host returns.

## Consequences

- Adding a badge from another host now fails the unit suite and names the URL.
  Adding a badge on `img.shields.io` does not — the count is not pinned.
- Replacing the CI badge with any static `badge/…` URL fails, whatever its text,
  colour or label. So does pointing it at another repository or workflow file.
- Moving the strip out of the `<div align="center">` block fails loudly (the
  extraction throws) instead of shrinking to a vacuous empty set.
- Reversal condition: a genuinely second-host badge (a vendor's own badge that
  only that vendor serves) needs its own documented exception list with a stated
  reason, the way the four process-managed environment names have one in
  [ADR-0992](ADR-0992-op101-config-template-doc-pins.md). Today the strip has no
  exception.
- Not covered on purpose: whether the URLs resolve, what colours they render and
  whether GitHub's cache is warm. Those are network facts, verified out of band
  (`200`, `aria-label="CI: passing"`), not repository state; pinning them in
  `unit` would flake on someone else's outage.

## Numbering

The four-surface sweep at this cut (`origin/main` `49c4e3c8`, squash of
PR [#987](https://github.com/yahodu/openpic-webapp/pull/987)) finds the trunk's
`docs/adr` ending at `ADR-0992`; `git rev-list --objects --all -- docs/adr`
ends at `0992`; the only `docs/adr` tree under `.worktrees/*` is this card's;
`gh pr list --state open` is empty; and no non-`done` card body reserves `0993`
(the queued row-scope card `t_b49dc690` names `0992` only, and the sign-off card
`t_de204301` cites `0993` as a _cell value_, not a reservation). `0993` is
therefore a pool draw above the highest in-flight reservation per
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18. The four
pool-mirror cells (`board-wide / process`, `OP-129 attendee identity lane`,
`OP-136 jobs lane`, `unallocated (future lanes)`) read `0993`; the higher of
`0993` and `0993 + 1` is `0994`, so each advances to `0994` and none is lowered.
Hotspot: `docs/adr/README.md` (this record's ledger row) — merge as a union
keeping the highest value in every cell.
