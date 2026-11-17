# ADR-0835 — OP-135 GREEN: the internal worker boundary stops trusting the worker's values

- **Status:** Accepted (implementation record; it turns [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md)'s
  pins green, carried forward unchanged)
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0835`** at this base (`origin/main` `a53623e5`). Swept before minting: no
  `.worktrees/*/docs/adr` carries an `ADR-0835*` file, `git rev-list --objects --all -- docs/adr`
  plus every fetched `refs/remotes/pr/*` head returns **`0834`** as the highest record number
  (this lane's own pin record; `0849` appears only as a README _cell_, never as a file), and the open
  PR heads add none. So this record takes **`0835`** and advances the lane cell to `0836`; the
  `unallocated (future lanes)` block stays at `0849` and no range is re-cut.
- **Turns green:** [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §1–§6 — findings
  **F2**, **F3**, **F4a**, **F4b** and **F6** of the review of the OP-135 GREEN (`t_4a280d94`), plus
  the **F7** refactor (no record of its own: it is behaviour-neutral).
- **Consumers:** the files that cite this record — `apps/web/src/app/api/v1/internal/media/derivative-complete/route.ts`,
  `apps/web/src/app/api/v1/internal/worker/report/route.ts` and
  `apps/web/src/app/api/v1/internal/domain-events/route.ts`.
- **Consumes:** [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §2/§4/§5 (the four
  routes and their wire shapes), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §2/§4
  (the emitter's clock seam and the selfie arm's writes),
  [ADR-0832](ADR-0832-op135-superseded-selfie-profile-pin.md)/[ADR-0833](ADR-0833-op135-superseded-selfie-profile-guard-green.md)
  §2 (the discarded arm keeps `applied: 1`), contract §0.15 (no object key on the wire), §10.3.1
  (the lease), §10.3.2 (the batch size and the per-item refusal), §10.3.3 (the watermark).

## Context

The four internal M2M routes are the whole write surface of the pipeline, and their caller is a
separate process whose values the platform does not control. The OP-135 review measured four places
where a route took a caller-supplied value on trust, and one duplication:

- **F2** — `derivative-complete` derived the stored `derivatives.<variant>.objectKey` from the
  **body's** `contentHash` and accepted any `format` (`z.string().min(1)`), so the caller chose the
  key's material; `objectKeyRef` was required and never read.
- **F3** — `worker/report` accepted an unbounded `items` array while its sibling
  `/internal/domain-events` capped its batch at §10.3.2's 100.
- **F4** — the report read the lease, then wrote unconditionally (a read-then-write window), and the
  selfie arm's two writes (the `selfies` row, then the `attendeeEventProfiles` projection) were
  ordered so a failed profile write left the row `done` beside a profile still `processing` — the
  "polls forever" failure.
- **F6** — `domain-events` stamped whatever `occurredAt` the worker sent, including one in the
  future, which pushes the outbox `expireAt` (a TTL derived from that instant) past the retention
  the platform measures it against.
- **F7** — the same four-line `auth:` thunk appeared in all four routes.

## Decision

### 1. F2 — the derivative key is the asset's, and `format` is an allow-list

`findMediaAssetById` already projects `contentHash` (`cross-tenant.ts:559`). The route reads the asset,
and **before any write** refuses a body whose `contentHash` disagrees with it:

```ts
if (asset.contentHash !== body.contentHash) {
  throw appError("validation_failed", { details: { fields: ["contentHash"] } });
}
```

The stored key becomes `${locationKey}/${asset.contentHash}.${body.format}` — the asset's hash, never
the body's. `format` is `z.enum(DERIVATIVE_FORMATS)` over the one format this pipeline emits
(`["webp"]`: contract §10.3.2's thumbnail processor is "adaptive WebP quality"; every reader in the
tree already defaults a missing derivative format to `webp`). A derivative the pipeline learns to
emit later adds its format to that one array — the allow-list is the decision point, so the widening
is a one-line, reviewed change rather than an unvalidated string.

**`objectKeyRef` is an opaque correlation id and is documented as one** (the route's TSDoc says so).
The card allowed either binding it to the asset or documenting it; binding was rejected because
nothing in the platform mints or resolves handles — there is no handle table to resolve against, so
"bind" would have meant inventing an unrequested resolution service to validate a value the route
does not need. What the field is _for_ is the processor's own idempotency/correlation on its side of
the boundary; the route neither stores it (it must not become key material, §0.15) nor needs it to
derive the key. Requiring it is therefore a wire-shape rule, not a trust decision.

### 2. F3 — the report batch is capped in the body schema

`items: z.array(reportItemSchema).max(MAX_BATCH)` with `MAX_BATCH = 100`, the same §10.3.2 value
`/internal/domain-events` applies to its own batch. Being a body rule, the refusal is the pipeline's
`422 validation_failed` **before** the handler — hence before the first cross-tenant read or write.
The cap is inclusive: a report of exactly 100 items applies all 100.

### 3. F4 — the lease is a predicate of the write, and the selfie pair is one transaction

**F4a.** Both arms now write through a filter that carries the lease:

```ts
const leaseFilter = {
  _id: row._id,
  "processing.workerId": workerId,
  "processing.status": "processing",
};
```

and branch on the driver's `matchedCount`: `0` means the lease was taken over (or the row left
`processing`) between the read and the write, so the item is counted `leaseLost`, warned as
`worker.lease_lost`, and nothing is written. The read above still exists — it distinguishes
`unknown_item` from `leaseLost` and supplies `tenantId`/`profileId` — but it no longer decides.
`workerId` remains the only owner fact: no second lease field is introduced.

**F4b — chosen: one `withTransaction`** (`@/server/db/transaction`), not the profile-first order.
The transaction is viable here: the deployment shape and the integration harness are both replica
sets (`startTestApp` → `MONGO_TEST_URI`, a `MongoMemoryReplSet`; `mongo-transaction.test.ts` already
exercises the helper against it), and both collections come from the pooled client the helper's
`getMongoClient()` returns. Inside the callback the `selfies` write is lease-conditional; a
`matchedCount` of `0` returns without touching the profile and the transaction commits having written
nothing. The profile write is conditional on the selfie write having matched, which is the ordering
the card's alternative wanted, without its hole: profile-first would move the projection **before**
the lease predicate could reject the row, so a reporter that lost the lease could still publish a
result.

**The failure mode this leaves is named:** a transaction that fails to commit (or a callback
rejection) aborts **both** writes, so the pair is never half-applied and the worker's retry finds the
row still `processing` and re-applies. What it does **not** cover is the `withTransaction` retry
budget itself — a genuinely transient failure that outlives the wrapper's three attempts surfaces as
`500 internal_error` and leaves both rows untouched (again retryable), and the error is never
swallowed. The discarded-superseded arm's log (`worker.report_discarded`) is inside the callback
after the selfie write matched, so it still fires only when a write was withheld; the reviewer's
readability note was folded in by nesting the `decision.status !== "skipped"` test once.

### 4. F6 — the event instant is bounded forward, in the route

```ts
const occurredAt = new Date(item.occurredAt);
if (occurredAt.getTime() - now.getTime() > MAX_EVENT_AHEAD_MS) {
  rejected.push({ index, eventKey: item.eventKey, reason: "occurred_at_out_of_window" });
  continue;
}
```

with `MAX_EVENT_AHEAD_MS = 24 h` and `now = systemClock.now()` read once per request. An instant
inside the window is still stamped from the worker's own value through `emitDomainEvent`'s clock seam
(contract §10.3.2), and `unknown_event_key`'s per-item behaviour, indices and reasons are unchanged.

**The window is one-sided, and that is a deviation from the card's wording.** The card asked for
±24 h; [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §6 measured the symmetric form
unsatisfiable against the frozen 30: the lane's own `domainEvent()` fixture posts a fixed
`2026-09-25T09:41:00.000Z`, 52.92 days before the pin run, so an `Math.abs(skewMs)` guard reddens
four frozen cases (`10 failed | 32 passed (42)`) that this card forbids editing. A past instant is
also legitimate — a worker that was offline flushes its backlog — while the _future_ direction is the
one that inflates `expireAt` past the retention. The bound therefore lives in the route, not inside
`emitDomainEvent`: that function's clock seam carries the worker's instant by design, and
`domain-events.test.ts` drives it with `fixedClock(T0)` fixtures a skew check there would redden.

### 5. F7 — one `auth:` stage for the four internal routes

`@/server/auth/internal-hmac` (an existing, already-cited module — no new file, so no new record
under the `adr-consumers` guard) exports:

```ts
export const internalRouteAuth: RouteStage = (ctx, request) =>
  internalAuthStage({
    internalApiSecret: getConfig().internal.apiSecret,
    cronSecret: getConfig().cron.secret,
  })(ctx, request);
```

and the four routes declare `auth: internalRouteAuth`. Behaviour-neutral: the same two secrets, and
`getConfig()` is still called **inside** the stage — i.e. per request, never at import time, which is
what keeps `next build` (which runs without the env) able to import the routes. `getConfig()` is
itself side-effect free at import (`config/env.ts`'s own contract), so the extra edge from the auth
module to it adds no import-time work.

## Consequences

- Any caller that sent a `contentHash` other than the stored asset's, a non-WebP `format`, more than
  100 report items, or an instant more than a day ahead now gets a stable refusal (`422` for the
  three body rules, a per-item `rejected[]` entry for the instant) instead of a write.
- The report's selfie arm now costs one transaction per selfie item. `withTransaction` retries
  transient errors up to three attempts and warns `db.transaction.retry`; a permanent failure answers
  `500 internal_error` with both rows untouched.
- The four routes no longer carry a copy of the secret thunk; a future internal route takes
  `auth: internalRouteAuth` and inherits the same §0.3 policy.
- The wire shapes are untouched: `{accepted,deduped,rejected}`, `{acknowledged,activeSpaceKey,
leaseMinutes,maxAttempts,pauseRequested}`, `{applied,leaseLost,rejected}`, `{status:
"derivatives_ready"}` and their status codes are byte-identical for every legal body.
- **Not pinned here, routed elsewhere:** the reviewer's out-of-scope arms (`worker.report_discarded`
  as a log pin, the null-`activeSelfieId`, `failed` and `skipped` arms) belong to card `t_795ba842`.
  The derivative's `objectKeyRef` binding stays documented-as-opaque; if a handle table is ever
  introduced, §1's decision is the one to revisit.
- `.gitleaks.toml` gains three allowlist entries (`hnd_6b1e4c9a2f7d3085`, `op135-f2-handle`,
  `op135-f4-lease-race`): gitleaks' `generic-api-key` heuristic flags the pins' synthetic handle and
  two suite-local asset tags, the same false positive the file already allowlists for the earlier
  OP-135 fixtures. No test file is touched — the allowlist is scanner configuration, and the values
  are labels, not credentials.

## Alternatives

1. **Bind `objectKeyRef` to the asset.** Rejected in §1: no handle table exists to resolve against,
   so it would mean a new service and a new failure mode for a field the key derivation does not use.
2. **Profile write first, then the selfie row** (the card's fallback if a transaction were not
   viable). Rejected in §3: it publishes the profile before the lease predicate has decided, which
   re-opens exactly the window F4a closes. Kept as the documented fallback only if the transaction
   shape ever stops being viable.
3. **A symmetric ±24 h instant window.** Measured unsatisfiable beside the frozen cases; see §4.
4. **A skew check inside `emitDomainEvent`.** Rejected: it reddens the emitter's own frozen suite and
   moves an admission rule out of the route that owns the request.

## Evidence

Base `origin/OP-135-task-worker-boundary-pins` `2e395e88` (draft PR #624, unmerged), merged into
`origin/main` `a53623e5` (already an ancestor). Lane spec: **42 passed (42)** — the 31 frozen cases,
the superseded-selfie case, and ADR-0834's 11 pins.

Revert probes, each applied alone to the delivered tree, run against the same spec, then restored:

| Probe | Removed guard                                               | Result                                                                                                                                                                                                                                                                |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2    | the `contentHash` comparison                                | `1 failed \| 41 passed (42)` — `F2: refuses a well-formed digest that is not this a…` with `AssertionError: expected 200 to be 422`. The traversal row stays refused because its `format` is not in the allow-list, so the two guards overlap on that body by design. |
| F2b   | the `format` allow-list (`z.enum` → `z.string().min(1)`)    | `1 failed \| 41 passed (42)` — `F2: refuses a format the pipeline never writes …` with `AssertionError: expected 200 to be 422`.                                                                                                                                      |
| F3    | `.max(MAX_BATCH)`                                           | `1 failed \| 41 passed (42)` — `F3: refuses a report one item over the cap before any write` with `AssertionError: expected 200 to be 422`.                                                                                                                           |
| F4a   | the lease keys in `leaseFilter` (back to `{_id}`)           | `1 failed \| 41 passed (42)` — `F4: applies exactly one and never lets the loser overwrite the winner` with `AssertionError: expected [ { applied: 1, …(2) }, …(1) ] to deeply equal [ { applied: +0, …(2) }, …(1) ]`.                                                |
| F4b   | the transaction (both writes sequential, the shipped order) | `1 failed \| 41 passed (42)` — `F4: leaves the selfie row unapplied, so the pair is never half-written` with `AssertionError: expected { …(13) } to deeply equal { …(12) }` (the selfie row is `done`).                                                               |
| F6    | the forward bound                                           | `1 failed \| 41 passed (42)` — `F6: rejects that item only and commits the rest of the batch` with `AssertionError: expected { accepted: 2, deduped: +0, …(1) } to deeply equal { accepted: 1, deduped: +0, …(1) }`.                                                  |

Every probe reddened **only** its own pin(s), and all three production files were restored
byte-identically afterwards (`sha256 ccef607b…`, `80e14b91…`, `4eb0d7f0…`). F7 has no pin (it is
behaviour-neutral) so it has no probe; the four `I5` refusal cases are its regression lock and stay
green. Gates at this head: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`, `eslint` 0 errors,
`prettier --check` clean, the `adr-*` guards green (3 files / 149 cases), the `unit` project
`183 files / 3001 passed | 3 skipped`, and the `integration` project `132 files / 1398 passed`.
