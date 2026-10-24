# ADR-0320 — OP-102 RED: the public plans endpoint — generic `display` formatter, version-derived ETag, ignored `includeInactive`, and a separate add-on catalogue

- **Status:** Accepted · **Date:** 2026-10-24
- **Card:** OP-102 RED (`t_fc7396d9`) · **Branch:** `OP-102-task-public-plans-endpoint` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_fc7396d9`
- **Relates to:** [ADR-0014](ADR-0014-plans-catalogue-schema-and-seed.md) (the `plans` catalogue), [ADR-0006](ADR-0006-cursor-pagination-and-etag.md) (ETag / conditional-request helpers), [ADR-0220](ADR-0220-op98-notification-preferences-red.md) (a catalogue label is not a contract), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.1 (plans), §3.6 (add-ons), §0.10 (ETags), §0.15 (never-return) · **Schema:** §14.1, §14.2

## Context

OP-83 seeded the `plans` catalogue (schema §14.1) and OP-81 shipped the
conditional-request helpers (ADR-0006); OP-102 is the story that finally
**serves** the catalogue so the pricing page is driven by data and pricing copy
changes need no deploy.

The card pins only the _behaviours_ it wants (`U1` display formatter, `U2` ETag
stability, `I1`–`I4` response contract, `E1` conditional `GET`); it does not pin
module paths, the formatter's semantics, how the ETag is derived, whether an
unauthorised `includeInactive` is ignored or refused, or whether add-ons are a
sibling endpoint or a field inside `GET /plans`. ADR-0014 §Consequences
explicitly deferred "the `display` projection, the `active: false` inclusion
rule and the `externalRefs` never-return strip" to _this_ story, so the
decisions belong here.

The GREEN sibling card `t_1156c7ad` carries the orchestrator's scope note and
narrows two of them: the projection is a **generic** formatter ("bytes -> GB,
limits, feature enabled"), and the add-on listing may be "`GET /addons?currency=INR`
**or** `addons[]` inside `GET /plans`". Everything else is settled below.

## Decision

### Module contract

| Module (specifier)            | Exports                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@/server/plans/plan-display` | `formatBytes(bytes: number): string`, `formatEntitlementDisplay(key: string, spec: Entitlement): string` |
| `@/server/plans/plan-etag`    | `planCatalogueETag(entries: readonly { key: string; version: number }[]): string`                        |
| `@/app/api/v1/plans/route`    | `GET` (public, `{ data: Plan[] }`)                                                                       |
| `@/app/api/v1/addons/route`   | `GET` (public, `{ data: Addon[] }`)                                                                      |

### 1. The entitlement `display` is produced by a **generic** formatter

`formatEntitlementDisplay(key, spec)` resolves in this order, so a `feature`
spec whose `limit` is `null` renders as a gate and never as "Unlimited":

1. `enforcement === "feature"` → `"Included"` when `enabled === true`, else `"Not included"`;
2. `limit === null` → `"Unlimited"`;
3. a key ending in `.bytes` (or `storage.bytes`) → `formatBytes(limit)`;
4. otherwise → `String(limit)` — a **bare integer**, never locale-grouped.

`formatBytes` renders binary GB (`1024**3`), at most one decimal place with a
trailing `.0` removed: `2147483648` → `"2 GB"`, `536870912` → `"0.5 GB"`.

Two properties are deliberate:

- **It never switches on a key list.** Contract §3.1 requires that "adding an
  entitlement key is a data edit with zero API change" and that clients "render
  unknown keys generically from `display`", and the GREEN card's acceptance
  criterion is "unknown entitlement keys still get a display string". A
  per-key copy table would make the guarantee conditional on copy having been
  written; the generic rule is total.
- **Counts are not locale-formatted.** `toLocaleString()` would make the served
  body depend on the runner's default locale, so the same request could answer
  differently on two machines. `String(limit)` is deterministic.

### 2. The ETag is a function of the plan **versions** only

`planCatalogueETag` maps the served plans' `(key, version)` pairs to a tag:
unchanged versions revalidate to `304`, and any entitlements change (which bumps
`version` by exactly one — ADR-0014 §6) changes the tag so no client keeps
stale limits. Adding or removing a plan changes it too.

The tag's **shape** is not pinned (weak vs strong, hash vs join) and neither is
order-independence: the route sorts by `tierRank` before computing, so ordering
is already deterministic, and pinning it in the unit spec would constrain a
layer the route does not rely on. The conditional-request plumbing itself is
already pinned by `conditional-etag.test.ts` (OP-81).

**Accepted consequence:** a _copy-only_ edit (`name`, `description`,
`marketingFeatures`) does not bump `version`, so it does not invalidate a cached
response; `max-age=300` bounds staleness to five minutes. This matches the
card's U2 ("stable for the same versions") exactly and is the reason
`version` — not `updatedAt` — is the tag input.

### 3. `?includeInactive=true` without admin is **ignored**, not `403`

The card offered "ignored/403 per decision (document)". The public route
**ignores** the flag: a caller who is not a platform admin never sees an
`active: false` plan, and the response is still `200` with the active catalogue.

Rationale: §3.1 makes a retired plan hidden-for-new / visible-for-existing, so a
public pricing page has no use for it; the one surface that legitimately reads
full plan documents (including `prices[].externalRefs`) is §9.3
`/admin/plans`. Refusing with `403` would advertise an admin-only query surface
to anonymous callers and force an optional-auth branch into a route that is
otherwise `public` — machinery with no product value. This mirrors the
notification catalogue, where an unknown `category`/`audience` filters to an
empty list rather than erroring ("the query is a filter, not a validated enum",
ADR-0220).

