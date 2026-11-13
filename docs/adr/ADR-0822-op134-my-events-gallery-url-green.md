# ADR-0822 — OP-134 GREEN: `GET /me/events` answers `galleryUrl: ""` when the event has no active access link

- **Status:** Accepted
- **Lane:** the shared attendee block `0780`–`0798` is exhausted, so this
  record draws from the `unallocated (future lanes)` pool — the
  [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md) precedent. At
  this head both `Next free` cells read `0820`, while `0820` is in flight on
  `origin/OP-132-task-confirm-tx-failure-pin` (`ADR-0820-op132-confirm-transaction-failure-pin.md`)
  and `0821` on `.worktrees/t_edad86b6`
  (`ADR-0821-op132-confirm-burst-pin.md`), so under
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 this record
  draws **`0822`** and both cells advance to `0822`.
- **Satisfies:** the four pins of
  [ADR-0819](ADR-0819-op134-my-events-gallery-url-pin.md)
  (`apps/web/src/test/integration/my-events-gallery-url.test.ts`), carried onto
  this branch unchanged: **F4a** `accessLinks: []` → `slug: ""` and
  `galleryUrl: ""`; **F4b** a dead `active: false` link → the same pair; **F4c**
  the claim's `""` answer for the same fixture, recorded as the reference; **F4d
  control** one active-link fixture through both §6.7 surfaces, so a fix cannot
  pass by emptying every URL.
- **Amends:** nothing. [ADR-0819](ADR-0819-op134-my-events-gallery-url-pin.md)
  is a RED pin record and is not edited; nor is ADR-0815, whose §5 sentence this
  GREEN completes for the no-active-link arm.
- **Consumes:** `0822`.

## Context

The two §6.7 surfaces derive the same path two different ways.
`cross-tenant.ts` reduces the event's access links to the first `active: true`
slug and defaults a miss to `""`; the claim then asks
`slug === undefined ? "" : \`/e/${slug}/gallery\`` (`claim.ts:117-120`), while the
list interpolated the projection's `""` unconditionally
(`route.ts:90`, `/e/${item.slug}/gallery`). One fixture — a caller's own
`subject.kind: "user"`profile on an event with no active link — therefore
answered`""`on the claim and`"/e//gallery"` on the list, a path no route
serves.

## Decision

1. **The list applies the claim's rule to the slug it already holds.** One line:

   ```ts
   galleryUrl: item.slug === "" ? "" : `/e/${item.slug}/gallery`,
   ```

   `slug` keeps the raw active slug (`""` when there is none, contract §6.7); the
   projection, the `z.string()` schema and the thirteen keys are unchanged, so no
   client learns a second shape and no key becomes nullable.

2. **The claim is not touched.** It already answers `""` (`F4c`), and it is the
   representation F4a/F4b pin the list to.
3. **The reachable arm is untouched.** A non-empty slug still answers
   `/e/{slug}/gallery`, which F4d asserts against the claim's own
   `claimed[].galleryUrl` for the same fixture.

## Evidence — measured on this branch (`OP-134-task-me-events-gallery-url-empty`)

- **RED before the change**, carried from the pin branch `320077e`:
  `Tests 2 failed | 2 passed (4)`, both `AssertionError: expected '/e//gallery'
to be ''`.
- **GREEN after the change**: the pin file `4 passed (4)`, and together with the
  two frozen neighbours `my-events.test.ts` + `attendee-claim.test.ts`,
  `3 passed (3)` files / `18 passed (18)`.
- The spec file, its helpers and every fixture are byte-identical to `320077e`
  (`git diff 320077e -- apps/web` is the one route line).

## Consequences

- The two §6.7 answers converge on one representation with one line changed; a
  client that shows "open gallery" must treat the empty string as "no gallery",
  which is exactly what the claim already requires of it.
- The list keeps deriving the path from the slug rather than from the event row,
  so the two surfaces still hold two copies of the rule; a third surface adding
  a gallery URL should reuse the claim's `galleryUrlOf` rather than a template.
