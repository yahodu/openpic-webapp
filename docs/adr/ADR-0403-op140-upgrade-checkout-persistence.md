# ADR-0403 — OP-140 precondition (billing): persist `checkout` on the upgrade mint path and expose a stored-checkout read seam

- **Status:** Accepted · **Date:** 2026-11-23
- **Lane:** OP-106 (Subscriptions), reserved range `0400`–`0419`
- **Card:** `t_0c9f26df` (OP-140 precondition TEST — billing), worktree
  `/root/openpic/openpic-webapp/.worktrees/op140-precondition-billing-mandate`,
  branch `OP-140-task-precondition-billing-mandate`, off `origin/main`
  `4d987ddfccd3947b8f2cae542296a2523fb46a78` (PR #851; the card's base
  `da4e24cc` moved forward, every file:line it names still holds)
- **Consumes:** `0403`
- **Gated GREEN:** `0404`, assignee `openpic-webapp-backend-coder`, worktree
  `/root/openpic/openpic-webapp/.worktrees/op140-precondition-billing-mandate-green`,
  based on this branch's head, carrying the spec **byte-identically**
- **Fixes:** the billing row of ADR-0942 §2 — the §7.3 row
  `subscription × complete_mandate` is deferred because "the **upgrade** path
  mints a row without [`subscriptions.checkout`], and no delegate can read it"
- **Supersedes nothing.** ADR-0420 (checkout RED), ADR-0421 (checkout GREEN),
  ADR-0460 (plan-change RED) and ADR-0942 (OP-140 endpoint RED) stand unchanged;
  this record narrows the gap ADR-0942 named and adds no new contract beyond it

## Context

The OP-140 notification-action endpoint delegates each contract §7.3 row to the
owning document. For `subscription × complete_mandate` the contract says the
delegate "returns the stored `checkout.url`". ADR-0942 §2 measured the gap on
`45a571ba` and its correction stands:

| Path                      | `subscriptions.checkout` written? | Evidence                                                                                                                                                                                                        |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST …/billing/checkout` | **yes**                           | `apps/web/src/app/api/v1/tenants/[tenantId]/billing/checkout/route.ts:416-422` — `{ url, expiresAt: new Date(mandate.expiresAt) }`, reused by the `reuse` arm (`server/services/subscriptions/checkout.ts:163`) |
| `POST …/billing/upgrade`  | **no**                            | `apps/web/src/app/api/v1/tenants/[tenantId]/billing/upgrade/route.ts:336-377` — `insertOne` carries `externalRefs` but no `checkout`; the URL is returned inline at `:412-416` and `:420` only                  |

Re-measured on `4d987ddf`: both statements hold. So a subscription minted by the
**upgrade** path has no stored URL, and there is no seam a delegate can call to
read one. `subscriptionId` is an `ObjectId`, so the row already satisfies the
endpoint's 24-hex `actionTarget.id` guard (`route.ts:118-127`); no contract change
is owed for the id itself.

## Decision

### 1. The upgrade mint path persists the same two fields the checkout path writes

```ts
const expiresAt = new Date(mandate.expiresAt);
// …inside the existing withTransaction:
checkout: { url: mandate.checkoutUrl, expiresAt },
```

Same field names, same values, same **derivation** of `expiresAt` — the mandate's
own instant, exactly as `billing/checkout/route.ts:416-422` computes it. No
invented TTL and no copied constant: `I1` asserts the stored instant against the
**vendor fixture's** `subscription_expiry_time` as well as against the response
envelope, so a row that stored `now + <constant>` reddens (proved below).

### 2. A read seam in `@/server/services/subscriptions`

Recommended module `apps/web/src/server/services/subscriptions/stored-checkout.ts`,
re-exported by the lane's barrel (`index.ts`, the surface the route layer and a
delegate both import):

```ts
export interface StoredCheckout {
  readonly url: string;
  readonly expiresAt: Date;
}

