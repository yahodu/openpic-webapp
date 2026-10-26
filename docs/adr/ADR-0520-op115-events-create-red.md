# ADR-0520 — OP-115 RED: the create-event surface pinned — window/slug/date units, `POST /tenants/{t}/events` and the `events:validate` route

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-115 RED (`t_9105710c`) · **Branch:** `wt/t_9105710c` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_9105710c`
- **Relates to:** [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (the generic `checkEntitlement`/`consumeEntitlement` machinery this route's `events.active`/`events.duration_days`/`events.post_upload_days` checks run on), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) / [ADR-0261](ADR-0261-op100-tenant-provisioning-green.md) (the tenant stage + `ensureTenantForUser` the route rides), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-mandate-creation-green.md) (the required-idempotency stage pattern), [ADR-0009-op85-test-support-otp-route.md](ADR-0009-op85-test-support-otp-route.md) (the e2e sign-up harness the E1 journey reuses)
- **Contract:** §4.1 (`POST /tenants/{tenantId}/events`), §0.14 (entitlement enforcement), §0.9 (idempotency), Appendix A.2/A.4 (the `invalid_date_range` / `plan_limit_exceeded` rows) · **Schema:** §15.1 (`events`, embedded `accessLinks`), §15.2 (`eventMembers`/`event_organizers`), §14.2 (`usageCounters`) · **Doc:** `docs/API Contract.md` Part 4 (the Event DTO), `docs/Notification and Database Design.md` §15

## Context

OP-115 is the first card of the Events epic. The story: _as an organizer I create
an event with dates and a timezone so that I get a share link and an upload
window derived from my plan._ The card pins four units (window arithmetic with
the unlimited case, the duration ceil rule, the slug alphabet/length, the
offset→UTC instant normalisation), thirteen integration behaviours (the happy
path with its one-transaction row set, the plan-limit/402/422 refusals, the slug
collision retry, the idempotent replay, the description cap and sanitisation,
the foreign-logo refusal, the validate endpoint, the null-post-upload
semantics) and one e2e journey (sign-up → create → GET).

The card does not pin module paths, the DTO's exact field set, the error-code
mechanics, the collection names, or the index additions. This record fixes
those, because the gated GREEN card `t_0b1499e7` must implement them in one
pass.

## Decision

### Module contract (the four units)

```
@/server/events/windows
  computeUploadWindowEndsAt(endAt: Date, postUploadDays: number | null): Date | null
      // endAt + postUploadDays whole days; null in → null out (unlimited)
  computeRetentionExpiresAt(endAt: Date, retentionDays: number): Date
      // endAt + retentionDays whole days
  computeDurationDays(startAt: Date, endAt: Date): number
      // Math.ceil((endAt - startAt) / 86_400_000)
@/server/events/slug
  ACCESS_LINK_ALPHABET: string                 // "abcdefghjkmnpqrstuvwxyz23456789"
  generateAccessLinkSlug(): string             // exactly 8 chars from the alphabet
@/server/events/dates
  normalizeInstantToUtc(input: string): string // "…+05:30"/"…-05:00"/"…+00:00" → "…Z"; throws on a non-instant
```

The slug alphabet excludes the visually ambiguous `0`, `o`, `1`, `l`, `i`
(31 chars) — the card's "unambiguous alphabet" — and the width is 8, matching
the §4.1 worked slug `k7m2xq9p` and the tenant-slug precedent
(`@/server/tenancy/slug`). Uniqueness is the database's job (I5); the generator
is pure randomness.

### Route contract — `POST /api/v1/tenants/{tenantId}/events`

- File `@/app/api/v1/tenants/[tenantId]/events/route.ts` exports `POST`
  declared `defineRoute({ route: "/api/v1/tenants/:tenantId/events", … })`.
- Stages: `userAuth()` (the pinned specs create **complete** users — the e2e
  binds+verifies a phone number — so `user:complete` is satisfied, but a plain
  `user` guard also passes every pinned case), `tenantStage()` (with
  provisioning for a primary-less caller — the e2e E1 journey proves it), a
  **required** `idempotencyStage` (I6), and the route body schema.
- Success: `created(body, "/api/v1/tenants/{t}/events/{id}")` plus an `ETag`
  header whose value is a quoted opaque tag (`/^"[^"]+"$/`). The body is the
  Event DTO subset the specs assert: `id`, `name`, `status`
  (`published` when `publish: true`), `startAt`/`endAt` (UTC `Z` strings),
  `displayTimeZone` (the input verbatim — a display preference, never the
  instant), `description` (sanitized), `uploadWindowEndsAt`,
  `retentionExpiresAt`, `accessLinks[]` (one element, `{slug, active: true}`),
  `shareUrl` (contains `/e/<slug>`; the host is unpinned), `createdAt`.
