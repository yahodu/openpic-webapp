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

## Review sign-off — 2026-10-25 (card `t_7f9ccfa0`, round 1 · artifact lens)

**Verdict — approved and landed.** The round-1 review of the OP-110 invoice-number
decode passed with no changes requested and **zero reviewer edits** to the
deliverable — this section is the only thing the review wrote. The lane shipped as PR
[#346](https://github.com/yahodu/openpic-webapp/pull/346), squash-merged to `main` as
`c2ebc589`; the release bot then advanced the trunk to `1d1943b`
(`chore(release): 1.40.1 [skip ci]`). The reviewed head was
`85f50b0543544c047dbe5df33a13eff4579a3e4d`, stacked on the pins head `2418ce7`.

**Tree identity — the reviewed paths are preserved.** Restricted to the PR's
deliverable paths the branch head and the squash are byte-identical (`git diff 85f50b0
c2ebc589 -- docs/adr/ADR-0482-… apps/web/src/app/api/v1/tenants/[tenantId]/billing/invoices/[invoiceNumber]/route.ts`
is empty). The whole-tree `git diff --name-only 85f50b0 c2ebc589` is **not** empty: it
lists exactly three **trunk-owned** files added while the PR was open by the two
concurrent lane merges ([#345](https://github.com/yahodu/openpic-webapp/pull/345), the
ADR-0308 ledger note; [#343](https://github.com/yahodu/openpic-webapp/pull/343), the
ADR-0481 sign-off) plus the shared `docs/adr/README.md` ledger — every differing line
is trunk's own text, so the squash carries no invented content. (The handoff's
shorthand "`git diff --stat 85f50b0 c2ebc589` empty" holds only of the reviewed paths;
it is recorded here in that precise form.)

**Evidence the reviewer re-derived.** `git diff 2418ce7..85f50b0` is exactly the one
production file, `…/invoices/[invoiceNumber]/route.ts` (**16 insertions / 2
deletions**); no other production, test, mock, fixture or factory line moved. The
focused integration spec `billing-self-serve.test.ts` is **37 passed (37)** — re-run
at the reviewed head and again on the merged trunk `1d1943b`. The `adr-numbering`
guard is **29 passed (29)**, re-run on the merge tree and on the trunk; `prettier
--check` is clean on the PR's paths; `gh pr checks 346` shows every substantive job
pass (`ci`, `lint`, `unit_test`, `test_coverage`, `audit`, `secret-scan`,
`env-changes`, `validate-branch-name`, `validate-pr-title`, CodeQL) — the only red is
`audit-dev`, which fails by design under `continue-on-error` (ADR-0301) and is not a
gate.

**Honesty check.** `grep -rn decodeURIComponent apps/web/src` (excluding tests)
returns this one route and nothing else: there is **no second site** of the defect
class. No fixture-shaped hardcoding, no test-environment conditional, and no test,
mock, fixture or factory was edited (`tests_not_touched`) — the decode was made total
behind the RED pin without weakening a single assertion.

**F1 (High — routed; not a defect in this deliverable).** The OP-110 lane's
`Next free` cell is a **snapshot**, not a lock, so the reactivation-boundary lane (PR
[#344](https://github.com/yahodu/openpic-webapp/pull/344), head `89dbfd7`) minted the
same **`0482`** four minutes after this lane's pins commit `2418ce7` — the second
record is `docs/adr/ADR-0482-op110-reactivation-boundary-pins.md`. This is an
allocation collision in the ledger, not a defect in the decode fix: the boundary lane
must **renumber past `0483`** before its PR lands. It is routed, not fixed here — a
renumber card gated on the boundary-pin card `t_805e17b6` (card `t_c83556f9`) and a
durable allocation-rule card for the board's `openpic-orchestrator` (card
`t_6b5e0fc9`). No ADR identifier for the renumber is asserted here: the boundary lane
may renumber again while its PR is open.

**Info.** The superseded pins PR
[#342](https://github.com/yahodu/openpic-webapp/pull/342) was closed and its branch
deleted once the pins rode in this lane's PR. A stale, uncommitted copy of the pin
block was found dirty in the shared main checkout; it was proven byte-identical to the
trunk version (hence redundant) and discarded before the `--ff-only` sync.

**Post-review status.** F1 is routed (renumber card + allocation-rule card) and stays
open until the boundary lane renumbers; the two Info items are closed (the superseded
PR is gone, the stale copy discarded). Nothing in the historical sections above —
_Context_, _Decision_, _Evidence_, _Alternatives considered_, _Consequences_ and _ADR
number allocation_ — is retracted: they record what shipped at `c2ebc589`, and the
follow-ups' own records document what followed. This sign-off consumes **no** ADR
number: the lane's `Next free` cell is unchanged and `docs/adr/README.md` is
byte-identical to `origin/main`.
