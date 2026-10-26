# ADR-0542 — OP-114 follow-up TEST: the round-1 event-twin denial and `<?xml`-SVG pins

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-114 follow-up TEST (`t_630fbbd8`) · **Branch:** `OP-114-task-event-twin-xml-svg-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_630fbbd8` · **Base:** `origin/main` `c055cac` (squash `87e1170` of PR #371 is an ancestor)
- **Relates to:** [ADR-0540](ADR-0540-op114-branding-upload-red.md) (the RED, whose §1 recorded the event route's no-organizer denial as `404 not_found` **non-oracle, unpinned** — assumption A4; and whose §2 named the `<?xml` declaration as an SVG root without pinning the sanitized output), [ADR-0541](ADR-0541-op114-branding-upload-green.md) (the GREEN, which shipped both behaviours), [ADR-0306](ADR-0306-op93-red-by-design-ci.md) (RED-by-design posture — here the pins are GREEN-on-arrival and prove discrimination by mutation probe instead)
- **Contract:** §2.1 of `docs/API Contract.md` (the branding upload — both the tenant route's `403 forbidden` for a `member` and the event twin's `404 not_found` denials), the event twin route `POST /events/{eventId}/assets/branding` (organizer-row authorisation)

## Context

Round-1 review of PR #371 (OP-114 branding upload, squash-merged `87e1170`) routed two
coverage findings to the Test Author as a **test-only** follow-up against the merged
trunk:

- **Pin 1 (Medium) — event-twin denial uniformity.** The event-scoped twin refuses
  both a caller with no active `event_organizers` row and a malformed `{eventId}` with
  `404 not_found` (envelope `not_found`), while the tenant twin answers `403
forbidden` to a member (the `I5` pin). ADR-0540 §1 recorded the event denial as
  "the probe's non-oracle denial, unpinned". The asymmetry is deliberate (probing the
  event's existence/event-organizer row is an existence oracle, so the denial must not
  reveal which of the two branches fired), but nothing pinned it — a later change to
  the oracle `403` would silently pass.
- **Pin 2 (Low) — svg-with-`<?xml` declaration.** `sniffBrandingFormat` accepts a
  `<?xml` declaration before the root (ADR-0540 §2), and `sanitizeSvg` tokenizes the
  whole text — but no pin asserted that a sanitized `<?xml`-prefixed SVG **retains the
  leading declaration** byte-identical (or the chosen stripping behaviour) and still
  has every script payload removed. The `U2`/`I4` pins drive a malicious SVG that
  begins directly with `<svg …>`, so a sanitizer that dropped or mangled the
  declaration would pass them.

Both behaviours are correct on the merged trunk, so these are **characterisation pins
(green on arrival)** — there is no RED to hand to a GREEN and no GREEN sibling to
create. Per ADR-0306 the pins PR is the artefact; the pin is proven to discriminate by
a **mutation probe** that flips the shipped behaviour and observes the pin redden.

## Decisions

### 1. Pin the event twin's three `404 not_found` denials (Pin 1)

Three new integration cases in `branding-upload.test.ts` (append-only `it` blocks
inside the existing event-twin `describe`; no existing assertion edited):

- an **authenticated caller with no `event_organizers` row** for an existing event
  answers `404` with envelope `not_found` — and the denial is total (no `mediaAssets`
  row);
- a **malformed event id** (`not-a-valid-objectid`) answers `404` with envelope
  `not_found`;
- a **well-formed event id that names no event** answers `404` with envelope
  `not_found`.

The tenant-member `403 forbidden` (`I5`) stays pinned as the oracle side of the
asymmetry — unchanged. The mutation probe flips the no-organizer denial to
`appError("forbidden")`; the first case reddens with
`AssertionError: expected 403 to be 404`, the other two stay green (their branches are
unaffected), proving the pin discriminates the specific denial and not the whole route.

### 2. Pin the `<?xml`-prefixed SVG positive (Pin 2)

Three new unit cases in `sanitize-svg.test.ts` (append-only `describe` block; the file
gains a `sniffBrandingFormat` import):

- detection stays `svg` for an `<?xml`-prefixed SVG (the declaration does not confuse
  `sniffBrandingFormat`);
- sanitization **retains the leading `<?xml version="1.0" encoding="UTF-8"?>`
  declaration byte-identical** (`output.startsWith(declaration)` and the declaration
  occurs at offset 0 — the chosen behaviour; stripping was considered and rejected, the
  declaration is inert markup and dropping it would corrupt a browser's parse for no
  security gain);
- no `<script>` payload survives in the sanitized `<?xml`-prefixed output.

The mutation probe rewrites the processing-instruction branch so the `<?xml`
declaration is dropped; the retention case reddens with
`AssertionError: expected false to be true`, the script-removal case stays green —
proving the pin pins retention and not the whole sanitizer.

## Evidence at the pins head

Both suites are **green** against the merged trunk (`origin/main` `c055cac`, with the
OP-114 squash `87e1170` an ancestor):

- unit `sanitize-svg.test.ts` — **8 passed (8)** (5 pre-existing + 3 new);
- integration `branding-upload.test.ts` — **14 passed (14)** (11 pre-existing + 3 new).

Mutation probes (each applied to the production file, the focused spec run, then the
file restored and confirmed `sha256`-identical with `git diff` empty):

1. **Pin 1** — `throw appError("not_found")` → `throw appError("forbidden")` in the
   no-organizer branch of
   `apps/web/src/app/api/v1/events/[eventId]/assets/branding/route.ts` →
   `AssertionError: expected 403 to be 404` on the no-organizer case (1 failed | 13
   skipped). Restored byte-identical.
2. **Pin 2** — `sanitize-svg.ts` drops the `<?xml` processing instruction →
   `AssertionError: expected false to be true` on the retention case (1 failed | 7
   passed). Restored byte-identical.

`npx prettier --check` is clean and `eslint` reports 0 problems on the two touched
files. No production code was changed; the other two frozen OP-114 spec files
(`branding-type.test.ts`, the e2e `branding-upload.spec.ts`) are untouched, and the two
edited files' pre-existing assertions are byte-identical (append-only changes).

## Consequences / notes

- **No new contract.** Both behaviours shipped in ADR-0541; this record only upgrades
  two previously-unpinned observations into pins and records the mutation evidence.
- **The worktree move.** The three sibling follow-up cards (OP-112/113/114) were all
  created against the same shared worktree `/root/openpic/openpic-webapp/.worktrees/t_c103668d`;
  the OP-113 sibling switched that worktree's branch while this card was mid-run, so
  the work was completed in a fresh worktree `/root/openpic/openpic-webapp/.worktrees/t_630fbbd8`
  at the same `origin/main` head (per the card's explicit allowance) and the shared
  worktree was restored to the siblings' state.
- **Number allocation.** OP-114 holds `0540`–`0559`; `0540` (RED) and `0541` (GREEN)
  are consumed, so this record takes **`0542`** — the lane cell's value re-read from
  `docs/adr/README.md` immediately before committing. The cell advances to **`0543`**.
  The reserved-range row, the ADR index row and this note are the only README edits;
  `docs/adr/README.md` remains the shared-ledger hotspot (union-resolve at merge per
  ADR-0300 §8.10).
