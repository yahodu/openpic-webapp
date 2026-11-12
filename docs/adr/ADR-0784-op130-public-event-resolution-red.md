# ADR-0784 — OP-130 RED: public event resolution (`GET /api/v1/p/events/{slug}`)

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-130 RED specs —
  `apps/web/src/test/unit/public-event-format.test.ts` (U1),
  `apps/web/src/test/unit/public-event-state.test.ts` (U2),
  `apps/web/src/test/integration/public-event-resolution.test.ts` (I1–I5 + the
  §0.11 class pin) and `apps/web/e2e/public-event-resolution.spec.ts` (E1)
- **Lane:** OP-130 (epic Attendee Surface), a dependent ticket of OP-129. The
  number is taken **above every in-flight reservation** of the shared attendee
  block per CONVENTIONS §11 rule B: `0769`/`0770` are landed on this branch,
  `0771`/`0772` are committed on the OP-128 uploads lane
  (`t_133a4093`), `0782` twice on the two OP-129 follow-up pins branches
  (`t_4f95a931` / `t_a377ab74`) and `0783` in the live OP-129 resolver worktree
  (`t_a909e641`).
- **Supersedes:** nothing. **Amended by:** the OP-130 GREEN ADR (implementation
  choices left open here).
- **Consumes:** `0784` (`Next free` advances to `0785`).

## Context

The epic's user story is _\"As an attendee who scanned a QR, I want the event page
to render from one call so that I can start quickly.\"_ Contract §6.1 already
specifies the whole surface: one `public` GET keyed on the event's **active**
access-link slug, `Cache-Control: private, max-age=30`, rate `public.gallery`, a
body with exactly six sections, and a five-row error table. Schema §15.1 owns the
stored event (canonical UTC `startAt`, `displayTimeZone` as a display preference,
`accessLinks[]` with `active`/`revokedAt`, `retentionExpiresAt`).

Two properties make this the platform's most dangerous read:

1. **It is unauthenticated and cross-tenant.** The slug is the only secret, and it
   resolves to an event the caller can prove nothing about. Everything that must
   _not_ be answered — an unpublished event, a rotated-away slug, an event being
   purged — is a statement about what a stranger may learn.
2. **It must be complete in one round trip.** A second call for the logo or the
   local start time is a second chance to fail on a phone at a wedding.

The coverage gap this RED closes is the mapping itself. OP-118 shipped the
rotation that revokes a link and OP-129 shipped the attendee session; neither
pins what the _landing_ call answers for each state of the event and the link.

## Decision

### 1. The pure modules the specs import

```
apps/web/src/server/attendee/public-event.ts
  formatStartAtLocal(startAt: Date, timeZone: string): string
  resolvePublicEventOutcome(facts: PublicEventFacts): PublicEventOutcome
```

`formatStartAtLocal` is a pure function of `(instant, zone)` — no clock, no
database, no configuration — and returns an RFC 3339 local date-time with a
**numeric** offset (`YYYY-MM-DDTHH:mm:ss±HH:MM`, no milliseconds, no `Z`), the
wall clock being the instant's clock in `timeZone` and the offset being that
zone's offset **at that instant**. U1 pins Asia/Kolkata's `+05:30` (a half-hour
offset survives) and both sides of the 2026 America/New_York spring-forward and
fall-back transitions, so an offset cache keyed on the zone rather than on the
instant cannot pass. `Intl.DateTimeFormat` with `timeZone` and an explicit
`formatToParts` projection is the intended mechanism (the GREEN card names it);
`startAtLocal` is **not** derived from the browser.

`resolvePublicEventOutcome` is the §6.1 state machine as data:

```ts
interface PublicEventFacts {
  link: "active" | "revoked" | "unknown";
  status: PublicEventStatus | null; // null when the link is unknown
  now: Date;
  retentionExpiresAt: Date | null; // null = unbounded
}

type PublicEventOutcome =
  | { kind: "error"; status: 404 | 410; code: "not_found" | "access_link_revoked" | "event_gone" }
  | { kind: "ok"; galleryOpen: boolean; galleryExpiredAt: Date | null };
```

The precedence is the contract's own row order and is pinned as such:

