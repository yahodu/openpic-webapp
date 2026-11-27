# ADR-0994 — OP-101: the README badge host pin reads the whole file, in every image form

- **Status:** Accepted · **Date:** 2026-11-27
- **Card:** OP-101 TEST `t_c4d4393e` (openpic-webapp-testcase-writer), raised by finding **F3-a** (Low) of the round-1 review of PR [#988](https://github.com/yahodu/openpic-webapp/pull/988) (squash `0422e5a0`) · **Branch:** `OP-101-task-readme-badge-scope` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_ac75f547`
- **Lane:** OP-101 follow-up (README housekeeping) · **Consumes:** `0994` — the reservation [ADR-0995](ADR-0995-op101-config-row-scope-and-short-name-pins.md) §Numbering explicitly left to this card, because the OP-101 lane holds no reserved row and the `0300`–`0319` block is exhausted ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 item 18); the four pool-mirror cells read `0996` at this cut, which is already above `0994 + 1`, so no cell moves
- **Spec sources:** `README.md` — 7 image references, every one of them inline markdown on `img.shields.io`, 0 `<img>` tags and 0 reference definitions (census measured on this cut, 2026-11-27)
- **Consumers:** `apps/web/src/test/unit/readme-badges.test.ts`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18 — the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own row), [ADR-0302](ADR-0302-adr-number-guard-contract.md) (the guard conventions this record follows), [ADR-0993](ADR-0993-op101-readme-badge-pins.md) (the strip pins this record widens — its D2, D3 and D4 stand, its D1 scope is superseded), [ADR-0995](ADR-0995-op101-config-row-scope-and-short-name-pins.md) (the numbering split)

## Context

[ADR-0993](ADR-0993-op101-readme-badge-pins.md) pinned the README badge strip to
one host. Its D1 sliced the text between the first `<div align="center">` and its
closing `</div>`, and its extractor read only the inline `![alt](url)` form. Both
halves of that scope were deliberate — a screenshot further down the document is
not a badge — but together they leave three shapes of the _same_ defect invisible:

```text
D  <img src="https://example.com/badge/deploy.svg" alt="Deploy" />  inside the block   4 passed (4)
E  [![Deploy](https://example.com/badge/deploy.svg)](https://example.com)  after </div>  4 passed (4)
H  ![Deploy][deploy] + [deploy]: https://example.com/badge/deploy.svg  inside the block  4 passed (4)
```

Those are the reviewer's probes D, E and H of finding **F3-a** on the merged
trunk `0422e5a0`; the same three mutations red the new census (measured below).
The pin's stated intent is "one badge family", and a second host that arrives as
an HTML tag, immediately after the block, or through a reference definition is
still a second host in the rendered strip. The inline-inside-the-block shape
(probe C) was already caught, which is what hid the gap: the pin looked complete
because the obvious mutation reds.

There is no live defect on this tree. The census before the change: 7 image
references, all `inline`, all `https://img.shields.io/…`; zero `<img>`; zero
reference definitions; the 16 fence markers are balanced across eight blocks.

## Decision

**D1 — the census reads the whole file, in every form an image can be written
in.** `imageReferencesOf()` scans the entire document for five forms — inline
`![alt](url)` (with an optional `<…>` target and an optional title), full
reference `![alt][label]`, collapsed reference `![alt][]`, shortcut reference
`![alt]`, and HTML `<img src="…">` (single or double quoted). Reference labels
resolve against the file's own `[label]: url` definitions, matched
case-insensitively and with whitespace collapsed the way CommonMark does. The
census returns `{ form, url }` pairs in document order, so a failure names both
the offending URL and the shape that carried it.

An image whose label has no definition **throws**, naming the label. Silently
skipping it would be the exact failure this record exists to close: a census that
is quietly short reads as a pass. This is the same fail-closed posture as
ADR-0993 D1's throw on a missing `<div>`.

