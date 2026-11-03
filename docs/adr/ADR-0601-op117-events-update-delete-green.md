# ADR-0601 — OP-117 GREEN: update / archive / delete event implemented (PATCH + DELETE `/events/{e}`, `POST /events/{e}/archive`)

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-117 GREEN (`t_a6a8f636`) · **Branch:** `OP-117-feature-events-update-delete` (based on the pins head `e83d0e6`, itself the pins branch `OP-117-task-events-update-delete` merged with `origin/main` incl. OP-116) · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a6a8f636`
- **Relates to:** [ADR-0600](ADR-0600-op117-events-update-delete-red.md) (the RED contract this card implements), [ADR-0560](ADR-0560-op116-events-list-get-red.md) / [ADR-0561](ADR-0561-op116-events-list-get-green.md) (the detail route this card's mutations extend), [ADR-0520](ADR-0520-op115-events-create-red.md) / [ADR-0521](ADR-0521-op115-events-create-green.md) (the create lane's windows/DTO/entitlement shapes), [ADR-0029](ADR-0029-domain-events-outbox.md) (the outbox the emissions ride), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §4.1 (PATCH / archive / DELETE), §0.10 (ETag / If-Match), §0.4 (never a cross-tenant oracle), §22 (the ordered purge) · **Schema:** §15.1 (`events`), §15.2 (`event_organizers`), §18.3 (outbox) · **Doc:** `docs/API Contract.md` Part 4

## Context

The pins card (`t_c44493a2`, ADR-0600) delivered a test-only RED across three
files: one unit spec (16 cases, the recompute / whitelist / start-lock units),
one integration spec (12 cases driving PATCH / archive / DELETE in-process
against MongoDB-memory-server) and one e2e journey (create → PATCH with ETag →
delete). This card implements the ADR-0600 contract, ships the pins
byte-unchanged, and turns every **server-side** behaviour green. One integration
assertion (`I4`'s final `countDocuments({}) == 0`) is unsatisfiable as written
— the harness sign-in the fixture itself performs emits two outbox rows the
delete flow could never remove (section D). Each asserted server behaviour is
independently proven.

## Decision

### P1 — Module contract (the three units, ADR-0600 §1)

`@/server/events/windows` gains `recomputeWindows({endAt, postUploadDays,
retentionDays}) → {uploadWindowEndsAt, retentionExpiresAt}` — the two existing
per-window helpers composed in one call, `null` on either entitlement
materialising that window as `null` (U1). **New** `@/server/events/update`
exports `EVENT_EDITABLE_FIELDS` (the ten §4.1 field names, verbatim),
`findForbiddenEditableFields(supplied)` (supplied keys outside the set; a key
whose value is `undefined` is invisible — the `PATCH /me` precedent) and
`isEventLocked(now, startAt)` (`now.getTime() >= startAt.getTime()`, so the
exact `now === startAt` boundary counts as started) (U2/U3). All three are pure
and fully covered by the 16 unit cases.

### P2 — `PATCH /api/v1/events/{eventId}` (I1/I2/I6/I7/I8, U2-at-the-wire)

The OP-116 detail route file additionally exports `PATCH`, same
`route: "/api/v1/events/:eventId"`, `userAuth` admission, and a
**`defineRoute` ETag stage composed over a database read** (`dbBackedEtagStage`):
the stage's `resolve` is synchronous per the `etagStage` contract, so the route
loads the row first and runs the existing `etagStage({ resolve: () => current,
required: true })` against the captured tag — missing `If-Match` →
`428 precondition_required` (`details.header: "If-Match"`), stale →
`412 etag_mismatch` (`details.currentETag`), with the refusal happening before
any write (I1). The handler order:

1. row missing → `404`; no relationship (`resolveEventActorRole` below) → `404`
   (never an oracle);
2. `status === "deleting"` → `409 event_deleting` with
   `details.purgeScheduledAt` (I5b);
3. `findForbiddenEditableFields(body)` non-empty → `422 forbidden_field` with
   `details.fields` (U2-at-the-wire);
4. a supplied `startAt` while `isEventLocked(now, storedStartAt)` →
   `409 event_already_started` (I7);
5. date edits: instants normalised (`normalizeInstantToUtc`, a malformed
   instant → `validation_failed`), `endAt > startAt` enforced
   (`invalid_date_range`), `computeDurationDays(effectiveStart, effectiveEnd)`
   re-checked against `events.duration_days` → `403 plan_limit_exceeded` with
   `details.requestedDays` (I8, mirroring the create route's 403/402 split),
   then **both windows recomputed** through `recomputeWindows` from the plan's
   `events.post_upload_days` / `gallery.retention_days` effective limits
   (I2: `uploadWindowEndsAt = endAt + 7d`, `retentionExpiresAt = endAt + 90d`
   on the starter plan);
6. the `$set` built from the supplied editable fields only; `updatedAt: now`;
7. **one transaction**: `updateOne` + `emitDomainEvent(event.details.updated)`
   (the outbox row is assertable right after the response — the API does not
   coalesce, the notification resolver does), then a re-read → full Event DTO
   with the **new** quoted ETag (`eventETag(updatedAt, schemaVersion)`), whose
   response-header merge order (`{...stageHeaders, ...result.headers}`) lets the
   post-write tag win over the stage's pre-write one.

`logoAssetId`/`watermarkAssetId` are validated as 24-hex ids and stored as
`ObjectId|null`; `description` is sanitised to inert plain text exactly like the
create route (OP-115 I9); `displayTimeZone` is IANA-checked
(`unknown_timezone`).

### P3 — Admission helper

New `@/server/events/access` exports
`resolveEventActorRole(db, eventId, tenantKey, userId)` →
`"organizer" | "co_organizer" | "tenant_member" | null`: an `event_organizers`
row (`role` in `organizer|co_organizer`, `revokedAt: null`, keyed by the
caller's user id) **or** an active `tenantMembers` row of the event's tenant.
`null` → `404`. PATCH admits every role; archive/delete gate on
`"organizer"` only (a co-organizer → `403 forbidden`, I3).

### P4 — `POST /api/v1/events/{eventId}/archive` (I3/I3b)

New child route file exports `POST` (`route: "/api/v1/events/:eventId/archive"`,
`userAuth`). Organizer-only (co-organizer → `403`, nothing emitted); a
`deleting` row → `409 event_deleting`; success → `200` with the full Event DTO
and a synchronous `emitDomainEvent(event.archived)` (the I3b outbox row is
assertable right after the response).

### P5 — `DELETE /api/v1/events/{eventId}` (I4/I5/I5b)

Same route file, body `{confirmName}` (zod), response schema exactly
`{status: "deleting", purgeScheduledAt, irreversible: true}`. Organizer-only
gate; exact-name match else `422 confirmation_mismatch`
(`details.field: "confirmName"`), **nothing written, nothing emitted** (I4).
Deleting rows are inert (`409 event_deleting`). On match, **one transaction**:
row → `status: "deleting"` + `deletedAt` + `updatedAt`, then two synchronous
emits — `event.purge.scheduled` (payload `{eventId, purgeScheduledAt}`,
subjectRef `{kind:"event", id}`, **registered in `ANALYTICS_ONLY_EVENT_KEYS`**
so the outbox gate admits it; the OP-132 purge job consumes it) and
`event.deleted` (already a registered notification typeKey). Response `202`
with exactly the three keys and `purgeScheduledAt = deletedAt.toISOString()`;
a later PATCH reads the same instant off the row into
`details.purgeScheduledAt` (I5b, the three-way agreement). The row is **not**
destroyed by this endpoint — the deleting state persists until OP-132 drains
the purge event. DELETE also runs the DB-backed ETag stage with
`required: false` (enforce-if-supplied; only PATCH's 428 is pinned).

### P6 — Registry debts (ADR-0600 §Registry)

- `event_deleting` (`409`, non-retryable, `details {purgeScheduledAt}`) and
  `event_already_started` (`409`) appended as a new closed set
  `EVENT_ERROR_CODES` in `packages/contracts/src/errors.ts` (into
  `API_ERROR_CODES` + the `AppErrorCode` union) and transported from a new
  `EVENT_ERROR_TRANSPORT` in `@/server/http/catalog.ts` — the
  `cannot_demote_owner` append-only shape.
- `event.purge.scheduled` appended to `ANALYTICS_ONLY_EVENT_KEYS`.

### P7 — Index repair: `event_organizers_active_event_unique` was wrong for the co-organizer model

The OP-117 fixtures were the **first** integration rows to place an organizer
row and a co-organizer row in the same event (`seedOwnedEvent` +
`seedCoOrganizer` — the OP-116 fixtures never seeded more than one
`event_organizers` row per event). The pre-existing index
`event_organizers_active_event_unique` declared `{tenantId, eventId}` unique
partial `{revokedAt: null}` — i.e. **one active row per event, period**, which
makes the documented co-organizer admission (an `event_organizers` row with
`role: "co_organizer"`, `revokedAt: null`, coexisting with the organizer) a
database-impossibility. Schema §15.2 documents the intended invariants:
`{eventId, userId}` unique **plus** `{eventId, role}` unique partial on
`{role: "organizer", status: "active"}` ("exactly one organizer per event").
This card repairs the registry to the §15.2 pairs:

- `event_organizers_active_event_unique` → keys `{tenantId, eventId, userId}`,
  unique partial `{revokedAt: null}` (one active membership row per user);
- **new** `event_organizers_active_organizer_unique` → keys
  `{tenantId, eventId, role}`, unique partial
  `{role: "organizer", revokedAt: null}` (the exactly-one-organizer guard).

Both keep the tenantId lead the `indexes.test.ts` U1 lint requires, the
registry-integrity test's required names stay present
(`event_organizers_active_event_unique`), and `index-bootstrap.test.ts` still
passes 6/6 (I1 idempotence/I2 duplicate refusal hold against the two-halves
split). The suite proves the repair: I6 (co-organizer PATCH) and I3 (co-
organizer archive) pass only with both rows coexisting.

### P8 — E2E (E1)

The e2e journey signs up through the real Better Auth flow, creates the event,
reads the tenant-scoped ETag, PATCHes through the global route with `If-Match`,
then DELETEs with the exact `confirmName`; the 202 body carries exactly
`{status, purgeScheduledAt, irreversible}`.

### P9 — Shared route support and the coverage-shaped refactor

The mutation handlers (PATCH, DELETE, `POST /archive`) repeated the same
admission ladder, so the duplicated branches were lifted into
`@/server/events/access`: `requirePrincipal(ctx)` (`authentication_required`),
`loadEventRow<T>(db, eventId)` (`404`), `requireEventRole(db, eventId,
tenantKey, userId, roles)` (`404` when unrelated — never an oracle — and `403`
when a related caller is outside the allowed roles) and
`assertEventNotDeleting(row, now)` (`409 event_deleting` with
`details.purgeScheduledAt`). `@/server/events/dto` gains
`toEventDtoOrThrow(row, baseUrl, code)` so the three handlers share one
projection-refusal path (`not_found` on a read, `internal_error` after a
write). The PATCH `$set` is now built by iterating the supplied editable
values, and the redundant `typeof` re-checks that the Zod body schema already
guarantees were dropped — the field whitelist itself (`findForbiddenEditableFields`)
is unchanged. This is behaviour-preserving: every integration case and the E1
e2e journey stay green, and the global branch coverage rose from `79.53 %`
(the first GREEN head, over the 80 % bar by no means) to `80.01 %` without
weakening any threshold or adding a test. `BRF` fell from `4559` to `4507`.

## Disputes (documented, fixes belong to the Test Author — a GREEN may not edit tests)

### D1 — `event-update-delete.test.ts` I4 asserts a whole-collection `countDocuments({}) == 0` that the fixture's own sign-in makes impossible

I4 (`"deleting with a wrong confirmName … and changes nothing"`) asserts
`expect(await app.db.collection(COLLECTIONS.domainEvents).countDocuments({})).toBe(0)`
(`event-update-delete.test.ts:641`) to prove "nothing was announced". The
fixture's **own** `seedOwner("op117-wrong-name")` → `app.signIn(...)` runs the
real Better Auth identity hooks, which emit `account.welcome` and
`auth.signin.new_device` into the same `domain_events` collection **before the
DELETE is ever invoked** (proved by a throwaway probe against the harness: a
fresh `app.signIn` leaves exactly two rows — `account.welcome` +
`auth.signin.new_device`, both `subjectRef.kind: "user"`; the probe was deleted
before handoff). Every route the DELETE could honestly run leaves those rows
untouched — an implementation that deleted unrelated outbox rows to satisfy the
count would be corrupting the log. The 422 response, untouched row and absent
`deletedAt` (the three assertions before it) all pass with the implementation;
only the whole-collection count is un-satisfiable. **Fix (one line):** scope
the count to the delete's own keys —
`countDocuments({ eventKey: { $in: ["event.deleted", "event.purge.scheduled"] } })`
(or filter on `subjectRef.kind: "event"` + the event id), which is the actual
contracted "nothing announced" property. Routed as a TEST card to the OP-117
test author.

**Resolved by the Test Author (card `t_be8b01a5`) — the fix landed, the pin was
not weakened.** The scoped count above was applied verbatim at
`c543a6e531f9f9f158c977db4b2c2df4cc20417e` (`test(events): OP-117 scope I4's
outbox count to the delete's own keys`, +8/−2 on the one spec file), followed by
`2d95709fdd512b521736f076ac016c33e42ae31b` recording it in ADR-0600; this GREEN
merged `2d95709` (`1aa30d9`). The fix is discriminating, not a relaxation: a
mutation probe that emits `event.deleted` **before** the `confirmName` gate
reddens the pin (`expected 1 to be +0`), so I4 still bites on a delete that
announces anything on the mismatch path. This GREEN makes **no** production
change for D1 — the implementation was already honest; only the assertion was
unsatisfiable. No new ADR number is consumed (lane `Next free` stays `0602`).