| #   | Condition                         | Outcome                                                                                                                                                                |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the slug names no link            | `404 not_found`                                                                                                                                                        |
| 2   | the slug names a **revoked** link | `410 access_link_revoked` (whatever the event's status)                                                                                                                |
| 3   | the event is `draft`              | `404 not_found` (an unpublished event is indistinguishable from a slug that never existed)                                                                             |
| 4   | the event is `deleting`           | `410 event_gone`                                                                                                                                                       |
| 5   | otherwise                         | `ok`, gallery open while `now < retentionExpiresAt` (inclusive expiry), `galleryExpiredAt` = the retention instant once it has elapsed, `null` while open or unbounded |

Row 2 before row 3 is deliberate and pinned: the QR the attendee holds is dead,
and the answer must not depend on whether the organizer also unpublished the
event. Rows 1 and 3 are pinned to be **byte-identical** at the wire (I1), because
any difference is an unpublished-event oracle.

### 2. The route

```
GET /api/v1/p/events/:slug     auth `public`
                               rate `public.gallery`
                               Cache-Control: private, max-age=30
```

`defineRoute({ route: "/api/v1/p/events/:slug" })` with **no** auth stage; the
slug is read off `request.url` (a dynamic handler invoked directly in the
integration suite sees no Next `params`). The slug resolves through
`events.accessLinks[].slug` where the link is `active` — never through
`accessLinks[0]`, so a rotated array order cannot serve the wrong link.

The `200` body is exactly the §6.1 six keys (`slug`, `event`, `gallery`,
`selfie`, `consent`, `session`) with the contract's own inner keys, plus
`event.description` (§ below). Refusals are the §10.4 envelope with `error` as
the only top-level key, and `access_link_revoked` carries `details.message` =
_\"This QR code is no longer valid. Ask the organizer for the current link.\"_
verbatim.

`:slug` is **not** pinned as a 24-hex value or a length range: contract §6.1's
example is `k7m2xq9p`, and the rotation owns the alphabet. The pins use unknown
slugs that cannot collide with a seeded one.

### 3. `logoUrl`, `selfie`, `consent`, `session`

- `event.logoUrl` is the **`thumbnail`** derivative of the event's
  `logoAssetId` signed by `@/server/media/signer` (`/t/<contentHash>.<ext>?exp=…&sig=…`),
  and I4 **verifies** the signature with the configured secret rather than
  pattern-matching it, then asserts the answered hash is the seeded asset's
  content hash. No logo → `logoUrl: null` (never `""`, never a broken URL).
- `event.description` **is** part of the body although the §6.1 appendix
  interface omits it: this card (I4) requires it and the landing page renders it
  (handoff §Open questions records the doc gap).
- `event.organizerDisplayName` is the tenant's `name` (schema §11.1) — not a
  user's display name.
- `selfie` is the §6.1 rules object; `attemptsUsed` is `0` for a caller with no
  profile. Deriving a non-zero `attemptsUsed` needs the `selfies` rows that
  OP-131 owns, so it is **out of scope** here (handoff §Out of scope).
- `consent` is the current biometric policy spec with `granted: false` for a
  caller who has not granted it; `policyVersion`/`policyUrl` come from settings,
  so the pins assert shape, non-emptiness and an `https` URL, never a literal
  version string.
- `session.hasProfile` is whether an `attendee_event_profiles` row exists for
  **this** event and **this** subject. It is `false` for a caller with no
  credential and for a fresh anonymous session, `true` once a profile row exists,
  and `canClaimByLogin` is `true` for an anonymous session (claiming keeps the
  profile; schema §15.3).

### 4. What the pins refuse to observe

- **No `_id`, tenant id or asset id in the body.** I3 runs the shared
  `findForbiddenFields(body, "attendee")` scanner (§0.15) **and** asserts by
  value that neither the tenant's nor the logo asset's hex id appears anywhere in
  the serialized body — a key-name scan cannot see an id that leaks under an
  innocent key.
- **A lapsed attendee cookie still renders.** §6.1 declares the route `public`
  and its error table is closed — there is no `401` row — so a stale `op_att`
  cookie must degrade to `session.kind: "anonymous"`, `hasProfile: false` and a
  `200`. Turning a dead cookie into a refusal would strand an attendee on a
  screen with no way forward.

### 5. Assumptions (contract or schema is silent)

- `archived` **renders**: §6.1's error table is closed and names only unknown,
  revoked, draft and deleting/purged.
- A **purged** event is indistinguishable from a slug that never existed (nothing
  is left to look up), so the `410 event_gone` row is only observable in the
  `deleting` state. Reaching the purged half needs a tombstone this schema does
  not have.
- `gallery.expiresAt` is the configured retention instant in **both** states;
  `gallery.expiredAt` is **added** once retention has elapsed (the appendix types
  `expiresAt` as required and `expiredAt` as optional). Unbounded retention →
  `expiresAt: null`, `open: true`.
- `gallery.indexingComplete` is `processedImageCount + failedImageCount >=
imageCount` over the event's cached counters — \"nothing is still waiting\".
- The retention comparison is **inclusive**: open at `retentionExpiresAt − 1 ms`,
  closed at `retentionExpiresAt`, matching the TTL semantics the rest of the
  platform uses.
- Whether a `GET` stamps `accessLinks[].scanCount` is **not** pinned: this is a
  read contract and §6.1 does not say the landing call counts as a scan.
- The §0.11 class is pinned by its **wire signature**, not by an import: a
  landing call that carries a client address (the class's `ip` rule is 600/min,
  unique to `public.gallery`) must answer `RateLimit-Limit: 600` and
  `RateLimit-Remaining: 599`. A route that mounts no stage answers no headers; a
  route on the wrong class answers the wrong number.

## Consequences

- The GREEN owes `@/server/attendee/public-event` (both exports), the route
  module, the §0.11 stage, and the §6.1 transport wiring. Nothing else in the
  repository is presupposed by the pins.
- The state machine being pure is what makes the matrix (7 refusal rows × 5
  window rows) affordable: U2 needs no database, no clock and no request, and the
  route only has to _read_ the facts and _project_ the outcome. A GREEN that
  instead branches inline in the handler must duplicate the table in tests or
  lose the matrix.
- The refusal pins are negative-first. `I1` asserts that a draft and an unknown
  slug agree on code **and** message, and that no refusal body carries the event
  name or id; the strongest mutation a future refactor can make (answering `404`
  with a helpful message) is therefore loud.
- `startAtLocal` lives on the server on purpose: contract §6.1 says the attendee
  page needs no timezone library. If a later card moves formatting to the client,
  U1 is the record of what the server promised.

## Evidence (this RED)

- **Honest RED, delivered state:** `Cannot find package '@/server/attendee/public-event'`
  for both unit specs and `Cannot find package '@/app/api/v1/p/events/[slug]/route'`
  for the integration spec (`no tests` in all three files — the modules do not exist).
- **Type-correct:** with two throwaway stubs (the pure module and a near-fix route
  handler) `npx tsc -p apps/web/tsconfig.json --noEmit` exited `0`.
- **Satisfiable:** against those stubs the unit project ran **27 passed (27)** and
  the integration spec **32 passed (32)** on a real `MongoMemoryReplSet`.
- **The pins bite** (each mutation assertion-level, every stub restored by `sha256`
  before deletion):
  - a fixed `UTC` zone in `formatStartAtLocal` → `11 failed | 16 passed (27)`,
    beginning `expected '2026-11-14T12:00:00+00:00' to be '2026-11-14T17:30:00+05:30'`;
  - `draft` checked before `revoked` → the contract-order row fails
    (`expected { kind: 'error', status: 404, …(1) } to deeply equal { kind: 'error', status: 410, …(1) }`);
  - `>` instead of `>=` on the retention comparison → the inclusive-instant row fails;
  - a route resolving `accessLinks[0]`, mounting `read.normal` and omitting
    `description` → `5 failed | 26 passed (31)`, including
    `expected '300' to be '600'` and
    `expected [ 'displayTimeZone', 'endAt', …(7) ] to deeply equal [ 'description', …(9) ]`.
- **E1 is listed but not executable yet:** `npx playwright test --list -g "E1"`
  resolves it (`public-event-resolution.spec.ts:59:7`), and `next build` typechecks,
  so a RED branch cannot produce the standalone server the `api` project needs
  (ADR-0306). The GREEN's PR is where E1 runs.

## Alternatives

- **Return the raw `startAt` and let the browser format.** Rejected: §6.1
  explicitly pre-renders `startAtLocal` so the page ships no timezone data, and a
  device with a wrong clock or an outdated `tzdata` would render a wrong time for
  a wedding.
- **`416`/`403` for a rotated slug.** Rejected: §6.1 fixes `410
access_link_revoked` with a message the frontend shows verbatim, and the
  distinction from `404` is the whole point — \"get the current link\" versus
  \"wrong QR\".
- **Answer `200` with `gallery.open: false` and no `expiredAt` for a draft.** Rejected:
  a draft is not a closed gallery, it is a non-existent event to a stranger.
- **Pin the rate limit by importing `RATE_LIMIT_CLASSES` in the spec.** Rejected:
  that asserts the table (already pinned by `classes.test.ts`), not that this
  route mounts it — exactly the gap an earlier lane's review found.

## Open questions (for the GREEN)

1. `event.description` is not in §6.1's appendix `PublicEvent` interface. The
   pins require it; the appendix should be corrected rather than the route
   weakened.
2. `POST /p/events/{slug}/consent` (§6.2) is the only writer of `consent.granted`;
   this RED pins only the ungranted shape. A later card should pin the granted
   shape against a seeded `consents` row.
3. `selfie.attemptsAllowed` is pinned only as a positive integer (it comes from
   entitlements/settings, whose values are another lane's contract).
4. The purge tombstone question in §5 — if the platform ever wants a distinguishable
   `410 event_gone` for a purged event, it needs a schema decision, not a route
   one.