**D2 — fenced code blocks are dropped before the scan.** An image inside a fence
renders as literal text, not as an image, so it is not a badge; dropping the
fences also keeps a future markdown example from reding the census. An unbalanced
fence swallows the rest of the file, which empties the census — that fails the
host assertion loudly rather than passing.

**D3 — "looks like a badge" is defined positively, never by exclusion.** An
absolute URL is badge-shaped when its pathname matches a badge path
(`/(?:^|\/)(?:badge|shields)(?:\/|$)/`), or ends in `.svg`, or is exactly the
live GitHub Actions workflow-status path
`/github/actions/workflow/status/yahodu/openpic-webapp/ci.yml` (the third clause
exists because that path ends in `.yml`, so no pathname rule would catch it). A
repository-relative image is served from this repository and cannot add a second
host, so it is out of the host assertion by construction. The **escape hatch is
`NON_BADGE_IMAGE_ALLOWLIST`, an explicit constant of exact URLs, empty today**:
when the README gains a screenshot or a diagram from a docs CDN, its URL goes
there with the reason, instead of narrowing the scan and losing every badge at
the same time.

**D4 — the four strip cases stay byte-identical.** ADR-0993's cases still read
the centred block and the inline form; they keep their precision (a badge inside
the strip is caught by the tighter pin too) and their history. The census is a
new `describe` beside them, so a regression in either layer reds its own cases
and a reader can tell which scope fired. Measured cost: a badge inside the strip
now reds two cases, which is the loud direction.

**D5 — nothing else is pinned.** The badge count stays free (an eighth badge on
`img.shields.io` is legitimate), the query string stays free (`label=` may
change), the host set stays a single-entry assertion rather than a byte-for-byte
URL match, and the spec never fetches a URL — the `unit` project stays hermetic.
Rejected alternatives: mutating `README.md` from the spec to prove the census
(a test that edits the artifact it measures); a markdown snapshot of the file (a
wall of text that says nothing about hosts); asserting the image count of 7 (it
couples the pin to today's strip); scanning only `<img>` plus inline (it would
leave the reference form blind, which is half of this fix).

## Evidence

**Counts, measured on this branch** — one spec file changed, no production file,
no `README.md` byte touched.

```text
focused  apps/web/src/test/unit/readme-badges.test.ts  ->  14 passed (14)
full     vitest run --project unit (this head)         ->  3612 passed | 3 skipped (3615) / 203 files
full     vitest run --project unit (spec moved aside)  ->  3598 passed | 3 skipped (3601) / 202 files
trunk    vitest run --project unit (origin/main)       ->  3602 passed | 3 skipped (3605) / 203 files
typecheck (root, contracts, apps/web) / lint / prettier ->  exit 0 / 0 errors, 193 warnings / clean
```

`303a4ff501fd8cdf3426cfc6bd117d03a81d09e2` is the spec commit these counts were
read on; the trunk figure is the one the parent handoff `t_b49dc690` recorded at
`6c7fc642`. The delta is exactly this spec: `3598 + 4` (the pre-change four
cases) `= 3602` on the trunk, and `3598 + 14 = 3612` here — `+10` cases, the file
count unchanged at 203. The lint warning delta is `0` (the spec carried one
`security/detect-non-literal-fs-filename` warning before and after, on the same
`readFileSync` helper).

**Each new pin is discriminating, measured with three mutations of a tracked
file** (`sha256 README.md` `c240efab…5ea9b163` equal before and after every
probe, `git status --short` naming the spec only, nothing committed):

- **(a) an HTML badge inside the block** —
  `<img src="https://example.com/badge/deploy.svg" alt="Deploy" />` added after
  the MongoDB badge: `Tests 1 failed | 13 passed (14)`; the red is
  `serves every badge-shaped image anywhere in the file from img.shields.io`
  with `expected [ 'example.com', 'img.shields.io' ] to deeply equal
[ 'img.shields.io' ]`, and its message lists the entry as
  `html https://example.com/badge/deploy.svg`.
