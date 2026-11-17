# ADR-0622 — OP-118 review round 1: the QR cache hides the work and is kind-scoped

- **Status:** Accepted
- **Date:** 2026-11-03
- **Ticket:** OP-118 (Events epic, phase 3 — Events & Collaboration)
- **Card:** `t_0be9980d` (tdd_stage TEST, test author; follow-up to the review of
  the GREEN `t_5a121a37`)
- **Branch:** `OP-118-task-qr-cache-pins` (worktree
  `/root/openpic/openpic-webapp/.worktrees/t_0be9980d`, off `origin/main` after
  the PR #385 squash `1aeca52`)
- **Supersedes nothing.** Consumes `0622` of the OP-118 lane range `0620`–`0639`
  (ADR-0300 §7); the preceding records are
  [ADR-0620](ADR-0620-op118-access-links-qr-red.md) (the pins contract) and
  [ADR-0621](ADR-0621-op118-access-links-qr-green.md) (the GREEN).

## Context

Review round 1 of the OP-118 GREEN found two defects in
`GET /api/v1/events/{eventId}/access-links/{slug}/qr` that the shipped pins
could not see:

- **F2 (Medium, performance).** The route rendered the image _before_ consulting
  the cache (`renderQrCode(...)` ran unconditionally, then the content hash was
  looked up). The cache therefore saved storage but no work: every download paid
  the `qrcode` render, and a PDF paid `pdf-lib`'s embed + save as well.
- **F3 (Low, correctness).** Both the cache read and the upsert matched
  `{ tenantId, contentHash }` without `kind: "export"`, so a `mediaAssets` row of
  another kind holding byte-identical content was reused as the QR cache and
  stamped with `qrUrl`/`qrExpiresAt`.

This card adds two pins for those behaviours. It writes **test files only** — no
production change. The GREEN that must satisfy the pins is the pre-created child
`t_d0ac3946`.

## Decision

### The pins

Both live in the existing `apps/web/src/test/integration/event-access-links.test.ts`
(now 16 cases; the original 14 are untouched) under the describe block
`… the cache hides the work, not only the write (OP-118 review round 1)`:

- **F2** — one event, one `(slug, format, size)` requested twice; the renderer is
  spied with `vi.spyOn(qrRenderer, "renderQrCode")` on the
  `@/server/events/access-link-qr` **module namespace**. This was measured, not
  assumed: the spy genuinely intercepts on this tree (the buggy trunk reports
  `expected "renderQrCode" to be called 1 times, but got 2 times`). The two
  answers are asserted `200` and the renderer **once**. The byte-identical body
  is deliberately **not** re-asserted here — `I2` already pins it with a whole-body
  `toEqual`, and the card asked not to duplicate that set.
- **F3** — one event and an unrelated `mediaAssets` row with
  `kind: "thumbnail"` and the **exact content hash of the QR bytes**. The request
  answers `200` naming that hash in its signed URL, and the thumbnail row is
  re-read: its `kind` is still `"thumbnail"` and it carries no `qrUrl` /
  `qrExpiresAt`.

### Why the F3 fixture must be byte-identical, and the card wording it corrects

The card's step 3 also said to assert that "the row whose `contentHash` the
answer's URL names is `kind: "export"`". That is **unsatisfiable** in the F3
scenario, and the fixture therefore pins the observable that _can_ hold:

- The unique index is `media_assets_tenant_content_hash_unique` on
  `(tenantId, contentHash)` — **not** scoped by `kind`
  (`apps/web/src/server/db/indexes.ts`). A thumbnail row holding the QR bytes
  therefore occupies the only slot that hash can ever occupy, so **no** `export`
  row with that hash can coexist. Asking for one is a contradiction.
- The bug only fires when the hashes are equal — an arbitrary 64-hex thumbnail
  hash is invisible to the buggy `findOne({ tenantId, contentHash })`, so a pin
  built on it would be **green on the buggy trunk** and worth nothing. The
  byte-identical fixture is the one that reproduces the rewrite the review found
  (`expected 'https://pic.openpic.in/o/…' to be undefined`).

The pins stay behavioural: F3 asserts the foreign row is neither consumed nor
rewritten, which is exactly the defect, without depending on how the fix keys its
cache.

An earlier draft also asserted a whole-collection
`countDocuments({ qrUrl: { $exists: true } }) === 0`. It was dropped: it is only
true for one fix shape (swallow the `E11000` and leave no `export` row), so a
legitimate alternative — scope the unique index by `kind` and let the `export`
row insert — would have failed a correct implementation. The two direct stamps
on the foreign row already discriminate the bug (they are set on the buggy trunk,
absent once the row is not matched), so the collection-wide proxy added risk
without adding signal.

## Evidence at handoff

- Focused spec at the pins head (buggy trunk):
  - F2 — `AssertionError: expected "renderQrCode" to be called 1 times, but got 2 times`
  - F3 — `AssertionError: expected 'https://pic.openpic.in/o/f54025ef…' to be undefined`
  - `Tests  2 failed | 14 passed (16)`, every failure assertion-level.
- **Satisfiability probes** (throwaway edits to `route.ts`, each restored
  byte-identically — SHA-256 re-checked and `git diff` empty afterwards):
  - kind-scope both filters **and** absorb `E11000` on the upsert → **F3 green**,
    F2 still red (`— 1 passed | 1 failed`), i.e. F3 is satisfiable and its fix
    necessarily also handles the racing-upsert `E11000` the card names as F4.
  - read the cache by a render-free `qrCacheKey` **before** `renderQrCode` →
    **F2 green**, F3 still red (`— 1 passed | 1 failed`), i.e. F2 is satisfiable
    by the render-free key the GREEN card prescribes.
- `prettier --check` clean; ESLint 0 errors on the spec (one pre-existing
  `security/detect-object-injection` warning in the untouched `requireHandler`
  helper); the ADR-numbering guard green.

## Consequences

- The GREEN (`t_d0ac3946`) must make F2 green by consulting a render-free cache
  key **before** rendering, and F3 green by scoping both the read and the upsert
  to `kind: "export"` while absorbing the `E11000` the kind-scoped insert now
  provokes (the thumbnail occupies the unique slot). The two fixes are
  independent; each probe above isolates one.
- No new contract is introduced; the answer's key set, status codes and signed
  URL are unchanged. This record documents only the pin upgrade and its mutation
  evidence.
- `docs/adr/README.md` is the shared-ledger hotspot: the lane's `Next free` cell
  advances from `0622` to `0623` and merges as a union keeping the highest cell.

## Open items for the GREEN

1. If the cache key is a new `mediaAssets` field (e.g. `qrCacheKey`), it is
   additive and tenant-scoped; record the choice in a new lane ADR (`0623`+).
2. The F3 pin requires the racing-upsert `E11000` to be absorbed even on a
   single request, because the seeded foreign row already holds the unique key.
   A plain catch-and-retry that leaves no `export` row is acceptable — the pin
   only requires a `200` and an untouched foreign row.
