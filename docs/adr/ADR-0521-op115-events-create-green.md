# ADR-0521 — OP-115 GREEN: create-event with materialised windows implemented (`POST /tenants/{t}/events`, `events:validate`, the three unit modules)

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-115 GREEN (`t_0b1499e7`) · **Branch:** `OP-115-task-create-event-windows` (pins head `04970e1`, itself off `origin/main` `a247a42`) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_0b1499e7`
- **Relates to:** [ADR-0520](ADR-0520-op115-events-create-red.md) (the RED contract this card implements unedited), [ADR-0340](ADR-0340-op103-entitlements-red.md) / [ADR-0341](ADR-0341-op103-entitlements-green.md) (`checkEntitlement`/`consumeEntitlement`), [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) / [ADR-0261](ADR-0261-op100-tenant-provisioning-green.md) (the tenant stage the routes ride), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) (the required-idempotency stage), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §4.1 (`POST /tenants/{tenantId}/events` + `events:validate`), §0.14 (entitlement enforcement), §0.9 (idempotency), Appendix A.2/A.4 · **Schema:** §15.1 (`events`), §15.2 (`eventMembers`/`event_organizers`), §14.2 (`usageCounters`) · **Doc:** `docs/API Contract.md` Part 4

## Context

The pins card (`t_9105710c`, ADR-0520) delivered a test-only RED across five
specs: three unit files (24 cases) pinning the window/slug/date units, one
integration spec (14 cases) driving the two route modules in-process against
MongoDB-memory-server, and one e2e journey (E1). This card is the GREEN half:
it implements the ADR-0520 contract exactly, ships the pins byte-unchanged, and
turns every **server-side** behaviour green. Two spec-harness defects block 11 of
the 14 integration cases from ever passing in the full file (section D below);
each is a test-side defect with the server behaviour independently proven.

## Decision

### P1 — Module contract (the three units, ADR-0520 §2.1)

`@/server/events/windows` exports `computeUploadWindowEndsAt(endAt, postUploadDays)`
(`null` in → `null` out; otherwise `endAt + days` whole days preserving the
time of day), `computeRetentionExpiresAt(endAt, retentionDays)` and
`computeDurationDays(startAt, endAt)` (`Math.ceil((endAt - startAt) /
86_400_000)`). `@/server/events/slug` exports the 31-char
`ACCESS_LINK_ALPHABET` (`abcdefghjkmnpqrstuvwxyz23456789`) and
`generateAccessLinkSlug()` (8 `node:crypto` `randomInt` draws). `@/server/events/dates`
exports `normalizeInstantToUtc(input)` (parse the RFC 3339 instant, re-serialise
with `.toISOString()`; throw on a non-instant). All three are pure — no clock or
database — exactly as the unit specs drive them.

### P2 — `POST /api/v1/tenants/{tenantId}/events`

`@/app/api/v1/tenants/[tenantId]/events/route.ts` exports `POST` declared
`defineRoute({ route: "/api/v1/tenants/:tenantId/events", body, response, auth,
tenant, idempotency, handler })` with `userAuth()`, `tenantStage({
provisionOnMissing: true })` and a **required** `idempotencyStage` (I6). The
handler:

- normalises both instants (U4 at the wire; a bundled `+05:30` input is stored
  and returned as the UTC `Z` instant) while `displayTimeZone` is stored
  verbatim as a display preference;
- refuses `endAt <= startAt` with `422 invalid_date_range` `{startAt, endAt}`;
  refuses a `displayTimeZone` that is not an accepted IANA name with the
  existing `unknown_timezone` refusal; refuses `startAt` older than 30 days with
  `422 start_too_far_past` (the ADR-0520 registry debt);
- checks the duration against `events.duration_days` via `checkEntitlement`
  and, when denied, answers `403 plan_limit_exceeded` with the **route-added**
  `requestedDays` field (the shipped `denialError` does not carry it; ADR-0520
  Appendix A.4) — the `402 payment_downgrade` variant passes
  `consumeEntitlement`'s own details through wholesale;
- resolves `postUploadDays` (request override or the entitlement default) and
  refuses an explicit `null` on a limited plan with `403 plan_limit_exceeded`
  naming `events.post_upload_days` (I12), while an unlimited plan materialises
  `uploadWindowEndsAt: null` (I13);
- resolves `gallery.retention_days` for the retention window;
- validates an explicit `logoAssetId` against `mediaAssets` (`{_id, kind:
"event_logo"}`) **within the tenant repo** so a foreign-tenant logo is a `422
validation_failed` `logoAssetId` field error (I8/I8b) — the description is
  sanitised to inert plain text (tags stripped; I9);
- opens **one transaction** (`withTransaction`): `consumeEntitlement` for
  `events.active` (+1), the `events` insert (embedded `accessLinks` with the
  generated slug, zeroed `counters.imageCount`, `status` by `publish`,
  `schemaVersion: 1`, `createdByUserId`), the single `event_organizers` row
  (`{tenantId, eventId, userId, role: "organizer", revokedAt: null}`), and the
  `event.created` outbox emit (`payload.eventId` = the new event id) — all or
  nothing;
- retries the slug inside the transaction loop on a duplicate-key (E11000)
  rejection from the unique partial `events.accessLinks.slug` index (I5), bound
  at 5 attempts;
- answers `201` via `created(body, "/api/v1/tenants/{t}/events/{id}")` with a
  quoted `ETag` (`/^"[^"]+"$/`) and the full Event DTO (`@/server/events/dto`:
  `id, name, status, startAt, endAt, displayTimeZone, description,
uploadWindowEndsAt, retentionExpiresAt, accessLinks[{slug, active}],
shareUrl (contains `/e/<slug>`, host = `config.app.baseUrl`), createdAt`).

