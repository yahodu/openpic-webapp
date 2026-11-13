# ADR-0812 — OP-132 TEST: a storage transport failure in the submit's object check is not swallowed as a `404`

- **Status:** Accepted (characterisation pin; no production change)
- **Consumers:**
  `apps/web/src/test/integration/selfie-submit-object-transport.test.ts` (two
  cases, with its local harness `readyEvent`, `selfieRows`, `storedUsedAt`).
- **Lane:** the shared attendee block `0780`–`0798` (row `OP-129 attendee identity
lane`) is exhausted, so this record draws from the `unallocated (future lanes)`
  pool — the [ADR-0800](ADR-0800-op132-selfies-ttl-and-kind-dedupe-pins.md)
  precedent. Before minting, the sweep read both `Next free` cells as `0812`, no
  `.worktrees/*/docs/adr` carries an `ADR-0812*` file, and no open PR head adds
  one (the highest in flight is `0811` on PR #565). This record therefore draws
  **`0812`** and both cells advance to `0813`. No lane row is minted.
- **Amends:** [ADR-0807](ADR-0807-op132-refusal-edge-pins.md) §Decision 1 (the
  F5 pin's scope: it pins the _recognition_ half of the object check only) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) (the submit contract whose
  object-verification step this record pins from the other side).
- **Consumes:** `0812`.

## Context

`POST /api/v1/p/events/{slug}/selfies` verifies the client's upload with one port
method, `getObjectStorage().headObject(SELFIE_LOCATION_KEY, selfieObjectKey(hash))`
(`apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts`), and that one method
throws **two different error classes**:

| throw                                                                    | produced by                                                                                           | meaning                                | the route owes                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `AppError("not_found")`                                                  | the R2 adapter on a `HeadObject` `404`; the memory adapter for an absent object                       | the **client's** upload did not arrive | `404 not_found`, `details.resource: "selfie"`           |
| `TransportError` (`code: "network" \| "timeout" \| "http"`, `retryable`) | `transportFailure(error)`, i.e. every other status or a network error (`adapters/transport-error.ts`) | **our** storage outage                 | rethrow: `errorResponse` maps a non-`AppError` to `500` |

ADR-0807's F5 file pins the first row only. Nothing pinned the second, and the two
directions are indistinguishable to the shipped suite: with the route's narrowed
catch replaced by an over-broad `catch { throw appError("not_found", …) }`, the
seven F5/F6/F7 cases answer `Tests 7 passed (7)` at `02fcc72` — measured by the
review of `t_325903f6`.

That matters because the codes are **client-actionable**: an attendee client that
reads `404 not_found` concludes its upload did not arrive and **uploads and submits
again**, spending the `selfie.submit` budget (§14.1) on our outage. A `500` is the
honest answer — it is the one status the client may retry without re-uploading.

The narrowing itself already ships (`bd3f8f6`, PR #561): the catch is
`if (!isAppError(error) || error.code !== "not_found") throw error;`. This card is
a **regression lock** on that shape, not a driver for new code.

## Decision

1. **The load-bearing case stubs the port, not the vendor client.** `headObject`
   is stubbed on the instance the route reads (the storage composition root
   memoizes the memory adapter) with
   `new TransportError("Transport request failed.", { retryable: true, code: "network" })`,
   and the wire answer must be `500` with `error.code === "internal_error"` — never
   `not_found`. The port boundary is where the two classes are already
   distinguished, so stubbing it exercises the route's `catch`, which is the thing
   that can be over-broad, without re-deriving R2's status mapping.
2. **The case cannot pass on a path that never reached the port.** The spy is
   asserted to have been called exactly once with
   `(SELFIE_LOCATION_KEY, selfieObjectKey(hash))`. Without that assertion a route
   that answered `500` for some unrelated reason (or answered `404` from the
   absent object because it never called the port) would satisfy the status arm.
3. **Nothing may be charged.** Zero `selfies` rows, the presented challenge's
   `usedAt` still `null`, no new `q:selfie` outbox row. §6.3 orders the object
   check before the challenge, the budget and the enqueue, so a failed check is
   charge-free in both error classes. `storedUsedAt` throws when the profile or the
   challenge is missing, so the arm cannot read `null` off a non-existent row.
4. **The narrowing must not close the arm it was written for.** One cheap
   characterisation case keeps the sibling `404` pinned beside it: a genuinely
   absent object answers `404 not_found` with `details.resource: "selfie"`. It does
   not repeat ADR-0807's shape/charge cases.
5. **No production code, fixture or helper is touched.** The spec reuses
   `../helpers/selfie-flow` as-is; the two readers it needs are local.

## Evidence — measured at the branch cut (`origin/main` `cdbacf2`)

- **Green on the shipped fix:** the new file answers `Tests 2 passed (2)`.
- **The load-bearing case is load-bearing.** Mutation: the route's narrowed catch
  replaced by `catch { throw appError("not_found", { details: { resource: "selfie" } }) }`
  in a throwaway worktree — `Tests 1 failed | 1 passed (2)`, failing case
  `answers 500 internal_error instead of reporting a client-side 404 not_found`
  with `AssertionError: expected 404 to be 500 // Object.is equality`. The other
  case (the `404` arm) still passes, which is what makes the two arms independent
  pins rather than one assertion written twice.
- **The shipped pins cannot see that mutation:** under the same over-broad catch,
  `selfie-submit-refusal-edges.test.ts` + `selfie-zero-match-and-reusable-pages.test.ts`
  answer `Test Files 2 passed (2); Tests 7 passed (7)`. This is the coverage gap
  the record closes, re-measured rather than quoted.
- **Restored byte-identically:** the route's sha256 is
  `8cf9c49b91bbd5cb1150b58e2bcbe293598d1b18fc5789ecdef129afc9c621cb` before and
  after the probe, `git status --short` empty in the probe worktree.
- `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint --max-warnings=0` and
  `prettier --check` clean on the new file; the full `--project integration`
  project green.

## Consequences

- An outage in the object store can no longer be reported as the client's miss,
  and the two error classes of that one port method are pinned **apart** — a
  regression on either side reddens one case and not the other.
- A future refactor of the route that legitimately changes the _envelope_ (the
  catalog's generic `500`) keeps the case green, because the case pins the status
  and the code, not the message or the `requestId`.
- **Known limit — `retryable` is not asserted.** The record deliberately does not
  claim the envelope carries the `TransportError`'s retry policy: the catalog's
  `internal_error` entry is `retryable: false` while the thrown error says
  `retryable: true`. Mapping the port's retry policy onto the wire is a separate
  contract this card does not mint (see §Out of scope).
- **Known limit — one classification of the second class.** `code: "network"` is
  the representative member; `timeout` and a retryable `http` (5xx) are the same
  class from the same helper and are covered once, not three times. A route that
  special-cased `code` would not be caught by this pin.
- No lane row is created and no number outside `0812` is consumed.

## Alternatives

- **Drive the R2 adapter's HTTP client with MSW instead of stubbing the port.**
  Rejected: the defect lives in the route's `catch`, one layer above the adapter's
  status mapping; going through the vendor wire would test `headObject`'s
  classification (already the adapter spec's subject) and would make the case
  depend on R2 request signing for no gain.
- **Assert only `expect(response.status).toBe(500)`.** Rejected: a `500` alone
  cannot distinguish "the outage was rethrown" from "the route crashed on
  something else"; the code assertion plus the spy's call count and arguments are
  what make the arm diagnosable.
- **Assert the whole envelope (`retryable`, `requestId`, message).** Rejected:
  over-constrains a generic mapping the card did not mint, and `requestId` is
  per-request.
- **Re-assert `details.resource` in the `500` arm and in a third `409` arm.**
  Rejected: the `500` body carries no `details` (`toErrorEnvelope` omits them for
  a non-`AppError`), and the `409` arms belong to ADR-0807's F6 file.

## Out of scope

- The envelope's `retryable` mapping for a rethrown `TransportError` — today the
  generic `internal_error` is `retryable: false`; whether an outage should tell
  the client to retry is a contract question for the owner of §0.12's catalog,
  not a pin.
- R2's own status → error-class mapping (`404` → `not_found`, every other status
  or a network error → `transportFailure`). That is the adapter's unit surface and
  is pinned there.
- The presign (`…/selfies/uploads`) and the confirm (`…/{selfieId}/confirm`)
  paths: neither reads `headObject`, so neither has this pair of error classes.
