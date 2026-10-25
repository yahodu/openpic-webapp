# ADR-0482 — OP-110 follow-up TEST: the invoice-number decode made total — a malformed percent-escape is a 404 refusal, never a 500

- **Status:** Accepted · **Date:** 2026-10-25
- **Card:** OP-110 follow-up TEST (`t_58320f19`) · **Branch:** `OP-110-task-invoice-number-decode-pin` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_58320f19`
- **Relates to:** [ADR-0480](ADR-0480-op110-self-serve-billing-red.md) / [ADR-0481](ADR-0481-op110-self-serve-billing-green.md) (the invoice route and its `404 not_found` no-asset path this pin extends), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.4 (invoice download), §0.5 (the single-resource envelope), §0.15 (the never-return rule)

## Context

`GET /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}`
(`apps/web/src/app/api/v1/tenants/[tenantId]/billing/invoices/[invoiceNumber]/route.ts`,
landed by ADR-0481) reads its path segment with an **explicit** decode:

```ts
function invoiceNumberFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return decodeURIComponent(segments[segments.length - 1] ?? "");
}
```

The explicit call is deliberate — `new URL(...).pathname` keeps percent-escapes, so the
raw segment has to be decoded before it can be compared to a stored `invoiceNumber`. The
call is, however, **unguarded**, and the segment is user-controlled: a segment that is not
a valid percent-escape makes `decodeURIComponent` throw a `URIError`. No layer catches it
(the pipeline's only `catch` maps unknown throws to `500 internal_error`), so the route
answered **`500`** where every other refusal on this surface is an `AppError` with a
contract code.

The OP-110 round-1 review found this and deliberately did not fix it (the reviewed SHA
`1011550` was frozen), routing it here as a **Low**-severity robustness gap that must
start with a pin.

## Decision

### 1. A malformed `{invoiceNumber}` segment is `404 not_found`, never `500`

The pin added to the lane's integration spec
(`apps/web/src/test/integration/billing-self-serve.test.ts`, in the existing invoices
`describe`) drives an owner-authenticated `GET` for three malformed segments — `%`,
`100%` and `%zz` — and asserts, for each:

```ts
expect(response.status).not.toBe(500);
expect(response.status).toBe(404);
expect(await errorEnvelope(response)).toMatchObject({ code: "not_found" });
```

`404 not_found` is the natural refusal because it is the **same** envelope the route
already serves when no stored asset carries the number (§3.4, ADR-0481 §8): a segment
that is not a valid escape is simply an invoice number nothing is stored under. The
alternative — a `422 validation_failed` from a format schema — was rejected: it would
add a second refusal shape for a miss on a surface that already has one, and §3.4 pins
only the `404`.

### 2. The decode must be **total**

The minimal, behaviour-preserving fix (the gated GREEN sibling) makes the decode
total — `try { return decodeURIComponent(segment) } catch { return segment }` — so a
malformed segment falls through to the ordinary lookup and answers the pinned `404`
with `details.invoiceNumber` naming the raw segment. A valid escape (e.g. `50%25x` →
`50%x`) decodes exactly as before, so no stored-asset lookup changes behaviour.

The route is invoked directly by the integration harness, so the pin needs no Next
layer: `new Request(new URL(…/invoices/%, APP_ORIGIN))` keeps the raw `%` in
`request.url` (verified), which is exactly the input the handler decodes.

### 3. No existing assertion changes

The pin is additive. The pre-existing "answers 404 when no stored invoice asset carries
the number" case is untouched, and no production file, mock, fixture or factory is
edited by this card.

## Evidence

At the pre-fix head (`origin/main` `2be55fb`, the `1.40.0` release on the OP-110 squash
`7ab9780`):

- Focused: `npx vitest run --project integration …/billing-self-serve.test.ts -t
"malformed"` → **3 failed | 34 skipped (37)**, each failure
  `AssertionError: expected 500 not to be 500` — the `URIError` the handler raises is
  visible in the run log as `"name":"URIError"`. The RED is for the right reason: the
  route answers `500`, not a missing module or a type error.
- Whole spec: **3 failed | 34 passed (37)** — the three new pins are the only failures;
  every pre-existing assertion (including the no-asset `404`) stays green.
- Full suite: unit **114 files / 1976 passed | 3 skipped (1979)**; integration
  **83 files / 3 failed | 679 passed (682)** — the delta over `main` is exactly the
  three pins. Nothing else moved.
- `npx tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint `0` problems on the
  touched spec; `prettier --check` clean.

## Alternatives considered

- **Refuse with `422 validation_failed` and a format schema.** Rejected: §3.4 pins one
  refusal for a miss, and a malformed escape is a miss, not a malformed request body.
- **Validate the segment before the decode and refuse anything non-`OP-…`.** Rejected:
  the stored number's shape is not pinned (ADR-0481 §8 leaves the asset's home open), so
  a format gate would invent a contract the lane never agreed.
- **Leave the throw and document the `500`.** Rejected: an unhandled exception on
  user-controlled input is the defect, not a documented behaviour.
- **Weaken the pin to `not.toBe(200)`.** Refused: a `500` and a `404` are exactly what
  the card distinguishes, so the pin asserts both the status and the error code.

## Consequences

- The invoice read is consistent with every other refusal on the self-serve billing
  surface: a contract `AppError`, never an unhandled throw.
- The pins ride in the gated GREEN's PR (the OP-108/OP-109 precedent): the pin branch is
  RED-by-design and cannot merge alone; the GREEN bases its branch on it and turns it
  green without touching an assertion.

## ADR number allocation

The OP-110 lane holds `0480`–`0499`; ADR-0480 (RED) and ADR-0481 (GREEN) are taken, so
this record takes **`0482`**, the `Next free` value the ledger table carried immediately
before committing. The README's `OP-110 self-serve billing lane` row advances to `0483`,
the index gains this row, and the pool cell (`0500`+) is untouched. No number outside the
block is touched.