- Windows are **materialised** at creation: `uploadWindowEndsAt = endAt +
entitlement("events.post_upload_days")` (the request's optional
  `postUploadDays` overrides the entitlement default; `null` is legal only on
  an unlimited entitlement and materialises `uploadWindowEndsAt: null` — I12
  vs I13) and `retentionExpiresAt = endAt + entitlement("gallery.retention_days")`.
- Refusals:
  - `endAt <= startAt` → `422 invalid_date_range`, details `{ startAt, endAt }`
    (Appendix A.2; the code is **not** in the shipped enum — the GREEN appends
    it in the `REQUEST_SHAPE_ERROR_CODES` shape with a 422 non-retryable
    catalog row, the `unknown_timezone` precedent).
  - `ceil((endAt - startAt) / 1 day) > entitlement("events.duration_days")` →
    `403 plan_limit_exceeded` with `details.entitlementKey ===
"events.duration_days"`, `details.limit`, `details.requestedDays` (45 for a
    45-day span) — the shipped `denialError` does not carry `requestedDays`, so
    the route must add it (Appendix A.4's optional field).
  - `events.active` at or over the limit → `403 plan_limit_exceeded`
    (`consumeEntitlement`'s own details shape, asserted wholesale) /
    `402 payment_required` with `reason: "payment_downgrade"` on a
    `downgraded` subscription.
  - `postUploadDays: null` on a limited plan → `403 plan_limit_exceeded`
    naming `events.post_upload_days`.
  - `description` > 2000 chars → `422 validation_failed`, fields path
    `description`.
  - `logoAssetId` that is not a `mediaAssets` row of `kind: "event_logo"` **in
    the same tenant** → `422 validation_failed`, fields path `logoAssetId`.
- Description sanitisation: tags are stripped, remaining text stays **inert**
  (I9 asserts the stored and returned value contain no angle brackets; whether
  `<script>`'s inner text survives is deliberately unpinned).
- The transaction (I1/I2): `consumeEntitlement` for `events.active`, the
  `events` insert (embedded `accessLinks` with the generated slug, `counters`
  zeroed — `imageCount: 0` is pinned — `status` by `publish`, schemaVersion,
  `createdByUserId`), the single `event_organizers` row
  (`{tenantId, eventId, userId, role: "organizer", revokedAt: null}` — the
  shipped collection, not the design doc's `eventMembers`; OP-114's route
  established the `event_organizers` row shape), and an `event.created` outbox
  emit whose `payload.eventId` names the new event — all-or-nothing, so a
  refusal persists nothing (I2/I3/I4/I7/I8/I11/I12 all assert zero event rows).

### Route contract — `POST /api/v1/tenants/{tenantId}/events:validate`

- File `@/app/api/v1/tenants/[tenantId]/events:validate/route.ts` exports
  `POST` declared `defineRoute({ route: "/api/v1/tenants/:tenantId/events:validate", … })`
  — the literal-colon folder precedent is `me/sessions:revoke-all`.
- Same auth + tenant stage, **no** idempotency (it consumes nothing; the spec
  sends a key anyway so either declaration is exerciseable).
- Partial body; `200 { checks: [{ field, ok, code, limit, upgradePath }] }`.
  The duration check is named `field: "durationDays"` and, for a span over the
  entitlement, `{ ok: false, code: "plan_limit_exceeded", limit, upgradePath }`
  (I10). The endpoint must not touch `usageCounters` or `events` — I10 seeds a
  counter and asserts it byte-for-byte unchanged.

### Registry debts the GREEN owes

- `REQUEST_SHAPE_ERROR_CODES` + catalog transport rows for `invalid_date_range`
  (422, `{ startAt, endAt }`) **and** `start_too_far_past` (422; details
  unpinned — the card names the refusal but pins no case for it).
- `INDEX_SPECS`: the `{"accessLinks.slug": 1}` unique **partial** index on
  `events` (`accessLinks.active: true`) — I5's seeded slug occupies a slot and
  the retried create must regenerate rather than overwrite or `500`.

## Assumptions and open questions

- **I12's code** is `plan_limit_exceeded` naming `events.post_upload_days`; the
  card fixes only the status (`403`). `details.requestedDays` is not asserted
  there.
- **The logo refusal shape** is the standard field error
  (`validation_failed`, `details.fields[].path === "logoAssetId"`), not a new
  catalogue code.
- **"Exactly one organizer"** is pinned against the real `event_organizers`
  collection (schema §15.2's `eventMembers` name is design-doc prose; the code
  registry and OP-114 both use `event_organizers` with `revokedAt`).
- **The plan seed is per-case**: each spec seeds its own `plans` row
  (`op115-starter`, `op115-active-limit-1`, …) rather than relying on
  `seedPlans`, mirroring the OP-103 entitlement spec.
- Open, deliberately **not** pinned: `publish: false` → `draft`; the
  `uploadWindowEndsAt` value when the plan carries no `events.post_upload_days`
  entitlement (the free plan — E1 asserts no window field); the `sequence`
  counter's shape; the `shareUrl`/`logoUrl` hosts and the signed-URL mechanics
  (OP-113's signer merges into the GREEN); the `validate` happy-path `ok: true`
  check shape; `start_too_far_past`; the slug retry's attempt bound.

## Consequences

- **Ledger allocation (ADR-0300 §7):** the OP-115 events lane draws `0520`–`0539`
  from the `unallocated (future lanes)` pool, the lane row records
  `Next free = 0521` (this card consumes `0520`), and the pool advances to
  `0540`+.
- **Known hotspot:** the in-flight OP-112/113/114 lanes (this card's own
  upstream dependencies, all unmerged) drew overlapping pool blocks on their
  branches; per OP-114's completion its merged head carries pool cell `0560`+
  and ADR-0541. At merge, `docs/adr/README.md` is union-resolved keeping the
  **highest** cells — the correct final pool value is `0560`+, and any ADR
  number collisions between lanes are renumbered by the orchestrator's union
  pass, never by a worker.
- **Evidence at the RED head** (throwaway stubs deleted before handoff,
  `git status` shows the five spec files only): `npx tsc -p
apps/web/tsconfig.json --noEmit` exits `0` with the stubs; assertion-level
  unit probe `14 failed | 10 passed (24)` — `expected '2026-11-14T17:30:00+05:30'
to be '2026-11-14T12:00:00.000Z'`, `expected null to deeply equal
2026-11-23T18:00:00.000Z`, `expected +0 to be 45`; integration probe
  `14 failed (14)` — `expected 500 to be 201/403/422/200/402`; e2e probe
  through a real `next start` (`pnpm build` + `--project=api`) reached the
  journey's own assertion with `Expected: 201, Received: 500` after the
  email-OTP sign-in, phone bind+verify, `/me accountCompletedAt` and CSRF'd
  create legs all passed — the strongest RED-by-design evidence available for
  the `user:complete` guard (the GREEN's PR is where the full journey turns
  green). ESLint `0 problems` and `prettier --check` clean on all five files.
- The gated GREEN card `t_0b1499e7` must base its branch on this pins branch
  (not bare `origin/main`) and merge the unmerged upstream lanes (OP-113's
  media signer, OP-114's branding upload) if its DTO needs them.