export function readStoredCheckout(input: {
  readonly db: Db;
  readonly subscriptionId: ObjectId;
}): Promise<StoredCheckout | null>;
```

- It answers the **named row's own** `checkout` block. `null` when that row stores
  none, and `null` when no row carries that `_id`; neither absence throws.
- The input is `{ db, subscriptionId }` — **id-keyed, not tenant-keyed**. The
  delegate will hold the row's own id (`actionTarget.id`, the 24-hex form of the
  same `ObjectId`); it never holds a tenant id. The read is therefore a
  platform-scope lookup by `_id` (`collectionHandle(db, COLLECTIONS.subscriptions)`
  in the recommended implementation), not a `tenantRepo` scoped read.
- The `ObjectId` is the accepted input. A caller holding the 24-hex string
  converts it at the call site (`new ObjectId(actionTarget.id)`); widening the
  seam's input to `ObjectId | string` is permitted but not required, and the pins
  do not fence it either way.

### 3. The spec pins behaviour, not field shape

`apps/web/src/test/integration/billing-stored-checkout.test.ts` drives the **real
route modules** with the Cashfree adapter selected and MSW answering the vendor
calls, then reads the value back **through the barrel seam** — the arrow a
delegate will use. No assertion inspects the stored document's shape; every
assertion is "what the mint handed the caller, the seam answers back for that
subscription".

| Case | Pins                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `I1` | the upgrade mint answers the mandate's link **and expiry** through the seam (`{ url, expiresAt }` deep-equal, plus the instant compared with `new Date(UPGRADE_MANDATE_EXPIRES_AT)` and with the response's `checkout.expiresAt`) |
| `I2` | the seam answers the **named** row: after the upgrade, the cancelled predecessor (link-less) answers `null` while the minted row answers its link — a "newest row" read fails here                                                |
| `I3` | the checkout mint keeps answering its **own** link (`reuse` arm's dependency), on a second, different vendor fixture                                                                                                              |
| `I4` | a row that stores no hosted link answers `null`                                                                                                                                                                                   |
| `I5` | an id that names no subscription answers `null`                                                                                                                                                                                   |

The seam is resolved through a typed guard against the barrel namespace, so the
absent seam fails with
`@/server/services/subscriptions must export readStoredCheckout({ db, subscriptionId }) answering { url, expiresAt } | null`
rather than `TypeError: … is not a function` — a missing **export** of an
existing module is not a load error.

## Evidence

Branch point `4d987ddf` + this spec (no production change, `git status --short`
shows only the spec):

```
× I1: a subscription minted by the upgrade path answers the mandate's link and expiry through the seam
× I2: the seam answers the named row, not the workspace's newest subscription
× I3: a subscription minted by the checkout path keeps answering its own link through the seam
× I4: a subscription that stores no hosted link answers null
× I5: an id that names no subscription answers null
Error: @/server/services/subscriptions must export readStoredCheckout({ db, subscriptionId }) answering { url, expiresAt } | null
Test Files  1 failed (1)
     Tests  5 failed (5)
```

The routes themselves succeed in `I1`–`I3` (the guard is reached only after a
`201`), so the branch-point red is the missing seam and nothing else.

**Near-fix A — the seam only, no mint-path change** (`stored-checkout.ts` +
barrel export, the upgrade route untouched). This is the red that names the
missing persistence:

```
× I1: a subscription minted by the upgrade path answers the mandate's link and expiry through the seam
× I2: the seam answers the named row, not the workspace's newest subscription
AssertionError: expected null to deeply equal { …(2) }
AssertionError: expected undefined to be 'https://payments-test.cashfree.com/li…'
     Tests  2 failed | 3 passed (5)