### P3 — `POST /api/v1/tenants/{tenantId}/events:validate`

`@/app/api/v1/tenants/[tenantId]/events:validate/route.ts` (the literal-colon
folder, `me/sessions:revoke-all` precedent) exports `POST` with the same auth +
tenant stage and **no idempotency** (I10 sends a key anyway; the endpoint is
side-effect free). A **partial** body; the only pinned check computes the
duration from both instants when present and compares against
`events.duration_days` — over the limit it reports `{field: "durationDays",
ok: false, code: "plan_limit_exceeded", limit, upgradePath}`; the endpoint never
touches `usageCounters` or `events` (I10's seeded counter stays byte-for-byte
unchanged).

### P4 — The GET twin (e2e E1)

`@/app/api/v1/tenants/[tenantId]/events/[eventId]/route.ts` exports `GET`
(`userAuth` + `tenantStage`, tenant-scoped `events` lookup, `404` on miss or a
malformed id, `200` with the same Event DTO + `ETag`) — the e2e journey's
create-then-`GET` leg needs it (ADR-0520 §3 notes the read surface arrives with
OP-116; E1 still drives this one read).

### P5 — Registry debts (ADR-0520 §4)

`invalid_date_range` and `start_too_far_past` are appended to
`REQUEST_SHAPE_ERROR_CODES` (append-only, the `cannot_demote_owner` shape) and
to `REQUEST_SHAPE_ERROR_TRANSPORT` (both `422`, non-retryable). `INDEX_SPECS`
gains the unique **partial** index `{"accessLinks.slug": 1}` on `events`
(`partialFilterExpression: {"accessLinks.active": true}`) — I5's collision
retry runs on it.

### D — Two spec-harness defects (disputed, left red as written)

