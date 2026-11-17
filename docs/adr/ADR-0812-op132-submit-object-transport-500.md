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

## Review sign-off — round 1 (card `t_5f76eab8`, artifact lens)

**Verdict: APPROVED / LGTM.** The delivery landed as the squash `e0cf073` (PR #568) and
nothing was re-merged for this sign-off. The lens was the **artifact**: the spec and this
record were read cold before the handoff narrative, then every count below was re-measured
by the reviewer rather than transcribed from it.

**No section of this record is retracted.** §Context, §Decision 1–5, §Evidence,
§Consequences, §Alternatives, §Out of scope and the number-allocation paragraph all stand as
written. The findings below are follow-ups and observations, not corrections.

### The reviewed bytes are what shipped

`git diff 0ba62e2 e0cf073` over the PR's three paths — the spec, this record and
`docs/adr/README.md` — is **empty**, so every line this record cites is a line on the trunk.
The only whole-tree difference between the reviewed head `0ba62e2` and the squash `e0cf073`
is main's own `docs/API Contract.md` commit `e760e80`. The spec's, this record's and the
route's blobs are unchanged again between `e0cf073` and `e322a92`, the trunk that carries
this sign-off, so the measurements below apply to both trees.

### Re-measured on the merged trunk

| probe                                                       | measured                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the new spec alone                                          | `Test Files 1 passed (1)`, `Tests 2 passed (2)`                                                                                                                                                                                                |
| the over-broad-catch mutation, re-run at `e322a92`          | `Test Files 1 failed \| 2 passed (3)`, `Tests 1 failed \| 8 passed (9)`; the sole failure is `answers 500 internal_error instead of reporting a client-side 404 not_found` with `AssertionError: expected 404 to be 500 // Object.is equality` |
| the seven shipped F5/F6/F7 cases under the same mutation    | `Test Files 2 passed (2)`, `Tests 7 passed (7)` — the coverage gap this record closes, re-measured rather than quoted                                                                                                                          |
| the route restored after the mutation                       | sha256 `8cf9c49b…` before and after, `git status --short` empty                                                                                                                                                                                |
| the five ADR guards (`adr-numbering`, `adr-lane-ranges`, …) | `5 passed (5)`, `218 passed (218)`                                                                                                                                                                                                             |

### Non-vacuity, confirmed independently

- The spy's `toHaveBeenCalledWith(SELFIE_LOCATION_KEY, selfieObjectKey(bytes.hash))`
  (`selfie-submit-object-transport.test.ts:234`) is what makes the `500` arm diagnosable: a
  route that answered `500` for an unrelated reason, or never asked the port, cannot satisfy
  the status plus the call assertion together.
- The sibling `404` arm runs **after** `vi.restoreAllMocks()`
  (`selfie-submit-object-transport.test.ts:138`), so its real `not_found` is itself the
  proof that the spy was restored — the two arms are independent pins, not one assertion
  written twice.
- `storedUsedAt` throws when the profile row or the presented challenge is missing
  (`selfie-submit-object-transport.test.ts:160`), so the charge-free assertion cannot read
  `null` off a row that does not exist.
- `entriesSince` is proven to observe an entry by `liveness-selfie-submit.test.ts:528`
  (`expect(entriesSince(before)).toHaveLength(1)`), so "no new `q:selfie` row" is not a
  vacuous length-zero on a reader that never sees anything.

### Findings (all non-blocking)

- **F1 · Low — a prospective ADR-number collision, not this delivery's defect.** PR #565
  (OP-134) carried `ADR-0811-op134` and `ADR-0812-op134` on a base that predates both
  records this trunk minted, so that lane's records would have duplicated two live numbers.
  Routed to card `t_135c11ae` to renumber above the highest in-flight number (`0813`) — the
  same repair the OP-132 retention lane made in `63d42b7`. **Resolved before this sign-off:**
  PR #565 landed as `0d57e95` with its records renamed to
  [ADR-0814](ADR-0814-op134-attendee-claim-red.md) and
  [ADR-0815](ADR-0815-op134-attendee-claim-green.md), and both `Next free` cells read
  `0816`.
- **F2 · Info — one redundant assertion.** `expect(error.code).not.toBe("not_found")`
  (`selfie-submit-object-transport.test.ts:243`) can never fail after the `toBe` above it.
  It is harmless and it reads as intent; no change is owed.
- **F3 · Info — `retryable` is deliberately unpinned**, exactly as §Out of scope says. A
  later decision to map the port's retry policy onto the wire needs its own pin and must not
  be retro-fitted into this one.
- **F4 · Info — environment noise, not a regression.** A local full `--project integration`
  run at `e0cf073` answered `2 failed | 1290 passed (1292)` with two five-second
  `testTimeout` hits in unrelated files (`plans-seed.test.ts` I1 and
  `tenant-provisioning-and-routes.test.ts` I1); both files are green in isolation
  (`26 passed (26)`) and main CI on the same sha is green. The reviewer's own full run at
  `e322a92`, while preparing this sign-off, hit the same signature four times — `Test Files
4 failed | 123 passed (127)`, `Tests 4 failed | 1305 passed (1309)`, each failure
  `Error: Test timed out in 5000ms` and each in a file this delivery does not touch
  (`billing-checkout.test.ts` I3, `notification-feed.test.ts` F3,
  `notification-unsubscribe.test.ts` I2 and `subscription-history.test.ts`'s 401 case) —
  and those four files answer `61 passed (61)` when run together in isolation. The tree
  differs from that sha by these two records only, and main CI on `e322a92` is green.

The record's own caveats hold as written: a route that special-cased `code` would still
escape both cases, and the second error class is covered once rather than three times.