```

`I3`–`I5` are green under near-fix A: the checkout path already persists the
field and the two `null` arms already hold. So the seam is satisfiable and the
upgrade persistence is the only missing half.

**Near-fix B — A plus the two-line upgrade write** (`checkout: { url:
mandate.checkoutUrl, expiresAt }`): `Tests 5 passed (5)`.

**Discrimination probes on near-fix B** (each restored byte-identically, `git
diff` empty afterwards):

- storing `expiresAt: new Date(Date.now() + 86_400_000)` instead of the
  mandate's instant → `I1` fails `expected { …(2) } to deeply equal { …(2) }`
  (1 failed | 4 passed), so the "no invented TTL" half of `I1` bites;
- reading the collection's newest row (`findOne({}, { sort: { updatedAt: -1 } })`)
  instead of `{ _id }` → `I1`, `I2`, `I4`, `I5` fail (4 failed | 1 passed), so the
  "named row" half bites.

The near-fix was then deleted (`git checkout --` on the two touched production
files, `rm -f` on the new module) and `git status --short` shows only the spec.

`pnpm typecheck` exits `0` with the spec alone (the RED is type-correct: the guard
pattern compiles), `eslint` reports 0 problems and `prettier --check` is clean on
the spec.

## Consequences

- `I3` guards the `reuse` arm: a GREEN that "helpfully" rewrote the checkout path's
  stored block (or moved the field) reddens here.
- The seam is id-keyed, so it does **not** enforce tenant scoping. That is
  deliberate and safe for this consumer — the id comes from a row our own emit
  wrote — but a future tenant-facing caller must not reuse it as an
  authorisation-free read.
- **Out of scope, recorded rather than guessed:** a malformed (non-24-hex) id is
  unreachable for the delegate (the endpoint's `actionTarget.id` guard),
  so the seam's behaviour on one is not pinned; a row whose `checkout.expiresAt`
  is stored as a string instead of a `Date` is likewise unpinned (every mint path
  writes a `Date`), and the recommended implementation answers `null` for it
  rather than throwing.
- **The reversal condition (the OP-140 lanes' gate).** When every mint path
  persists `checkout` and this lane's seam can read it back, the OP-140
  `subscription × complete_mandate` arm and its pin can be written (owner: OP-140
  notifications lane).
- The delegate arm itself is **not** written here: the OP-140
  `notification-actions.ts` / `actions/[actionKey]/route.ts` / `fan-out.ts` /
  `notification-types.values.ts` files are walled off from this lane so two lanes
  never edit one route.
- No ledger number outside the lane range `0400`–`0419` is touched. This record
  takes `0403`; the gated GREEN takes `0404` and writes no ledger row, so the
  lane's `Next free` cell advances to `0405`.

## Alternatives considered

- **Persist the link in the upgrade response only (status quo).** Rejected by the
  contract: the §7.3 delegate must read the **stored** `checkout.url`; a value that
  exists only in the response body of a request that already returned is
  unreadable by a later delegate.
- **Write `checkout.expiresAt` from a fixed TTL.** Rejected: the mandate's
  `expiresAt` is the vendor's decision, and `I1` pins the stored instant to the
  vendor fixture; a TTL would silently disagree with the hosted link's real
  lifetime.
- **Reuse `readSubscriptionView` / `decideExistingSubscription` as the read
  seam.** Rejected: both are tenant-keyed (`readSubscriptionView(db, tenantId, …)`
  answers the workspace's view, not a named row) and the latter is the checkout
  decision function, not a reader. A delegate holding a row id needs an id-keyed
  read.
- **Return the whole stored block (`{ kind, url, expiresAt }`) or the raw row.**
  Rejected: §0.15/§0.5 keep the served surface to what the consumer needs, and the
  delegate answers `checkout.url`; `{ url, expiresAt }` is the smallest honest
  shape.
- **Assert the inserted document directly in the spec.** Rejected: the card asks
  for a behaviour pin, and the seam is the observable a delegate will depend on —
  asserting the row's shape would let a seam with a different shape pass.
- **Add the delegate arm and its OP-140 pin in this lane.** Rejected: the endpoint,
  the fan-out and the catalogue are the OP-140 notifications lane's files; the
  reversal condition above names the handoff.

## ADR number allocation

`0400` is consumed by [ADR-0400](ADR-0400-op106-subscription-read-red.md), `0401`
by [ADR-0401](ADR-0401-op106-subscription-read-green.md) and `0402` by
[ADR-0402](ADR-0402-op106-subscription-read-followup-pins.md), so this record
takes `0403`, the lane cell's value re-read at the branch cut immediately before
committing. The sweep for `0403`/`0404` covered this trunk, every
`.worktrees/*/docs/adr` tree, `git rev-list --objects --all -- docs/adr`, the open
PR heads and the non-done card bodies: no `ADR-0403`/`ADR-0404` record exists
anywhere, so the reserved number stands. The gated GREEN consumes `0404` and
writes no ledger row, so the `OP-106 subscriptions lane` `Next free` cell advances
to `0405` — past both numbers. The `unallocated (future lanes)` pool cell is
**not** touched (`0420`+).