**D1 — the `plans` collection is never cleared between tests.** The spec seeds
plan rows by fixed key (`op115-starter`, `op115-active-limit-1`, `op115-pro-30d`,
…) from each case's own `seedPlan` into the one `startTestApp` database, with
`beforeEach` resetting only the slug mock. The OP-103 precedent spec clears
`plans` (and subscriptions/counters/grants/outbox) in a `beforeEach` `deleteMany`;
the OP-115 spec omits that cleanup. Consequently, once a key is seeded (I1 →
`op115-starter`, I2 → `op115-active-limit-1`, I10 → `op115-pro-30d`), every
later case that seeds the same key dies **at seed time** with `E11000
plans_key_unique` — before the route is even invoked (I3, I4, I5, I6, I7, I8,
I8b, I9, I11 all fail at `seedPlan`/`insertOne`, line 172). This is
unfixable from the server: no implementation can make a test's own `insertOne`
of a duplicate key succeed. Proof the behaviour was right: each of those cases
passes when run **in isolation** (I5 slug-collision retry, I6 idempotent
replay, I8b same-tenant logo, I9 inert HTML — all pass alone), and the plan
seeds in the full file collide exactly where the unique index exists.

**D2 — seven cases read the response body twice.** The helpers' `body()`
does `response.json()` (one-shot on a WHATWG `Response`), and the pattern
`errorCodeOf(response)` followed by `body(response)` on the **same** response
throws `TypeError: Body is unusable: Body has already been read` at the
second read (I2:412→413, I3:454→455, I4:479→480, I7:568→569, I8:601→602,
I11:750→751, I12:790→791). No `Response` a route returns can be parsed twice;
this is a harness defect. Proof the server behaviour was right: a throwaway
probe (deleted before handoff, replicating those seven cases with a **single**
body read) passed 8/8 against this implementation — `403 plan_limit_exceeded`
with `{entitlementKey: "events.active", limit, used, periodKey, scope, reason:
"plan_limit", upgradePath}`, `402 payment_required` with `{reason:
"payment_downgrade", pendingDueMinor, currency, payNowUrl}`, `422
invalid_date_range` `{startAt, endAt}`, `422 validation_failed` `description`
and `logoAssetId` field paths, `403` with `{entitlementKey:
"events.duration_days", limit: 30, requestedDays: 45}`, `403` naming
`events.post_upload_days`, and the validate `durationDays` check with the
counter untouched.

**Dispute boundary:** both defects are in the RED spec file
(`apps/web/src/test/integration/event-create.test.ts`) or its shared helpers —
not in the implementation and not in the contract the card states. Fixes
belong to the Test Author: (1) add the OP-103-style `beforeEach` `deleteMany`
for `plans` (and ideally `subscriptions` / `usageCounters` / `domainEvents` /
`events` / `eventOrganizers`, since `usageCounters` is also shared and I2/I3/I12
rely on a clean counter period), and (2) read the error body once per case
(capture `const parsed = await body(response)` and derive both the code and the
details from it) — the existing `errorCodeOf` helper makes the second `body`
redundant.

### D1/D2 repair (Test Author follow-up t_4916ad9c, landed on this branch)

Both harness defects above are fixed **test-file-only** in
`apps/web/src/test/integration/event-create.test.ts`; no production file
changed.

- **D1:** `beforeEach` is now async and clears the shared collections before
  every case — `plans`, `subscriptions`, `usageCounters`, `entitlementGrants`,
  `domainEvents` (the OP-103 precedent set, all present in `COLLECTIONS` so no
  new imports) plus `events`, `eventOrganizers` and `mediaAssets` so the
  "persists nothing" cases (I2/I3/I8/I11/I12) assert against a clean state and
  I5/I8b seed their fixtures fresh. `ensureIndexes(app.db)` still runs once in
  `beforeAll`; the unique `plans_key_unique` index now kicks in per-case as
  intended.
- **D2:** the seven double-read sites (I2/I3/I4/I7/I8/I11/I12) now parse the
  error body **once** — `const parsed = (await body(response)) as { error: {
code: string; details?: … } }` — and derive both `parsed.error.code` and
  `parsed.error.details` from that single read; the now-unused `errorCodeOf`
  helper was deleted (no case reads the body once afterwards, so it had no
  remaining call site).