- **(b) an inline badge just after the block** —
  `[![Deploy](https://example.com/badge/deploy.svg)](https://example.com)`
  added between `</div>` and the first `---`: `Tests 1 failed | 13 passed (14)`,
  the same case, `expected [ 'example.com', 'img.shields.io' ] to deeply equal
[ 'img.shields.io' ]`, the entry listed as `inline`.
- **(c) a reference-style badge inside the block** — `![Deploy][deploy]` plus
  `[deploy]: https://example.com/badge/deploy.svg` added below the MongoDB
  badge: `Tests 1 failed | 13 passed (14)`, the same case, the entry listed as
  `reference` — proof the label resolved through the definition rather than
  being skipped.

Under each mutation the four strip cases stay green, which is the measured shape
of the gap this record closes: the tighter scope is blind by construction, and
the census is the only case that fires.

**Characterization, not RED.** The trunk satisfies every pin, so the spec is green
on arrival; its value is negative.

## Consequences

- A second badge host now fails the unit suite wherever the badge is written:
  inside or outside the centred block, as an HTML tag, or through a reference
  definition. The failing case lists every image reference in document order
  with its form.
- A reference-style image with no definition fails loudly with the label in the
  message, so a half-written reference cannot shrink the census.
- An image inside a fenced block is not counted. That is the documented boundary
  of the scan, and an unbalanced fence fails loudly instead of silently.
- A legitimate non-badge image on another host needs its exact URL in
  `NON_BADGE_IMAGE_ALLOWLIST` with a stated reason; narrowing the pathname rules
  is the wrong change because it disarms every badge pin at once.
- Not covered on purpose: whether the badge URLs resolve, what colours they
  render, and the height at which GitHub paints them. Those are network and
  rendering facts; `unit` stays hermetic. Also not covered: a markdown image that
  is valid only through an inline HTML block or a `<picture>`/`<source>` pair —
  the README has none, and widening to full CommonMark parsing is a parser
  dependency this pin does not need.
- Reversal condition: if the census ever has to ignore a large family of images
  (for example a docs directory rendered into the README), the right change is a
  documented allowlist entry per URL, or a new pin over the rendered HTML — not
  a narrower scan.

## Numbering

The four-surface sweep at this cut (`origin/main` `6c7fc642`, working tree
`303a4ff5`):

1. the trunk's `docs/adr` ends at `ADR-0995`; `ADR-0994` exists nowhere on it,
   so the number sits in a gap that [ADR-0995](ADR-0995-op101-config-row-scope-and-short-name-pins.md)
   created on purpose;
2. `git rev-list --objects --all -- docs/adr` also ends at `ADR-0995`, and the
   only higher path on any ref is `ADR-0996-op101-readme-and-workflow-layout.md`
   on the local branch `OP-101-task-readme-workflow-standards` (worktree
   `.worktrees/op101-readme-workflow`, head `b97b3bd5`) — an in-flight lane, not
   this number;
3. the only `docs/adr` tree under `.worktrees/*` besides that lane is this card's;
4. `gh pr list --state open` returns **no** open PR, so no PR head holds a number;
   and no non-`done` card body reserves `0994` — the card `t_325f02d0` cites it
   only as this card's reservation, and the review sign-off `t_de204301` carries
   none.

`0994` is therefore taken as the reservation this card was created with, above
the trunk's high-water mark by one under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §3 — a gap, not a
reissue. The four pool-mirror cells (`board-wide / process`, `OP-129 attendee
identity lane`, `OP-136 jobs lane`, `unallocated (future lanes)`) read `0996`;
the higher of `0996` and `0994 + 1` is `0996`, so **none of them moves** and none
is lowered. Hotspot: `docs/adr/README.md` (this record's ledger row) — merge as a
union keeping the highest value in every cell (the layout lane's `0997` wins if
it lands first).
