# ADR-0963 — OP-140: the attendee lane resolves an event's active slug and the worker report emits `attendee.selfie.rejected`

- **Status:** Accepted (GREEN implementation of [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md))
- **Date:** 2026-11-23
- **Card:** `t_c38a626a` (OP-140 precondition GREEN, Low, phase 6-M2M · epic Notifications) — the implementation half of the TEST card `t_9df3b691`, routed by `t_37ecac39` out of the `selfie` × `retry` deferral [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2 recorded for contract §7.3.
- **Branch:** `OP-140-task-precondition-selfie-redirect-green` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-precondition-selfie-redirect-green` · **Base:** the TEST branch head `16913b23`, with `origin/main` `ed2d3b85` merged in (the pins are byte-identical to `16913b23`).
- **ADR number:** `0963` — reserved for this GREEN by [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md) §4. Swept again at this head: `origin/main` `ed2d3b85` (highest record `ADR-0944`), every `.worktrees/*/docs/adr` tree, `git rev-list --objects --all -- docs/adr`, and the open PR heads — `ADR-0962` is the only `09[6-9]x` record anywhere, and `git rev-list` resolves no `ADR-0963` blob.
- **Consumes:** [ADR-0962](ADR-0962-op140-attendee-selfie-slug-resolver-and-rejected-producer.md) (the decisions, the reversal condition, the measured F1/F2/F3), [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2 (the deferred `selfie` × `retry` row), [ADR-0620](ADR-0620-op118-access-links-qr-red.md) (the access-link module is pure; only its URL builder is reused).
- **Consumers:** `apps/web/src/test/integration/attendee-event-slug.test.ts` (10 cases), `apps/web/src/test/integration/selfie-rejected-notification.test.ts` (9 cases).
- **Touches:** one new module (`apps/web/src/server/attendee/event-slug.ts`), the selfie arm of `apps/web/src/app/api/v1/internal/worker/report/route.ts`, one projection widened in `apps/web/src/server/repos/cross-tenant.ts`, one ledger token in `docs/adr/README.md` (round-1 review of `t_9df3b691`: row `0962`'s hotspot sentence said `OP-141`), and this record. **No ledger row and no `Next free` cell moves** — ADR-0962 already advanced the three cells to `0964` for the pair.

## Context

ADR-0962 §Context measured the two gaps on the trunk: nothing resolves event → active slug (`buildAccessLinkShareUrl` builds `/e/{slug}`; `resolveEventBySlug` resolves the opposite direction), and `attendee.selfie.rejected` exists only as catalogue data. Its §Decision fixed both shapes and its §Evidence recorded the RED, the satisfiability probes and the two mutation arms. This record is the implementation of exactly those shapes — no behaviour the pins do not demand.

## Decision

### 1. The resolver — `server/attendee/event-slug.ts`

Two exports, as ADR-0962 §1 fixed them:

| Export                     | Answers                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `resolveActiveAccessSlug`  | the event's **active** link slug, `null` when it has none or the id is not 24-hex   |
| `attendeeRetryRedirectUrl` | `${APP_BASE_URL}/e/{slug}` for the selfie's event, `null` when either hop is absent |

`resolveActiveAccessSlug` reads the **same predicate** `resolveEventBySlug` reads, one direction each: `{ _id: id, accessLinks: { $elemMatch: { active: true } } }` with `projection: { accessLinks: 1 }`, then the entry whose `active` is `true` — never `accessLinks[0]`. Events are reached through `platformRepo`, exactly as the shipped slug resolver reaches them. The id is accepted as an `ObjectId` or a 24-hex string; a string that fails `ObjectId.isValid` answers `null` before the driver is asked, so a malformed segment is never a BSON throw.

`attendeeRetryRedirectUrl` takes the selfie hop through `crossTenantReads.findWorkItemById("selfie", id, db)` — the single whitelisted cross-tenant read, which already validates the id and projects `eventId` — then `resolveActiveAccessSlug`, then `buildAccessLinkShareUrl(getConfig().app.baseUrl, slug)`. No `/e/` is hand-rolled, so the URL keeps one builder and honours `APP_BASE_URL` with or without a trailing slash. The answer is **absolute** by design; making the §7.3 wire body relative `"/e/{slug}"` is the delegate arm's job (ADR-0962 §Alternatives, finding F-3 of the TEST review).

### 2. The producer — the selfie arm of `POST /api/v1/internal/worker/report`

The emit sits after `kept === true` and inside `decision.status === "failed"` only, so `done`, `skipped`, a retryable failure that returns the item to `queued`, and a lost lease (which `continue`s before the emit) announce nothing:

- `eventKey` `attendee.selfie.rejected`; `tenantId` the row's own (never the worker's, never the caller's);
- `actorRef { kind: "system", id: "worker" }` — a non-`user` actor is what keeps `fan-out.ts`'s actor-exclusion rule from dropping the selfie's owner;
- `subjectRef { kind: "selfie", id: <selfie _id hex> }` — `actionTarget.kind` **is** the emit's subject kind, and the OP-140 action endpoint requires a 24-hex target id;
- `payload { eventId, profileId, reason }` with `reason` the row's own `selfies.quality.rejectionReason` (§16.4), never the worker's `processing.lastError.code`; a missing reason is `null`;
- `dedupeKey` `attendee.selfie.rejected:<selfie hex>` — design §4.8's **1/attempt** identity, because one selfie row **is** one attempt (§15.3). Two rejected attempts are two selfie rows, so two distinct keys.

**Why the emit is outside the transaction.** `emitDomainEvent` treats a duplicate-key collision on the `domain_events.dedupeKey` unique partial index as `{ deduped: true }` by catching the driver's `E11000`. Inside a `withTransaction` callback that catch is a trap: a write error aborts the session, so the "deduped" branch would leave the surrounding selfie/profile write unable to commit. Emitting after the transaction commits keeps the dedupe semantics honest; the trade-off is recorded in §Consequences. The route's response contract `{ applied, leaseLost, rejected }` and its lease accounting are untouched.

### 3. The reason read — one projection widened, not a second query

`findWorkItemById` (`server/repos/cross-tenant.ts`) projected `{tenantId, eventId, profileId, processing}` only. The projection now also selects `quality`, and `OwnedWorkItemRow` gains `quality?: { rejectionReason?: string | null } | null`, so the report reads the reason off the row it already fetched. The function has **one** caller (this route) and serves both arms: the `event_image` arm simply ignores the extra field, and `event_images` rows carry no `quality`. A scoped re-read in the route was the alternative; it would cost one extra round-trip per rejected item for one optional string.

### 4. The ledger

- `docs/adr/README.md` row `0962`'s hotspot sentence named a non-existent `OP-141` lane; it now reads "the sibling OP-140 precondition cards also append to". One token, nothing else in the row.
- **No row is added for `0963`** and **no cell moves**: ADR-0962 §4 already advanced the `OP-129 attendee identity lane` cell, the `unallocated (future lanes)` cursor and the `OP-136 jobs lane` mirror cell to `0964` for the pair `0962`+`0963`.

## Evidence

All gates run on this head, with `16913b23`'s pins unchanged:

```
pnpm vitest run --project integration \
  apps/web/src/test/integration/attendee-event-slug.test.ts \
  apps/web/src/test/integration/selfie-rejected-notification.test.ts
 Test Files  2 passed (2)
      Tests  19 passed (19)          # 10 resolver + 9 producer

pnpm vitest run --project integration \
  apps/web/src/test/integration/liveness-selfie-submit.test.ts \
  apps/web/src/test/integration/internal-worker-endpoints.test.ts
 Test Files  2 passed (2)
      Tests  59 passed (59)          # unchanged neighbours
```

`pnpm typecheck` exits `0`; `pnpm lint` and `pnpm format:check` are clean on the touched files and the tree. The whole projects, on this head:

```
pnpm vitest run --project unit
 Test Files  194 passed (194)
      Tests  3261 passed | 3 skipped (3264)

pnpm vitest run --project integration
 Test Files  162 passed (162)
      Tests  1720 passed (1720)
```

The RED this GREEN closes, and the two mutation arms that proved the pins load-bearing, were measured on `16913b23` by the GREEN's author and independently re-measured by the reviewer of `t_9df3b691`: `Cannot find package '@/server/attendee/event-slug'` for the resolver spec, `6 failed | 3 passed (9)` for the producer, and then — against faithful probes — resolver `10 passed (10)` and producer `9 passed (9)`; mutation A (`accessLinks[0]`, ignoring `active`) `3 failed | 7 passed (10)`; mutation B (emit on every outcome) `3 failed | 6 passed (9)`. This card re-ran the probes only as its own implementation.

## Reversal condition

> When the resolver answers an event's active slug and the producer emits `attendee.selfie.rejected` carrying the selfie's own id, the OP-140 `selfie` × `retry` arm can answer `{ "redirectUrl": "/e/{slug}" }` (owner: OP-140 notifications lane).

## Consequences

- **The two halves are no longer missing.** `selfie` × `retry` has its resolver and its announcement; the delegate arm, the action-key derivation and the catalogue flip remain one later OP-140 card.
- **A crash between the commit and the emit loses one announcement.** The row is `failed`, so a replayed report answers `leaseLost` and emits nothing. Measured as acceptable against the alternative (an in-transaction insert that cannot swallow a duplicate key); the durable fix is an outbox write driven by the same claim, which is a pipeline change, not this row's.
- **`reason` is `null` in production** until a quality pass writes `selfies.quality.rejectionReason` — finding F2 of ADR-0962, unchanged by this card.
- **F1 is untouched.** An emitted row still reaches every identified attendee of the event, or nobody for an anonymous profile; the routing decision is card `t_f6f20d62`.
- **`attendee.selfie.accepted` stays catalogue-only** (F3 of ADR-0962): `done` emits nothing, pinned.
- The widened `findWorkItemById` projection is the one shared-repo change; its only other reader is the same route's `event_image` arm, which does not read `quality`.

## Alternatives

- **Re-read the selfie in the route for the reason.** Rejected: an extra query per rejected item for one optional string, when the row's own read was one projection term away.
- **Emit inside the selfie transaction with `{ session }`.** Rejected: `emitDomainEvent` swallows `E11000` to mean "deduped", but a write error aborts the transaction, so the dedupe branch would poison the commit it was meant to make safe (§Decision 2); the crash window it would close is recorded instead.
- **Read the selfie in the resolver with a bare `db.collection(...)`.** Rejected: a cross-tenant read by id alone is the `crossTenantReads` whitelist's job, and that helper already validates the id and projects `eventId`.
- **Answer a relative `"/e/{slug}"`.** Rejected: the pin and ADR-0962 §Alternatives fix the composition on `buildAccessLinkShareUrl(APP_BASE_URL, slug)`; the delegate converts to the §7.3 relative body.
- **Add a ledger row for `0963`.** Rejected by the card and by ADR-0962 §4: the pair shares one row, and the three cells already point at `0964`.
