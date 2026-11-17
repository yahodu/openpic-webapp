# ADR-0819 — OP-134 TEST (F4, Low): one `galleryUrl` representation for an event with no active access link

- **Status:** Accepted (RED pin record — the GREEN `t_e9bc6c07` is owed)
- **Consumers:** `apps/web/src/test/integration/my-events-gallery-url.test.ts`
  (the four pins) and the single line they constrain,
  `apps/web/src/app/api/v1/me/events/route.ts:90`, plus
  [ADR-0815](ADR-0815-op134-attendee-claim-green.md) §5, whose `galleryUrl`
  sentence this record completes for the no-active-link arm.
- **Amends:** nothing. [ADR-0815](ADR-0815-op134-attendee-claim-green.md) is
  frozen and is not edited; this record resolves a case its §5 left unstated.
  **Amended by:** nothing yet.
- **Consumes:** `0819` (both `Next free` cells advance to `0820`).
- **Base:** `origin/main` `fdff81c`, which contains the OP-134 GREEN squash
  `0d57e95` (tree `6afce2f5…`, identical to the reviewed head `967d928`) and the
  OP-132 retention-gate fix `442e01a`.
- **Card:** `t_53eb3bdf` (parent `t_135c11ae`, OP-134 GREEN round-1 review,
  finding **F4**).

## Context

OP-134's GREEN shipped the two §6.7 surfaces that describe the same
participation: the assertion `POST /me/attendee-sessions:claim` and the listing
`GET /me/events`. The round-1 review measured them disagreeing on one fixture —
a caller's own `subject.kind: "user"` profile whose event carries no
`active: true` access link:

```
GET /api/v1/me/events -> 200
{"slug":"","galleryUrl":"/e//gallery", ...}
```

`/e//gallery` is not a path any route serves: the review's probe, reproduced
here at `fdff81c` on the same fixture, fails the new pin with

```
AssertionError: expected '/e//gallery' to be ''
```

The cause is a projection and a template that disagree about what "no active
link" means. `cross-tenant.ts:442` takes the first `active: true` link's slug and
defaults a miss to `""` (`cross-tenant.ts:451`), while `route.ts:90` then
interpolates that value unconditionally, `/e/${item.slug}/gallery`. The claim's
own answer for the same event is `galleryUrl: ""` (`claim.ts:117-120`:
`slug === undefined ? "" : …`), so one of the two answers is a malformed URL and
the product states the same fact twice, differently.

## Decision

### 1. `galleryUrl` is the empty string when the event has no active access link

The pin asserts `galleryUrl === ""` on `GET /me/events` for two fixtures: an
event whose `accessLinks` is `[]`, and an event whose only link is a
dead/rotated-away one (`active: false`). The empty string wins over `null`
because:

- it is the representation the other §6.7 surface **already ships**, so the two
  answers converge with one line changed and no caller learning a second shape;
- §6.7 shows a path only when the gallery is reachable — an event with no active
  link has no gallery address to show;
- the §6.7 item is the thirteen documented keys with `z.string()` for this one,
  and the "it's a string, non-nullable" contract is what a client branches on
  (`galleryUrl === ""` means "no gallery yet"), so a `null` would be a wider
  change — schema, response type and every consumer — for no observable gain.

`slug` stays `""` in the same answer. It is the raw active slug (§6.7), not a
derived address, and inventing one would hide the same absence two different
ways.

### 2. The control keeps the active-link answer pinned on **both** surfaces

A fix that emptied every `galleryUrl` would satisfy the two pins above and break
the product, so the third case drives one fixture with an active link through
both endpoints: the claim re-points the anonymous profile, and then the list
must describe that same row as `slug: <slug>` /
`galleryUrl: /e/<slug>/gallery`. The two answers are asserted against one shared
`expected` value, so they cannot drift apart again without a red case.

### 3. The claim is not to be changed

The fourth case records the claim's own answer for the no-active-link fixture
(`""`), so the GREEN has a written reference for the representation and cannot
"solve" the disagreement by teaching the claim to emit a URL. It is green on the
trunk today; it exists to keep the direction of the fix unambiguous.

## Evidence

Measured on the pins branch, `origin/main` `fdff81c` + this spec only:

| pass                                                               | result                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| trunk, focused                                                     | `Test Files 1 failed (1)` / `Tests 2 failed \| 2 passed (4)` — both failures `expected '/e//gallery' to be ''` |
| near-fix (`` item.slug === "" ? "" : `/e/${item.slug}/gallery` ``) | `4 passed (4)`                                                                                                 |
| weak fix (`galleryUrl: ""` unconditionally)                        | `1 failed \| 3 passed (4)` — the control fails `expected '' to be '/e/op134-f4-control000004/gallery'`         |

Both mutations were applied to `route.ts` from a scratch backup and reverted;
the restored file is byte-identical (`sha256
2d39b6683dec0238892b52263f3b73e97a34f6a9bc862e64da9678974ac37e88` before and
after, `git diff --stat` on the route empty). The near-fix pass proves the pins
are satisfiable in one line; the weak-fix pass proves the control is
load-bearing rather than decoration.

The two frozen neighbours stay green: `my-events.test.ts` and
`attendee-claim.test.ts` run `16 passed` alongside this file's two red pins
(`Test Files 1 failed | 2 passed (3)`). `tsc -p apps/web/tsconfig.json` exits
`0` and `eslint` reports `0` problems on the new spec.

The fixture is seeded rather than driven because no shipped route can produce
the state: an event is created with one active link and the attendee routes
resolve the event **through** it (§1.5). Where a session is needed the case
creates the real session first and revokes the link afterwards, which is the
shape the claim itself understands.

## Consequences

- The GREEN is one conditional at `route.ts:90`; the response schema, the
  projection and the thirteen keys are unchanged (`""` is a valid `z.string()`).
- A client must treat `galleryUrl === ""` as "no gallery address": render the
  absence rather than navigating to `""`. The claim already required that.
- The other §6.7-adjacent surface, `GET /p/events/{slug}/me`, is unaffected: its
  slug is the path parameter that resolved the event, so it always has an active
  link by construction.
- `slug: ""` with `galleryUrl: ""` is now the documented "event not reachable"
  pair; a later lane that adds a second access link or rotates one does not
  change it.

## Alternatives

- **`galleryUrl: null`.** Rejected: it would change the item's type and diverge
  from the claim, which is the disagreement being fixed. Recorded here as the
  alternative the card allowed, with the reason it lost: two surfaces agreeing
  is worth more than a nicer "absent" type, and the schema's `z.string()`
  already promises a string.
- **Keep `/e//gallery` and make the client detect it.** Rejected: the server
  ships a path that no route serves, and every client would have to re-derive
  the empty-slug rule — the duplication this pin removes.
- **Suppress the item entirely when the event has no active link.** Rejected:
  the attendee still attended that event, and §6.7's list is a participation
  record, not a navigation menu. `matchCount`, `status` and the retention stamp
  remain meaningful with no reachable gallery.
- **Pass `null` from the projection instead of `""` from the route.** Rejected:
  the projection is the whitelisted cross-tenant read and its `slug` is a raw
  §6.7 field; the address is the route's to derive, and it is the route that
  owns this defect.
