# ADR-0962 — OP-140: the attendee lane's event → active-slug resolver and the `attendee.selfie.rejected` producer

- **Status:** Accepted · **Date:** 2026-11-23
- **Card:** `t_9df3b691` (OP-140 precondition TEST, Low, phase 6-M2M · epic Notifications), routed by `t_37ecac39` out of the `selfie` × `retry` deferral that [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2 recorded for contract §7.3
- **Lane:** `OP-129 attendee identity lane` (`0780`–`0798`) — **exhausted**, so this record is a **pool draw**: ADR-0300 §11 item 18 sends an exhausted block to the `unallocated (future lanes)` cursor, which read `0962` at this branch head. The OP-140 lane's own block (`0942`–`0961`) is untouched; `0945` sits on the trunk and `0946` is in flight on `t_61798b06`, so the pool cursor was the only free value above them.
- **Branch:** `OP-140-task-precondition-selfie-redirect` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op140-precondition-selfie-redirect` (cut from `origin/main` `61579449`)
- **ADR number:** `0962` — swept before minting: `origin/main` `61579449` (highest record `ADR-0944`), every `.worktrees/*/docs/adr` tree tracked and untracked (highest `0946`, the in-flight `t_61798b06` GREEN — no `09xx` gap row), the eight open PR heads (#830, #829, #828, #827, #826, #755, #743, #272; highest `0945`), `git rev-list --objects --all -- docs/adr` and the nine non-`done` card bodies on the active board (`$HERMES_KANBAN_DB`) — none of which holds `0962`. `git rev-list` resolves no `ADR-0962` object.
- **Consumes:** `0962` (this record). The GREEN sibling takes `0963` and writes **no** ledger row, so the ledger's `OP-129 attendee identity lane` cell, the `unallocated (future lanes)` cursor and the `OP-136 jobs lane` mirror cell all advance to `0964`.
- **Consumers:** `apps/web/src/test/integration/attendee-event-slug.test.ts`, `apps/web/src/test/integration/selfie-rejected-notification.test.ts`
- **Touches:** two **test-only** files (10 + 9 cases), this record, its index row, three ledger cells and one ledger note. **No production code** — the resolver module and the emit are the GREEN's, so the RED is exactly the two missing halves.

## Context

Contract §7.3 answers a `selfie` × `retry` click with `{ "redirectUrl": "/e/{slug}" }`. ADR-0942 §2 recorded the row as **deferred** because two preconditions were missing on the trunk, and this card supplies both. Re-measured on `61579449` (the card's line numbers were taken on `da4e24cc`; every one of them still holds):

1. **Nothing resolves event → slug.** `apps/web/src/server/events/access-links.ts:76` `buildAccessLinkShareUrl(baseUrl, slug)` is the only builder of `/e/{slug}` in the repo. `apps/web/src/server/attendee/request-event.ts:74` `resolveEventBySlug(db, slug)` resolves the **opposite** direction, and its predicate is `accessLinks: { $elemMatch: { slug, active: true } }` (`:81`). No module reads an event id and answers its active slug.
2. **`attendee.selfie.rejected` is emitted nowhere.** The key exists only as catalogue data — `apps/web/src/server/notifications/notification-types.values.ts:802`, audiences `ATTENDEE = ["attendee_identified"]` (`:49`), `throttle: rate(1)` — and in tests. Its sibling `attendee.selfie.accepted` (`:792`) is emitted nowhere either.
3. **The selfie outcome settles in one place.** `apps/web/src/app/api/v1/internal/worker/report/route.ts:165` is the selfie arm; `reduceReportItem` (`server/internal/worker-report.ts:80`) turns the worker's verdict into `processing.status` (`done` / `failed` / `skipped` / `queued`), and only `failed` is a rejection. The stable rejection vocabulary is `server/attendee/status-detail.ts:12` (`no_face_detected`, `multiple_faces`, `low_quality`, `liveness_failed`, `processing_failed`, `no_matches_yet`).
4. **The reason lives on the row, and nothing writes it.** `selfies.quality.rejectionReason` is read at `server/attendee/status-detail.ts:39` and `app/api/v1/p/events/[slug]/me/route.ts:251`; measured with `grep -rn rejectionReason apps/web/src --include=*.ts` outside `test/`, **no production module writes it**. And the report's own row read projects it away — `server/repos/cross-tenant.ts:529-544` `findWorkItemById` selects `{tenantId, eventId, profileId, processing}` only (`:542`).

Two decisions were settled by the routing card and are recorded, not re-litigated:

- **Only the rejected sibling is built.** `attendee.selfie.accepted` stays catalogue-only: a success is already visible on the §6.4 poll, so its absence is a notification-delivery gap of its own (finding **F3**), not this row's precondition. The producer must therefore emit on `failed` **only**.
- **`subjectRef` is `{ kind: "selfie", id: <selfie hex> }`.** `actionTarget.kind` **is** the emit's `subjectRef.kind` (`server/notifications/fan-out.ts:454-458`), and the action endpoint refuses a target whose id is not 24-hex, so a feed row that should carry `actionTarget.kind: "selfie"` must be emitted with that kind and a selfie's own ObjectId.

## Decision

### 1. The resolver lives in the attendee lane, not in the access-link module

Two candidate homes were offered. It belongs at `apps/web/src/server/attendee/event-slug.ts` because the module that must consume it is the attendee lane's, and because `server/events/access-links.ts` is deliberately **pure**: its own record (ADR-0620) says the base URL is an argument precisely so the QR and share builders can be pinned without a database or the config module. Adding a `Db`-taking read to it would break that property for one caller. What it may keep is the one URL builder: the resolver **composes** the redirect with `buildAccessLinkShareUrl(getConfig().app.baseUrl, slug)` and hand-rolls no `/e/` of its own.

The two exports the OP-140 delegate needs, and nothing else:

| Export                     | Signature                                                           | Answers                                                                             |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `resolveActiveAccessSlug`  | `(db: Db, eventId: ObjectId \| string) => Promise<string \| null>`  | the event's **active** link slug, `null` when it has none                           |
| `attendeeRetryRedirectUrl` | `(db: Db, selfieId: ObjectId \| string) => Promise<string \| null>` | `${APP_BASE_URL}/e/{slug}` for the selfie's event, `null` when either hop is absent |

Both take the id in either form because the feed reaches a delegate as strings (`actionTarget.id` is a string) while server code holds ObjectIds; both answer `null` — never a throw — for an id that is not 24-hex, addresses no row, or names an event with no active link.

`resolveActiveAccessSlug` reads the **same predicate** `resolveEventBySlug` reads, one direction each: `{ _id: eventId, accessLinks: { $elemMatch: { active: true } } }` and then the active entry. That is the whole point of the record — a naive `findOne({ _id })` that reads `accessLinks[0]`, or a filter on `accessLinks.active`, answers a link the organizer already rotated away, and the retry button sends the attendee to a dead event page. The spec pins the active-only arm three ways: an event whose only link is rotated away answers `null`; an event whose **first** link is rotated away answers the **second**, active one; and the redirect for a selfie on a rotated-away event answers `null`. The last case in the resolver block walks the answer back through the shipped `resolveEventBySlug` and requires the same event, which is what makes "one predicate, both directions" an observable rather than a comment.

### 2. The producer sits in the selfie arm of the worker report

`POST /api/v1/internal/worker/report` is the only place a selfie's outcome becomes durable (`report/route.ts:165-290`), so it is where the attendee must be told. The emit is the reject branch of that arm: `decision.status === "failed"` (never `done`, `skipped` or the retry `queued`) and only after the row's write actually matched (`kept === true`), so a reporter that lost its lease announces nothing.

The row it writes:

- `eventKey` `attendee.selfie.rejected`; `tenantId` the row's own tenant;
- `actorRef { kind: "system", id: "worker" }` — the worker is the actor, and a non-`user` actor is what keeps the fan-out's actor-exclusion rule (`fan-out.ts:365-369`) from dropping the attendee who owns the selfie;
- `subjectRef { kind: "selfie", id: <selfie hex> }` (decision above);
- `payload { eventId, profileId, reason }` — `eventId` because the fan-out resolves recipients from `event.payload.eventId` (`fan-out.ts:1237`), `profileId` because every §4.8 attendee template and the `{typeKey}:{profileId}` dedupe shape key on it, and `reason` from the row's own `selfies.quality.rejectionReason` (§16.4), **not** from the worker's `processing.lastError.code`;
- a `dedupeKey` naming the selfie, which is design §4.8's **1/attempt** identity: one selfie row **is** one attempt (schema §15.3 has no attempt counter), so a per-selfie key is a per-attempt key. It is also what makes a replay safe even if the lease guard were ever relaxed.

The spec pins the emit once per settled selfie, and pins the three negative arms that a "notify on every outcome" near-fix would break.

### 3. The recipient question — measured, not guessed

`fan-out.ts:313` `resolveRecipients` decides who receives the row, and `attendee.selfie.rejected`'s audience is `attendee_identified` (`notification-types.values.ts:49`). Measured against the **real** repository (`mongoRecipientRepository`) with two identified attendee profiles on one event and then with only the world's anonymous profile:

| Arm                                                                                        | Recipients                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `subjectRef.kind: "selfie"` (this card's emit), two identified profiles                    | **both** identified users — the selfie's owner and the unrelated attendee               |
| `subjectRef.kind: "user"`, `subjectUserId` = the owner, same two profiles                  | **still both** — `add(subjectUserId)` cannot narrow what the audience already broadcast |
| the ordinary anonymous profile a real selfie fixture creates (`subject.kind: "anonymous"`) | **`[]`** — nobody                                                                       |

The measured JSON, from a throwaway probe deleted before this commit: two identified profiles on one event answer `["6b0478c86adbda6aabe186eb","6b0478c86adbda6aabe186ec"]` under both subject shapes, and the fixture's own profile — `{ "kind": "anonymous", "attendeeSessionId": "6b0478da844dde4edd65e03c" }` — answers `[]`.

So the recipient the design names — _the attendee whose selfie was refused_ — is **not resolvable today**. `fan-out.ts:340-345` expands `attendee_identified` through `listIdentifiedAttendeeUserIds` (`server/repos/notification-recipients.ts:118-137`), which lists **every** `attendeeEventProfiles` row of the event whose `subject.kind === "user"`; the single-recipient path (`add(subjectUserId)`, `fan-out.ts:363`) only fills when the emit's `subjectRef.kind` is `user` (`:1239`), which this row must not be (decision 2). Recorded as finding **F1** and **routed, not fixed**: `fan-out.ts` and `server/repos/notification-recipients.ts` belong to the OP-140 notifications lane, and the card walls this one off them. The routing decision is card `t_f6f20d62` (assignee `openpic-orchestrator`, gated on this card). Consequence for the arm: an emitted row reaches the _owner-and-neighbours_ broadcast for identified attendees and **nobody** for anonymous ones until that decision lands. The emit itself is unaffected — it is the producer half this card owes, and the inbox row's reachability is the follow-up's.

### 4. Number allocation and ledger bookkeeping

- The record takes **`0962`** (sweep above). The GREEN sibling takes **`0963`** and writes no row of its own.
- `OP-129 attendee identity lane` `Next free`: `0869` → **`0964`**. The block is exhausted and this record plus its GREEN come out of the pool, so the lane's next free number sits above them.
- `unallocated (future lanes)` cursor: `0962` → **`0964`**.
- `OP-136 jobs lane` `Next free`: `0962` → **`0964`**. That cell mirrors the pool cursor by convention — [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) advanced both cells that read its start value — so it moves with the pool and not on its own account.
- No cell is lowered, no range is re-cut, and the `0942`–`0961` OP-140 block is unchanged.

## Evidence

Red by design on the branch point, for the two reasons this card names:

```
vitest run --project integration attendee-event-slug.test.ts selfie-rejected-notification.test.ts

FAIL  attendee-event-slug.test.ts [ attendee-event-slug.test.ts ]
Error: Cannot find package '@/server/attendee/event-slug' imported from …
       apps/web/src/test/integration/attendee-event-slug.test.ts

× emits exactly one attendee.selfie.rejected row
  AssertionError: expected [] to have a length of 1 but got +0
× addresses the row to the selfie, in the selfie's own tenant
  AssertionError: expected undefined to deeply equal { kind: 'selfie', …(1) }
× carries the event, the profile and the row's own rejection reason
  AssertionError: expected undefined to match object { …(3) }
× stamps a dedupeKey that names the selfie (design §4.8's 1/attempt identity)
  AssertionError: expected undefined to be defined
× emits no second row when the same verdict is reported again
  AssertionError: expected [] to have a length of 1 but got +0
× emits one row per rejected attempt, not one per event or per profile
  AssertionError: expected [] to deeply equal [ '6b0473bc1b21297ad6f95622', …(1) ]

Test Files  2 failed (2)
     Tests  6 failed | 3 passed (9)
```

The three passes are the negative arms (`done`, `skipped`, a retry that returns the item to `queued`): a producer that emits **nothing** satisfies them by construction, which is why they are proven load-bearing below rather than claimed as red.

Two mutation arms, each reddening exactly its own half, then restored:

| Arm              | Near-fix                                                                                    | Result                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — the resolver | `findOne({ _id: eventId })` + `accessLinks[0]`, ignoring `active`                           | `Tests 3 failed \| 7 passed (10)`: **only** the two active-only resolver cases and the rotated-away redirect case — `expected 'op140-slug-rotated-only000003' to be null`, `expected 'rotated0' to be 'live140a'`, `expected 'http://localhost:3000/e/op140-redirec…' to be null` |
| B — the producer | the same emit with the `decision.status === "failed"` guard dropped, so every outcome emits | `Tests 3 failed \| 6 passed (9)`: **only** the three negative arms — `expected [ { …(10) } ] to have a length of +0 but got 1` (done), the same on skipped, and the same on the queued retry                                                                                      |

Satisfiability was measured first, in both halves (a faithful probe module and a faithful probe emit), so neither spec is a pack no implementation can satisfy: the resolver spec answers **`10 passed (10)`** and the producer spec **`9 passed (9)`** against them. Both probes were then deleted — `git status --short` names exactly the two spec files, this record and the ledger — and the route was restored byte-identically (`sha256 fac5c7f1…05e1af` before and after).

## Reversal condition

> When the resolver answers an event's active slug and the producer emits `attendee.selfie.rejected` carrying the selfie's own id, the OP-140 `selfie` × `retry` arm can answer `{ "redirectUrl": "/e/{slug}" }` (owner: OP-140 notifications lane).

## Consequences

- The two preconditions ADR-0942 §2 deferred are met in halves: the **service** (`resolveActiveAccessSlug`, `attendeeRetryRedirectUrl`) and the **producer** are specified here and implemented by the GREEN `0963`. The delegate arm, the action-key derivation and the catalogue flip stay one later OP-140 card, as the routing card fixed.
- **F1 (High, routed):** the recipient is not resolvable — an emitted rejection reaches every identified attendee of the event, or nobody when the attendee is anonymous. `fan-out.ts` and `notification-recipients.ts` are the OP-140 notifications lane's files; the routing decision is card `t_f6f20d62` (`openpic-orchestrator`), filed rather than edited here.
- **F2 (Medium, recorded):** no production module writes `selfies.quality.rejectionReason`. The emit therefore carries `reason: null` in production until a quality pass writes it, even though the pin — "the reason is the row's own value" — is exact. The fan-out template must tolerate a null reason; a writer for the field is a pipeline question, not this row's.
- **F3 (Low, recorded):** `attendee.selfie.accepted` remains catalogue-only by decision, so a successful selfie notifies nobody. That is a delivery gap of the §4.8 matrix, deliberately out of scope.
- **Implementation note for the GREEN:** `findWorkItemById`'s projection (`cross-tenant.ts:542`) does not select `quality`, so reading the reason needs either that projection widened (a shared repo type used by both arms) or one scoped re-read in the route. The pins are behaviour-only and accept either.
- **The pins bind the selfie id, the tenant and the reason.** A producer that emits for a `done` outcome, emits twice for one selfie, or stamps a reason from the worker's error code reddens exactly one case each.

## Alternatives

- **Put the resolver in `server/events/access-links.ts`.** Rejected: that module is pure by design (ADR-0620) — its builders take the base URL as an argument so the unit suite needs no database and no config. One `Db`-taking read would spend that property, and the consumer is the attendee lane.
- **Answer a relative `"/e/{slug}"` instead of composing the absolute URL.** Rejected: the card's instruction is to compose with `buildAccessLinkShareUrl(APP_BASE_URL, slug)` so `/e/` has one builder. The JSON body can still be made relative by the delegate; the service keeps the one function.
- **Emit with `subjectRef.kind: "user"` and the profile's `subject.userId`.** Rejected on measurement: it fixes nothing (the audience still broadcasts to every identified attendee) and it breaks `actionTarget.kind`, which the §7.3 row needs to be `selfie`.
- **Emit `attendee.selfie.accepted` too, to make the pair symmetric.** Rejected by decision: a success is already visible on the §6.4 poll, and the row the card exists for is the retry. Recorded as F3 instead of built.
- **Fix the recipient in `fan-out.ts` in this card.** Rejected: explicitly walled off, and the change is a routing decision the OP-140 lane owns (does an `attendee.*` row address its subject or its audience?). Recorded, routed, blocked-for-later rather than guessed here.
- **Pin the exact `dedupeKey` string.** Rejected: the observable that matters is "one row per attempt, and a replay adds none". A pinned literal would freeze a key shape the fan-out never reads, and the two-attempt case already discriminates a per-event or per-profile key.

## Review — round 1 (artefact lens)

- **Verdict:** **APPROVED WITH FINDINGS**, and RED **by design**. PR [#832](https://github.com/yahodu/openpic-webapp/pull/832) stays a **draft** on purpose: the pin pack fails on its branch point and is never merged from there. The two spec files reach the trunk byte-identically through the GREEN `t_c38a626a` (PR [#835](https://github.com/yahodu/openpic-webapp/pull/835), squash `b6cad7ea`), which is the delivery that was squash-merged. Blob identity, measured at this append: `git rev-parse 16913b23:<spec> 942a31e5:<spec>` prints `3deb3d3be5d7…` for `attendee-event-slug.test.ts` and `c398e347e628…` for `selfie-rejected-notification.test.ts` at both commits.
- **RED reproduced at the pin head** (`16913b23`, private detached probe worktree, removed afterwards): `Test Files 2 failed (2)` · `Tests 6 failed | 3 passed (9)`. The resolver spec fails at import (`Cannot find package '@/server/attendee/event-slug'`) and the producer spec on six row assertions; the three passes are the negative arms, which an emit of nothing satisfies by construction — that is why they are proven load-bearing below rather than claimed as red.
- **Satisfiability** — the round-1 review's own faithful probe (a real `event-slug.ts` plus a real emit in the selfie arm, deleted afterwards) made both packs green at `19 passed (19)` = `10` + `9`, so neither spec is a pack no implementation can satisfy. Re-measured for this append against the merged implementation at `942a31e5`: the same two files answer `2 files / 19 passed (19)`.
- **Mutation A — the resolver** (`findOne({ _id })` + `accessLinks[0]`, ignoring `active`) → `3 failed | 7 passed (10)`: **only** the three active-only arms, `expected 'op140-slug-rotated-only000003' to be null`, `expected 'rotated0' to be 'live140a'` and `expected 'http://localhost:3000/e/op140-redirec…' to be null`. Reproduced at `942a31e5` for this append and restored byte-identically (`sha256 52459908…b1b6c4`).
- **Mutation B — the producer** (the emit with the `decision.status === "failed"` guard dropped, so every outcome emits) → `3 failed | 6 passed (9)`: **only** the three negative arms (`done`, `skipped`, and the retryable failure that returns the item to `queued`), each `expected [ { …(10) } ] to have a length of +0 but got 1`. Reproduced at `942a31e5` and restored byte-identically (`sha256 986e3453…8cff5a`). The route the review probed was restored the same way at the pin head (`sha256 fac5c7f1…05e1af`, re-checked against the `16913b23` blob).
- **Guards, formatting and scope** — the seven `adr-*` guards read `Test Files 7 passed (7)` · `Tests 248 passed (248)` and `prettier --check "docs/adr/**/*.md"` is clean, both at `942a31e5`. At review time the number `0962` was free on the trunk (highest record `0944`), in every `.worktrees/*/docs/adr` tree and on every open PR head (`0945` was the highest in flight). The reviewed head's diff against its base `95561fee` was exactly the two spec files, this record and its ledger row: **no production file**, no helper, fixture or mock edit, and no `.only`/`.skip`/`process.env` in either spec.
- **F-1 (Low, docs accuracy — fixed at source by the GREEN `t_c38a626a`, not an open defect):** the `0962` ledger row's hotspot sentence said "the sibling OP-140 and OP-141 precondition cards". There is no OP-141 lane: the four preconditions routed by `t_37ecac39` are billing, images, consent/DSR and attendee, all **OP-140** (`grep -rn 'OP-141' docs/` returned only that row). The GREEN's PR [#835](https://github.com/yahodu/openpic-webapp/pull/835) changed the one token, the row now reads "the sibling OP-140 precondition cards", and ADR-0963 records the fix.
- **F-2 (Info, test quality, no action):** the replay arm "emits no second row when the same verdict is reported again" is settled by the route's **lease guard** (`leaseLost: 1`), not by the `dedupeKey`. The per-attempt dedupe idempotency is therefore not exercised through the route, and the `dedupeKey` pin is "defined + names the selfie + distinct per attempt" — the literal was deliberately not pinned (§2 and §Alternatives).
- **F-3 (Info, design seam — guidance for the follow-up, not a defect in this record):** `attendeeRetryRedirectUrl` answers an **absolute** URL (`${APP_BASE_URL}/e/{slug}`) while contract §7.3's answer is the relative `{ "redirectUrl": "/e/{slug}" }`. Composing with `buildAccessLinkShareUrl` is correct here (one `/e/` builder, §1), so the later OP-140 delegate arm must emit the relative form and pin the wire body.
- **This record's own findings stand as recorded.** **F1** (the recipient is unresolvable) is routed to card `t_f6f20d62`, assignee `openpic-orchestrator`; **F2** (no production writer of `selfies.quality.rejectionReason`, so `reason` stays `null` until a quality pass writes it) and **F3** (`attendee.selfie.accepted` stays catalogue-only) are unchanged by the review. **Nothing in §Decision, §Consequences or §Alternatives is retracted** — the review found no behavioural defect in the resolver, the emit, the recipient measurement, the ledger arithmetic or any recorded alternative.
- **Follow-ups are cited by card id and PR number only.** No number is reserved for them here: the delegate arm, the recipient decision and the `quality.rejectionReason` writer mint their own records when they land.
