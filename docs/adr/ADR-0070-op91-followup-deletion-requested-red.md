# ADR-0070 — OP-91 follow-up RED: pin the `account.deletion.requested` emission + test hygiene

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_86eb4525` (OP-91 follow-up, phase 1-Identity) · **Stage:** RED (tests + comments only; no production code)
- **Contract under test:** API contract §1.4 (Account deletion) · ADR-0067 (OP-91 RED), ADR-0068 (OP-91 GREEN), ADR-0069 (green review sign-off)
- **Branch:** `OP-91-task-followup-deletion-requested-red`

## Context

The OP-91 GREEN round-1 review (ADR-0069) approved PR #176 with findings. One
Medium finding is a requirement the card's scope section 4 names but the
implementation does not meet: `POST /me/deletion` must **emit
`account.deletion.requested`** (contract §1.4, notification design §4.2 — in-app

- email + mobile, because the action is irreversible). The route currently only
  flips `userProfiles.status` to `deletion_pending` and logs
  `me.deletion.requested`; there is no `handleDeletionRequested` seam and, crucially,
  **no test pins the emission** — so the suite is green while the requirement is
  unmet. Two Low findings (a stale ADR reference, an under-strength assertion) ride
  along in the same file.

This ADR records the follow-up RED decisions so the gated GREEN card
(`t_3ca3db85`) inherits the exact contract.

## Decision

### 1. New RED spec I7 pins exactly one `account.deletion.requested` row

`me-sessions-and-deletion.test.ts` gains
`I7: requesting deletion emits exactly one account.deletion.requested row`. It
signs in with an email OTP, issues `POST /me/deletion` with a matching
`confirmEmail`, asserts the `202`, then asserts

```
domain_events.countDocuments({ eventKey: "account.deletion.requested",
                               "subjectRef.id": String(user._id) }) === 1
```

This mirrors the I3 pin for `account.sessions.revoked`: the observable outcome is
the outbox row, not an internal call. The emission must flow through the identity
lifecycle seam — a `handleDeletionRequested` policy handler reached via
`createIdentityLifecycleSeams().deletionRequested` (ADR-0043 §3), the counterpart
of `handleSessionsRevoked` — not a direct `emitDomainEvent` in the route, so the
shape stays consistent with every other §4–§6 surface.

**Against `main` today the spec fails for the right reason: the row is absent.**

```
AssertionError: expected +0 to be 1 // Object.is equality
- Expected  1
+ Received  0
  at me-sessions-and-deletion.test.ts:610
```

### 2. I3 strengthened from existence to an exact count

I3's `account.sessions.revoked` assertion used `findOne(...)` +
`expect(emitted).not.toBeNull()`. The contract fixes **exactly one** row per
revoke-all, so it now uses `countDocuments(...)` and asserts `=== 1`. A future
double-emit (e.g. a `session.delete` database hook added alongside the explicit
seam — none is wired today, ADR-0068 §3) would silently pass the old check but
fails this one. This is a robustness pin, not a live bug: the assertion remains
green on current `main`.

### 3. Stale ADR reference renumbered

The spec header's `## Deliberate assumptions (see ADR-0057)` cited ADR-0057,
which after the merge is OP-89's sign-off ADR. The OP-91 RED ADR is ADR-0067, so
the comment now reads `(see ADR-0067)`. Comment-only.

## Consequences

- **Integration:** 36 files, 263 tests, **1 red** (I7) and 262 pass — the single
  intended red. Every other file is byte-identical in behaviour to `main`.
- **Unit:** 71 files / 1357 pass, unchanged.
- No production file is modified by this card. The red I7 ships inside the gated
  GREEN PR on the same branch, owned by `t_3ca3db85`, which adds the
  `handleDeletionRequested` seam and the route call that turns I7 green.
- `subjectRef.kind` is `user` and `subjectRef.id` is the deleting user's id, the
  same convention every identity emit already uses (`userRef`).

## Alternatives considered

- **Assert the row by `findOne` / not-null in I7 too** — rejected: it cannot
  distinguish a correct single emit from a double-emit, and the contract fixes the
  count. I3's strengthening establishes the house pattern.
- **Pin the emission at the unit layer (call `handleDeletionRequested` directly)**
  — rejected: the requirement is that the _endpoint_ emits. Only an integration
  spec that drives the real route handler proves the wiring, exactly as I3 does for
  sessions.
- **Also assert payload fields (`scheduledAt`, `cancelUrl`) on the row** — out of
  scope here: the contract's §1.4 requirement is the emission and its subject;
  payload shape is the notification matrix's concern (§4.2), already covered by the
  notification-type specs.