Only the **without-admin** behaviour is pinned. Whether the GREEN additionally
lets a real platform admin include retired plans on this route is left open
(unpinned) — it cannot break any delivered spec.

### 4. Add-ons get their own endpoint: `GET /api/v1/addons`

Of the two shapes the GREEN card allowed, the separate endpoint is chosen, so
that:

- `GET /plans` stays exactly the §3.1 Plan list body. `I1` parses it with a
  `.strict()` Zod schema, and an `addons[]` sibling key would either break that
  pin or force the schema to admit a field §3.1 does not describe;
- each catalogue carries its own cache/ETag without re-versioning the other;
- `addons` is platform-scope policy-as-data, a peer of `plans`, and the eventual
  `POST /tenants/{tenantId}/billing/addons` (OP-110) buys one by `addonKey`.

**Stored document** (`addons` collection, platform scope) — no §14.x row exists
for it, so this ADR is its schema of record:

```ts
{ addonKey, name, description, entitlementKey, unit,
  quantity: { min, max }, prices: PlanPrice[], active }
```

**Served item** (`{ data: Addon[] }`) — the stored shape minus the price
lifecycle fields and never with `externalRefs` (§0.15), plus a `display`
string:

```ts
{ addonKey, name, description, entitlementKey, unit,
  quantity: { min, max }, prices, display, active }
```

`prices` follows `GET /plans`: only `active: true` prices, optionally filtered
to the `currency` query, projected without `validFrom`/`validUntil`. Only
`active: true` add-ons are served (a retired top-up stays for history but is
hidden, exactly as with plans). `display` is pinned only as a **non-empty
string**: the exact copy is a product decision, precisely as ADR-0220 held for
the notification catalogue `label`. An `addons` index and a seed/values module
are explicitly **out of scope** (they belong to index bootstrap / OP-110), so
the specs insert add-on documents directly.

### 5. Cache headers, status and revalidation

Both endpoints answer `Content-Type: application/json; charset=utf-8`,
`cache-control: public, max-age=300` (§3.1, Diagrams §"Cache-Control by
endpoint") and an `ETag`; a matching `If-None-Match` answers a bodyless `304`
carrying the current tag.

### 6. Ordering and inclusion on `GET /plans`

Active plans only, ascending `tierRank` (so "upgrade or downgrade?" is a
comparison — schema §14.1), `entitlements` verbatim from storage plus
`display`, `prices` filtered to `active: true` and to `currency`/`billingCycle`,
and `contactSalesUrl: "/contact-sales"` on the sales-assisted tiers (§3.1).

## Consequences

- A mis-formatted `display`, a locale-dependent count, an unstable ETag, a
  leaked `externalRefs`, a retired plan on the pricing page, or a USD price on
  an INR request now fails the suite loudly.
- `GET /plans` and `GET /addons` are new public, cacheable, rate-limited reads;
  both must be declared on `defineRoute` so the shared security headers and the
  serialization/never-return controls apply.
- **Open question / assumption (§3.1 copy).** The contract's §3.1 worked
  example shows key-specific prose (`"1 active event / month"`, `"500 images /
event"`, `"7-day gallery"`, `"Original downloads"`). The generic formatter
  deliberately does **not** reproduce it: the card asks for a generic formatter
  and for unknown keys to render, and hard-coding those strings would recreate
  the "hard-coded key list" the contract forbids. The example strings are
  therefore treated as illustrative copy, not a pinned contract; if product
  wants them verbatim, a follow-up card adds a key→copy map _on top of_ the
  generic fallback (which must keep satisfying every unknown key).
- **Open question / assumption (add-on schema).** The add-on document and served
  item exist only in this ADR; OP-110 owns its seed/values and the purchase
  flow, and must not silently diverge from the shapes pinned here.
- **Unpinned:** admin inclusion of retired plans on the public route; the ETag
  token format; the exact `display` copy for add-ons; price/plan ordering beyond
  `tierRank`.

## Alternatives considered

- **A key→copy display table** (`events.active` → `"1 active event / month"`).
  Rejected: it turns "adding an entitlement key is a zero-API-change data edit"
  into "an unknown key renders blank", contradicting the card's own acceptance
  criterion, and it re-couples the API to a prose list.
- **`toLocaleString()` for counts.** Rejected: the served body would depend on
  the process locale — the same ETag could cover two different bodies.
- **`addons[]` inside `GET /plans`.** Rejected: it breaks the strict §3.1 Plan
  list schema the `I1` pin parses and couples two catalogues' cache/ETag and
  versioning.
- **`403` for `includeInactive` without admin.** Rejected: it leaks an
  admin-only query surface, forces optional-auth plumbing into a public route,
  and buys nothing for the pricing page.
- **Deriving the ETag from `updatedAt` / the whole document.** Rejected: the
  card pins "stable for the same versions", and a full-document tag would let a
  copy-only edit change the tag while `version` (what a subscription records)
  stayed put.
- **Asserting the exact §3.1 display strings.** Rejected for the reason in
  Consequences: the strings are product copy, and the card's generic-formatter
  scope supersedes them.

## ADR number allocation

This lane (`OP-102`) had no reserved range in [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md),
so, acting as the first card of the lane, it draws the next block from the
allocator's `unallocated (future lanes)` pool — `0320`–`0339` — and consumes
`0320` for this record. The README table gains an `OP-102 plans & billing lane`
row with `Next free = 0321` and the unallocated pool advances to `0340`+.