### D2 — the OP-117 E1 spec spends two `auth.otp` tokens from the single shared e2e IP bucket, and the suite has no headroom left (CI `ci` → E2E red)

At the merged head `1aa30d9` the whole suite is green except the `ci` job's
**E2E** step: `webhook-inbox.spec.ts:69` (`POST /api/auth/email-otp/send-verification-otp`)
answers **429**, so that spec's `expect(sent.status()).toBe(200)` fails. The
failure is **not** in OP-117's own journey — `event-update-delete.spec.ts` E1
itself passes (verified in the same run, and alone).

Mechanism, measured rather than inferred:

- `RATE_LIMIT_CLASSES["auth.otp"]` is pinned by `classes.test.ts` at
  **contact 5 / hour and ip 15 / hour** (`@/server/rate-limit/classes.ts`), and
  `createRateLimitHook` (`@/server/auth/rate-limit-hook.ts`) applies both legs to
  every path in `OTP_SEND_PATHS`, which contains **both**
  `/email-otp/send-verification-otp` **and** `/phone-number/send-otp`.
- Every e2e spec calls Playwright's `request` fixture with no forwarding header,
  and the Next standalone server stamps the socket address, so **all** specs
  share the one `ip` bucket `127.0.0.1`. The `contact` leg never collides (each
  spec uses a fresh email).
