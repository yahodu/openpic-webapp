# ADR-0393 — OP-105 follow-up TEST: `normalizeExpiry` refuses a Date-parseable but vendor-misshaped `subscription_expiry_time` (F-1)

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-105 follow-up TEST (`t_d520513d`) · **Branch:** `OP-105-task-expiry-shape-guard-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/OP-105-expiry-shape-guard`
- **Lane:** OP-105 (Payments adapter), reserved range `0380`–`0399` · **Consumes:** `0393`
- **Relates to:** [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) (the port contract; §6 pins `payments.upstream_contract_violation` as the drift signal an on-call engineer is paged on), [ADR-0381](ADR-0381-op105-payment-provider-cashfree-adapter-green.md) (the Cashfree adapter), [ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md) (the F1 pin whose `§Open items` this record resolves), [ADR-0420](ADR-0420-op107-checkout-mandate-creation-red.md) / [ADR-0421](ADR-0421-op107-checkout-green.md) (the checkout route projects `checkout.expiresAt` straight from `createMandate().expiresAt`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Supersedes:** nothing. It **resolves** the `§Open items` line of [ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md) that left "the exact guard for an unparseable value … to the GREEN": the guard is now pinned to also refuse a _wrong-but-parseable_ value, not only an outright-unparseable one.
- **Fixes:** **F-1 — Low** of the round-1 (artifact-lens) review of the OP-105 `expiresAt` GREEN (`t_e2747a56`), routed by the orchestrator decision card `t_d91849b7` (**DECIDED: tighten**). The implementation itself is the gated GREEN (`t_cc5ab12f`, a child of `t_d520513d`) — this record and its spec pin the decision.

## Context

Round-1 review of the OP-105 `expiresAt` GREEN raised **F-1 (Low)**:
`normalizeExpiry(operation, vendorExpiry)` (in
`apps/web/src/server/adapters/cashfree/cashfree-provider.ts`) refused a vendor
`subscription_expiry_time` **only** when `new Date(...)` yielded `Invalid Date`.
A _wrong-but-parseable_ value — a bare date, a partial date, a space-separated
`"2025-06-01 10:20:12"`, a full time with no zone — passed that check and was
silently coerced to an instant.

That is a real defect, not cosmetics, for three reasons:

1. **The wire schema is not a guard.** `cashfreeCreateSubscriptionResponseSchema`
   types `subscription_expiry_time` as `z.string().min(1)`, so _any_ non-empty
   string reaches the adapter. `normalizeExpiry` is therefore the **only** shape
   guard on the value.
2. **A zone-less value is host-dependent.** `new Date("2025-06-01T10:20:12")`
   (and the space-separated and bare-date forms) is parsed by ECMAScript as
   **local** time. The same vendor bytes would then become **different instants
   on different servers** — non-determinism the contract's "every `Timestamp` is
   RFC 3339 UTC ms `Z`" (§0.13) cannot tolerate.
3. **It is the silent-shape-drift class F1 already fixed.** ADR-0380 §6 pins
   `payments.upstream_contract_violation` as the paged drift signal; a value that
   silently changes meaning without a line defeats the whole point of the pin.

The decision (card `t_d91849b7`) is to **tighten** the guard: admit a value only
if it is a full ISO 8601 date-time carrying an **explicit** timezone designator.

## Decision

`normalizeExpiry` accepts `vendorExpiry` **only if** it matches a full ISO 8601
date-time with an explicit zone:

```
YYYY-MM-DD T HH:MM:SS (optional fractional seconds) ( Z | ±HH:MM )
```

literally:

```ts
/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
```

Anything else raises `UpstreamContractError`, exactly like the already-pinned
outright-unparseable case — routed, as the GREEN's choice, through either
`contractViolation(...)` (which also emits a `payments.upstream_contract_violation`
line) or a direct throw, mirroring `parseWebhook`'s unparseable-`event_time`
guard. The two observable paths are indistinguishable on the port.

### What stays admitted

- the vendor's documented form `2025-06-01T10:20:12+05:30` (Cashfree types the
  field `string<ISO8601>`; re-verified against the live Create Subscription
  reference on 2026-10-25 — ISO 8601 with an explicit IST `+05:30` offset,
  second precision, no ms, no `Z`), and
- a _more_ canonical value (`...Z`, optional ms).

Both were already pinned by [ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md) §I1
and **must stay green**; this record does not weaken them.

### What is refused (the new pin)

Each of these is Date-parseable but is **not** the vendor's shape, and each must
raise `UpstreamContractError`:

| Input                 | Why it is a defect (yet `new Date()` accepts it)         |
| --------------------- | -------------------------------------------------------- |
| `2025-06-01`          | bare date, no time-of-day                                |
| `2025`                | partial date                                             |
| `2025-06-01 10:20:12` | space separator, no zone — parsed as **host-local** time |
| `2025-06-01T10:20:12` | full time but no zone — parsed as **host-local** time    |
| `not-a-timestamp`     | already pinned by ADR-0392 §I2 — kept, not re-decided    |

## The pin

`apps/web/src/test/integration/payments-cashfree-expiresat.test.ts` (MSW) gains
an **I3** `it.each` over the four misshaped inputs. Each row:

- asserts **on the input** that `new Date(vendorExpiry)` is a _valid_ instant
  (`Number.isNaN(...) === false`) — the trap the pin exists for, so the row can
  never be satisfied vacuously by a value `Date` already rejects — and that the
  input carries **no explicit zone designator** (`Z` or `±HH:MM`), which is
  precisely the property whose absence makes the parse host-local;
- drives the port with that value on the wire and asserts
  `provider.createMandate(...)` **rejects** with `UpstreamContractError`,
  mirroring the ADR-0392 §I2 row.

The ADR-0392 §I1 rows (offset-bearing vendor form → RFC 3339 UTC ms `Z`, with the
per-row assertion that the input is offset-bearing and has neither ms nor `Z`) and
the §I2 unparseable row are unchanged and stay green.

## Evidence at the RED head

- Focused integration spec
  `apps/web/src/test/integration/payments-cashfree-expiresat.test.ts`:
  `Tests 4 failed | 4 passed (8)` — the four new **I3** rows fail at assertion
  level against the current lenient guard:
  `AssertionError: promise resolved "{ externalRefs: [ { …(4) } ], …(2) }" instead of rejecting`,
  e.g. `"2025-06-01"` → `expiresAt: "2025-06-01T00:00:00.000Z"` and
  `"2025-06-01T10:20:12"` → `expiresAt: "2025-06-01T10:20:12.000Z"`. The four
  passing rows are the ADR-0392 §I1 rows (3) plus §I2.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 problems and
  `prettier --check` clean on the touched spec; the `adr-numbering` guard green.
- **Test files + this ADR + `docs/adr/README.md` only** — no production, mock,
  fixture or factory file is touched.

## Open items

- The **guard's exact encoding** (a literal regex vs. a stricter `Date` +
  round-trip comparison) is the GREEN's choice; the pin fixes only the
  _observable_ — the four misshaped forms reject, the offset-bearing form and
  `...Z` stay admitted.
- `ADR-0392` §Open items also noted the port's now-inaccurate doc comment ("The
  vendor's expiry for that URL") and the live-sandbox spec's non-empty-string
  assertion. Both remain the GREEN's to amend; neither is in this card's scope.
- **Frozen records.** [ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md) and
  [ADR-0380](ADR-0380-op105-payment-provider-port-red.md) are **not edited** by
  this record; a docs sign-off card (`t_e57e133f`) appends to them concurrently.
  This record resolves the ADR-0392 §Open-items line by _reference_, not by
  rewriting it.

## ADR number allocation

The OP-105 lane holds `0380`–`0399`. The orchestrator reserved `0393` for this
card (decision `t_d91849b7`). `0380`–`0391` are consumed on the trunk (the port
RED/GREEN pair, the live-sandbox record, the memory-provider RED/GREEN pair, the
F1 import-boundary pair and the F3/F5 request-projections pair) and `0392` by
[ADR-0392](ADR-0392-op105-expiresat-rfc3339-pin.md) — all count as taken under
[ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §7 — so this record
takes **`0393`**, the number the orchestrator reserved for this card (decision
`t_d91849b7`), and the lane's `Next free` cell is advanced to `0394`. The README
`Next free` cell is a snapshot, not the authority: `0393` was reserved by the
orchestrator irrespective of the cell's value. No number outside the lane range
`0380`–`0399` is touched.

## Evidence at the GREEN head

The gated GREEN (`t_cc5ab12f`, branch `OP-105-task-expiry-shape-guard-pin`,
inheriting this pin's branch) implemented the guard in
`apps/web/src/server/adapters/cashfree/cashfree-provider.ts`:

- A module-level `VENDOR_EXPIRY_SHAPE` pins the admitted shape, and
  `normalizeExpiry` now refuses whenever `!VENDOR_EXPIRY_SHAPE.test(vendorExpiry)`
  **or** the resulting instant is `NaN` — both through the existing
  `contractViolation(...)` helper, so `payments.upstream_contract_violation`
  still fires. The conversion `new Date(<value>).toISOString()` is unchanged.
- **Encoding note.** The pattern is written as two alternations —
  `…:\d{2}\.\d+(?:Z|±HH:MM)$` for the fractional case, `…:\d{2}(?:Z|±HH:MM)$`
  for the whole-second case — rather than the equivalent `(\.\d+)?` group. The
  nested quantifier triggers `security/detect-unsafe-regex`
  (`eslint-plugin-security` recommended set) as a spurious catastrophic-backtracking
  warning; the two forms were proved to accept exactly the same language over a
  202,400-case differential sweep (structured variations + random garbage, 0
  differences against the literal pinned above). No lint suppression is used.

Evidence, all run in the inherited worktree with `TMPDIR=/root/tmp-mongo` for
integration:

- Focused integration spec
  `apps/web/src/test/integration/payments-cashfree-expiresat.test.ts`:
  `Tests 8 passed (8)` — the four new **I3** rows are green, and the ADR-0392 §I1
  (3) + §I2 rows stay green.
- Full `--project unit`: `Test Files 110 passed (110)` · `Tests 1914 passed | 3 skipped`.
- Full `--project integration`: `Test Files 79 passed (79)` · `Tests 587 passed`.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` **0 problems**
  on the changed production file; `prettier --check` clean.
- **Production file + this ADR only** — no test, mock, fixture or factory file
  touched beyond the parent pin; no `NODE_ENV`/`process.env`/test-mode
  conditional; no dependency added; no lint suppression.
