# ADR-0103 — OP-96 follow-up: tighten the I5 `{status, until}` partial-index pin to require the filter scopes to `deferred`

- **Status:** Accepted · **Date:** 2026-10-06 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_8113a184` (OP-96 follow-up TEST, parent of GREEN `t_609968cf`; finding F2 of ADR-0102) · **Stage:** RED (test only; no production code)
- **Contract under test:** ADR-0100 (§5 / contract §10.2 `quiet-hours-release`) · ADR-0101 (phase-1 RED sign-off) · ADR-0102 (RED-pins review sign-off, finding F2)
- **Branch:** `OP-96-task-digest-retry-quiet-hours-crons-red` (red-CI by design; commit + push, never merge — the GREEN PR carries the pins)

## Context

The quiet-hours release sweep selects
`notificationDispatches` rows with `status: "deferred"` and `until <= now`
(design §5; contract §10.2). ADR-0100 requires the `dispatches` collection to
carry a **partial** index on `{status, until}` scoped to exactly those rows, so
the sweep keeps index support as the collection grows.

The integration spec
`apps/web/src/test/integration/notification-quiet-hours-release.test.ts`
pinned that requirement only weakly: it required the `{status, until}` index to
carry a **non-null** `partialFilterExpression`, but not that the filter scopes
to `deferred`:

```ts
const partial = sweepIndex?.partialFilterExpression;
expect(typeof partial === "object" && partial !== null).toBe(true);
```

Any partial filter satisfies that — including a wrong one such as
`{status: "sent"}` — in which case the release sweep would silently lose its
index support while the pin stayed green. ADR-0102 routed this as finding F2
(Low) to this card, a parent of the GREEN card, so the tightening lands before
implementation.

## Decision

### 1. The I5 index pin now asserts the filter scopes `status` to `"deferred"`

The weak non-null assertion is replaced by a structural predicate:

```ts
expect(scopesStatusToDeferred(sweepIndex?.partialFilterExpression)).toBe(true);
```

`scopesStatusToDeferred` returns `true` only when the filter references
`status` with the value `"deferred"`. It is deliberately **structural, not
literal**, so it does not over-fit MongoDB's normalisation:

- accepts the literal form `{status: "deferred"}`;
- accepts the normalised form `{status: {$eq: "deferred"}}`;
- accepts the set form `{status: {$in: ["deferred"]}}`;
- searches recursively (arrays and nested objects), so a filter wrapped in
  `$and` / `$or` still counts;
- returns `false` for any other status (`"sent"`, `"pending"`, …), for a
  missing/`null` filter, and for non-objects.

A filter that merely _contains_ `deferred` elsewhere (e.g. a nested
`$in: ["sent", "deferred"]`) is accepted only because `deferred` really is in
the scoped set — the predicate is about which statuses the index covers, not
about string presence.

### 2. Only the I5 index block changes

The deferral (`quiet-hours deferral is durable (I5)`), release, `limit` (I11)
and idempotency (I12) blocks are untouched, as is every other spec. The
tightened I5 pin is red-verified through the file's existing module-not-found
import and stays satisfied by a correct GREEN index.

### 3. Nothing else is weakened or loosened

The `expect(sweepIndex).toBeDefined()` guard is kept. No timeouts, skips,
`@ts-ignore` or suppression comments are introduced.

## Consequences

- The GREEN implementation of `ensureIndexes` must add the `{status, until}`
  index on `dispatches` with a `partialFilterExpression` that scopes to
  `status: "deferred"` — a plain compound index, or one scoped to any other
  status, now fails I5 loudly.
- **Integration:** `4 failed | 40 passed` files, `297 passed` — identical to the
  pre-tightening evidence; the four failures remain module-not-found for the
  not-yet-built OP-96 modules/routes, `notification-quiet-hours-release.test.ts`
  at import line 12. **Unit:** `2 failed | 79 passed` files, `1444 passed`
  (module-not-found only). `tsc -p apps/web/tsconfig.json --noEmit` reports
  exactly the same **8 TS2307** and no other error. Prettier and ESLint clean.
- No production file is modified by this card. The tightened pin ships inside
  the gated GREEN PR on the same branch.
- **Numbering hotspot:** `origin/main` has advanced past this branch's base and
  now claims `ADR-0100`–`ADR-0103` for the OP-95 lane, so this branch's OP-96
  block (`0100`–`0103`) collides numerically. As already recorded in ADR-0102
  and the ADR README, the whole block is renumbered as a contiguous unit at
  integration; this ADR takes the branch-local next sequential number (`0103`)
  to keep that renumber trivial.

## Alternatives considered

- **Keep the non-null assertion and add a comment** — rejected: the reviewer's
  finding is that a wrong filter passes; a comment does not make it fail.
- **Assert the exact literal `{status: "deferred"}`** — rejected: Mongo may
  normalise the filter and a legitimate `$eq` / `$in` encoding would be
  rejected, over-fitting the assertion to a representation instead of the
  contract (scoped to `deferred`).
- **Assert MongoDB's normalised AST / `$eq` only** — rejected: it would reject
  the plain literal form that every existing index in `indexes.ts` uses.
- **Search for the string `"deferred"` anywhere in the serialised filter** —
  rejected: it would pass a filter scoped to the wrong status that merely
  mentions `deferred` (e.g. `{status: {$in: ["sent"]}, note: "deferred"}`),
  reintroducing the F2 false-negative.
