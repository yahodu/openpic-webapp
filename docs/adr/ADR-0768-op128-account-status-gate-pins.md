# ADR-0768 — OP-128 follow-up: the account-status gate on the media signer

- **Status:** Accepted — implemented by the gated GREEN (`t_658f8a67`, ADR-0770)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_91b4e245` (TEST follow-up, round-1 finding **F1**, High), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-account-status-gate-pins`, cut from the lane branch
  `OP-128-task-batch-signed-media-urls-red` at `f7a2696` (PR #440's squash `5aff77d` folded in)
- **Consumes:** contract §5.6, §0.3, §0.4, §0.15; schema §13.1, §13.2; ADR-0025 (the auth guard
  table), ADR-0766 (the endpoint pins, D3/D4 — the `public` label and the
  `authentication_required` exemption), ADR-0767 (the implementation)
- **Supersedes:** nothing; **amends** ADR-0766's open contract by adding the `user` label's
  account-status rule to the endpoint

## Context

The round-1 review of the OP-128 GREEN measured a hole, not inferred one. The route is
`public`-labelled (ADR-0766 D3) and resolves its principal itself with `resolvePrincipal`, so the
`user` label's decision table (`evaluateAuth`, `@/server/auth/guards`, ADR-0025) never runs. Probe at
`8e9c7e2`: set the seeded event organizer's `userProfiles.status` to `suspended`, then
`POST /api/v1/media/signed-urls` with that cookie → **`200` with a signed thumbnail and a signed
original**. The same principal is refused by `evaluateAuth("user", …)` as `account_suspended`, which
is why every other authenticated endpoint refuses it.

The consequence is not a stale page: a suspended (or banned, or deletion-pending) account keeps
minting fresh signed originals for as long as it holds a cookie — the endpoint is the one place where
the account's state stopped mattering.

## Decision

### D1 — the denial code is `forbidden`, not `authentication_required`

The caller **holds a credential**; the refusal is about the account's state, not about missing
authentication. The endpoint's denial vocabulary is the four §5.6 codes
(`SIGNED_URL_DENIAL_CODES`), which has no account-state member, so `forbidden` is the honest mapping
of the guard's `account_suspended` / `account_banned` / deletion states.

Rejected: **degrade a refused principal to anonymous**, which would answer `200` with
`denied[] { code: "authentication_required" }`. It is worse on three counts — it tells an
authenticated caller to sign in, it hides the refusal behind the batch rule's
`authentication_required` exemption (ADR-0766 D4), and a client cannot tell it apart from a
signed-out visitor.

Consequence, recorded rather than hidden: this wire does **not** carry `supportUrl`, `banReason` or
`banExpires`. An account-state detail belongs to `GET /me` (§0.3), which every client already calls.

### D2 — the refusal is a whole-request `403`, which is where the batch rule collapses it

The card asked for two things that cannot both be observed: a `denied[]` entry with code `forbidden`
**and** "an all-denied credentialed batch still `403`". An account-level refusal denies **every**
item, and `signedUrlBatchStatus` escalates an all-denied credentialed batch (ADR-0766 D2) — so the
per-item view is never on the wire. The pins therefore hold the collapse point:

```
403 { error: { code: "forbidden" } }   — no `urls` key, and nothing that could be a signed object
```

That pin is deliberately **implementation-neutral**: applying the guard per item and letting
`signedUrlBatchStatus` collapse the all-denied batch to `403`, or refusing at the route boundary,
produce the identical wire answer. What the pins do forbid is any answer that carries a URL, or a
`200` (`200` would be the anonymous-degradation fix of D1, or no fix at all).

### D3 — the gate is the `user` label's own table, not a copy of its rules

The GREEN should call `evaluateAuth("user", { principal, now })` (ADR-0025) rather than test
`status === "suspended"` inline. One table means a rule added for every authenticated endpoint lands
here too, and the `suspended` / `banned` / `deletion_pending` triple stays one behaviour. The gate
applies to a `kind: "user"` principal only: an anonymous caller keeps its per-item
`authentication_required` answer (I6, unedited), and the OP-129 `attendee` principal
(`{ kind: "attendee", sessionId, eventId }`) has no account status to read.

### D4 — no read is added

The status, the ban fields and the profile are already on the principal `resolvePrincipal` returns,
so the status costs no query and I5's `reads(200) === reads(2)` budget is untouched.

## The pins (what this card adds)

One additive `describe` — `I7: the account-status gate refuses a suspended, banned or
deletion-pending caller` — in
`apps/web/src/test/integration/media-signed-urls.test.ts` (15 → 21 cases, **230 insertions, 0
deletions**; no delivered case edited or weakened):

| Case                                                       | Pin                                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `it.each` over `suspended`, `deletion_pending`, `banned`   | `403`, `error.code === "forbidden"`, `urls` absent, the asset's content hash absent from the body — for a caller asking for **both** kinds on an image of the event they organize |
| suspended **matched attendee**                             | the same refusal: the account gate outranks the per-item relationship rules                                                                                                       |
| control (`active` profile, identical fixture)              | both kinds signed, `denied: []`, signature and TTL asserted — so the refusal is the status, not a broken fixture                                                                  |
| mixed batch for an `active` member (in-scope + unknown id) | `200` with one URL and one `not_found` — the batch rule survives the new gate                                                                                                     |

The fixtures: `userProfiles.status` for the two lifecycle states, and the Better Auth `user` row's
`banned`/`banReason`/`banExpires` for the ban — `loadProfile` reads the first by
`{ userId: ObjectId }` and the second is what `resolvePrincipal` projects as `banned`.

## Evidence (measured on this branch)

- **RED on the shipped route** (`f7a2696`, route sha256 `985f2d95…`): `4 failed | 17 passed (21)`,
  each failure `AssertionError: expected 200 to be 403 // Object.is equality` — the three status
  rows and the suspended attendee. The 15 delivered cases and the 2 controls stay green.
- **Satisfiability (throwaway near-fix, reverted):** `evaluateAuth("user", …)` after
  `resolvePrincipal` + `throw appError("forbidden")` → `21 passed (21)`. This also proves the
  fixtures are load-bearing: the guard reads exactly the rows they write.
- **Mutation A'** — gate narrowed to `principal.status === "suspended"`: the `banned` and
  `deletion_pending` rows go red (`expected 200 to be 403`) while `suspended` stays green. The
  table's breadth bites.
- **Mutation C2** — a refused principal degraded to the `attendee` class instead of being refused:
  the three member rows pass (an unmatched attendee is denied per item → all-denied → `403`) and the
  **matched-attendee** row goes red (`expected 200 to be 403`). That is the discrimination the
  attendee case exists for.
- Every mutation was reverted; `apps/web/src/app/api/v1/media/signed-urls/route.ts` is byte-identical
  to its committed state (`sha256 985f2d95…`), and `git status --short` shows the spec file only.

## Consequences

- **O1 — the code cannot say "suspended".** A client learns `forbidden`; the actionable detail stays
  on `GET /me` (§0.3). Adding an account-state code to §5.6 would be a contract change, not this
  card's.
- **O2 — an attendee _session_'s account state stays out of scope.** When OP-129 lands the `op_att`
  resolver, a suspended attendee session has no `userProfiles` row to read; this ADR pins nothing
  about it.
- **O3 — deliberate non-goals.** The `media.sign` rate class (ADR-0766 O3), the malformed-scope and
  missing-asset fallbacks (card `t_8b3f316e`), and the stale `ADR-0764`/`ADR-0765` doc comments
  (card `t_f7437615`) are other cards'; this card adds a spec file and this record only.