- **Evidence:** the full integration project on this head is **729 passed
  (729) / 86 files** (the OP-115 file went from 11 failed | 3 passed to
  **14 passed (14)**); `tsc -p apps/web/tsconfig.json --noEmit` exit `0`,
  `eslint` and `prettier --check` clean on the touched file.

### D3 — CodeQL `js/insecure-randomness` in the RED e2e spec (disputed, left red)

GitHub default-setup CodeQL reports two **high** `js/insecure-randomness`
alerts in the pins' `apps/web/e2e/event-create.spec.ts`: the phone number E1
mints with `Math.random()` (line 29) flows into `POST /api/auth/phone-number/
send-otp` and `/verify` (lines 55/68) — a security context. The finding is in
the RED **Playwright spec** (a test file this GREEN may not edit), is present
unchanged at the pins commit `04970e1` (CodeQL analyses for that SHA also show
2 results), and is unrelated to any production line in this diff. Fix belongs
to the Test Author: derive the phone from a CSPRNG (`crypto.randomUUID()`,
already imported for the idempotency key, or `crypto.getRandomValues`). Note
the repo's own CodeQL Analyse jobs pass — only the default-setup alert record
on this file fails.

**Resolution (follow-up card `t_7db5345e`):** the spec now mints the E1 email
and phone from a single `randomUUID()` CSPRNG draw (`node:crypto`, same source
as the idempotency key) instead of `Math.random()` — the phone keeps the
`+91` + 9-digit format the previous line produced, and each run stays unique
for the `auth.otp` / `auth.verify` rate-limit buckets. Test-file-only change
(`apps/web/e2e/event-create.spec.ts`); no production code touched. Verified:
E1 passes against a standalone server built at this head, and `tsc` +
`prettier` are clean on the spec.

### P6 — gitleaks allowlist for the public alphabet constant

`secret-scan` (gitleaks, `generic-api-key` entropy heuristic) flags the 31-char
`ACCESS_LINK_ALPHABET` exported by `@/server/events/slug` and its mirrored
`SLUG_ALPHABET` copy in the integration spec as a secret. It is a **public
character set** documented in ADR-0520 (U3 pins its exact value), not a
credential, so the exact value joins the existing `.gitleaks.toml` allowlist
(the same treatment the docs' `modelKey` example and the OP-99 e2e fixture
literal receive). Verified: `gitleaks detect` over `04970e1..HEAD` → 0
findings.

## Consequences

- **Evidence at the head:** unit **24 passed (24)** on the three new specs; the
  full unit project **2073 passed | 3 skipped**; integration **718 passed |
  11 failed** — the 11 failures are the D1/D2 harness defects above and every
  one is proven satisfiable (8 probe + 4 isolation passes cover all 14 cases);
  `tsc` exit `0` on all three projects; `eslint` 0 errors on touched files (2
  pre-existing warnings elsewhere); `prettier --check` clean;
  `vitest run --project unit --project integration --coverage` exit `0` —
  208 files, **2799 passed | 3 skipped**, statements `92.04%`, branches
  `80.54%`, functions `96.26%`, lines `92.42%` (no threshold relaxed).
- **Pins preserved:** the five RED spec files and ADR-0520 are byte-identical
  to `04970e1` (sha-verified via `git diff`).
- **Ledger allocation (ADR-0300 §7):** the OP-115 lane row records
  `Next free = 0522` (this card consumes `0521`, the cell value re-read on the
  pins head `04970e1`); the unallocated pool stays `0540`+ on this branch —
  the OP-112/113/114 lanes hold `0560`+ on their merged heads, so at merge the
  README unions keeping the **highest** cells (`0560`+).
- **Under-constrained / open (for the Test Author's next cycle):** `publish:
false` → `draft`; the free-plan (no `events.post_upload_days`) window value;
  the `sequence` counter shape (initialised `1` here); `start_too_far_past`'s
  details shape (card names it, no case pins it); the validate happy-path
  `ok: true` check; a `postUploadDays` over the limit (only `null`-on-limited is
  pinned); slug-retry attempt bound (5 here).