- Probing the real e2e server directly: the shared bucket admits exactly **15**
  sends and answers `429 too_many_requests` on the **16th** (`15 × 200`, then
  `429`), while a distinct `x-forwarded-for` gets its own bucket (`2 × 200`) —
  which is the e2e-trusted path in `resolveClientIp` (ADR-0024).
- Suite arithmetic at the merged head, from the server's own `auth.otp.sent`
  log: **baseline (OP-117's spec excluded) = 14 sends, 0 `auth.otp` denials**;
  **with OP-117's spec = 16 attempts (15 accepted + 1 denied)**. The OP-117 E1
  journey spends **two** tokens, not one: it signs up by email OTP _and_ binds a
  phone number by OTP (the account-completion gate). 13 sign-in specs already
  sat at 14/15, so the lane's own spec is what crosses the ceiling — main is
  green only because it never had a two-token journey.

This is a **test-suite budget constraint, not a product defect**, and the honest
fixes are all test-side:

1. **Minimal (one spec):** send the OP-117 E1 spec's two OTP requests with a
   private `x-forwarded-for` (one shared header object), so its two tokens land
   in their own bucket and the suite returns to 14/15.
2. **Durable (every sign-in spec):** give each OTP-sending e2e spec its own
   private `x-forwarded-for`, exactly as the integration suite already gives each
   spec "a private email/phone/**IP** identity" — the shared 127.0.0.1 ceiling
   then stops being a per-lane lottery. With 14 sign-in specs and 15/hour, the
   margin today is **one token**, so option 1 alone leaves the next lane stranded.

Rejected alternatives (both dishonest and both forbidden to a GREEN lane):
raising the `auth.otp` ip allowance in `classes.ts` (a contract-pinned security
control; `classes.test.ts` pins 15/hour) or any `APP_ENV === "e2e"` branch that
skips the limiter (a test-environment conditional changing real behaviour).
**This GREEN makes no code change for D2** — every route it owns is correct; the
429 is produced by the pinned limiter doing its job against an over-subscribed
harness. Routed as a TEST card to the OP-117 test author; `ci`'s E2E step stays
red until it lands.

**Resolved on the lane (test-only, no number consumed).** The TEST card landed
option 2 — the durable fix, so the next two-token lane is not stranded at 14/15.
`apps/web/e2e/client-ip.ts` exports `clientIpFor(specFile)`, which derives a
private `10/8` address from the **spec's own file name** (sha256 → three octets,
host octet kept in 1..254), and all 14 OTP-sending specs now send that value as
`x-forwarded-for` on every `auth.otp`-guarded call (`send-verification-otp` and
`phone-number/send-otp`). The identity comes from the file name rather than a
hand-written label, so a new spec cannot collide with an existing bucket by
copy-paste, and no spec metadata has to be maintained. `classes.ts`,
`rate-limit-hook.ts` and the `auth.otp` allowances are untouched — the limiter
still enforces 5/hour/contact and 15/hour/IP.
`apps/web/src/test/unit/e2e-client-ip.test.ts` pins the suite-level property:
every e2e spec derives a distinct private address, and every spec that calls an
OTP send path both sets `x-forwarded-for` and derives its own identity (so a
future OTP spec that forgets the header fails the unit suite).

Measured on the same build and head, full `--project=api` run against a fresh
`e2e/start-server.mjs` (`LOG_LEVEL=info`, `TMPDIR=/root/tmp-mongo`):

- **Before** (the 14 spec edits stashed): **24 passed, 1 failed** —
  `webhook-inbox.spec.ts:69 expect(sent.status()).toBe(200)` → `Received: 429`;
  server log `auth.otp.sent` = **15** (the 16th attempt is the denial), i.e. the
  exact symptom this section records.
- **After**: **25 passed** with `auth.otp.sent` = **16** and **0** `auth.otp`
  denials; the only `status: 429` in the log is `rate-limit.spec.ts`'s deliberate
  `write.normal` burst. (The card's "24 tests" is one short of this head: the
  OP-117 E1 spec is the 25th. Measured, not copied.)

## Assumptions and open questions

- `purgeScheduledAt` is the instant the delete answers, stored as the row's
  `deletedAt` — the 202 body, the outbox payload and the later 409 details all
  read the same value (ADR-0600's unpinned three-way agreement, resolved to
  "same instant, no grace offset").
- The route-level `visibilityDefaults`/`thumbnailPreset` fields are stored
  verbatim; no test pins their shape (whitelisted by U2 at the unit level).
- `POST /upload-window:extend`, the `draft → published` transition,
  `retention_would_expire_immediately`, access-link rotation (OP-118) and the
  co-organizer delete denial stay deliberately out of scope (ADR-0600 §Open
  items): no test pins them and the card's test list does not carry them.

## Consequences

- The conditional-write loop closes end-to-end: GET returns the quoted ETag,
  PATCH enforces `If-Match` and returns the new tag, DELETE accepts the tag and
  answers `202`.
- Delete is the only content-destroying path and is user-initiated; the
  `deleting` state + `event.purge.scheduled` give the OP-132 purge job the
  ordered drain it consumes.
- **ADR-number allocation (renumbered 2026-10-26).** This record is the OP-117
  GREEN. The lane was first allocated `0580`–`0599` (RED drafted as `0580`),
  but at integration `origin/main` claimed `0580`–`0583` for the Media
  foundations lanes (OP-112/113), so under ADR-0300 §9's land-then-renumber
  fallback the lane renumbered to the next free pool block **`0600`–`0619`**:
  this card takes `0601` (the RED took `0600`), the lane's `Next free` cell
  advances to `0602`, and the pool cell advances to `0620`+. No number outside
  `0600`–`0619` is touched.

## Alternatives considered

- **A route-local If-Match check in the handler** instead of the ETag stage.
  Rejected: the ADR-0600 contract names the `defineRoute` etag stage with
  `required: true`, and composing `etagStage` over a pre-loaded row reuses the
  exact 428/412 semantics (including `details.currentETag`) instead of
  re-implementing them.
- **In-place route handlers duplicating admission.** Rejected: PATCH/DELETE on
  the detail file and POST on the archive child share one admission; the
  `@/server/events/access` helper mirrors the OP-116 detail admission so the
  co-organizer (non-member) writes what they can read.
- **Dropping the unique index instead of repairing it.** Rejected: the
  exactly-one-active-organizer invariant is load-bearing (schema §15.2,
  `index-bootstrap.test.ts` I2); the §15.2 two-index split keeps it while
  making membership per-user.
