# ADR-0804 — OP-132 GREEN: reuse charged against `selfies.per_attendee`, the cap claimed under a per-profile critical section, and reuse's rate class

- **Status:** Accepted
- **Consumers:**
  `apps/web/src/server/attendee/selfie-submit.ts` — `chargeSelfieAttempt`, its
  per-profile queue (`attemptQueues`, `attemptLockKey`, `withAttemptLock`) and
  `findProfileId`;
  `apps/web/src/app/api/v1/p/events/[slug]/selfies/route.ts` — the submit
  handler's `chargeSelfieAttempt` call and its `commit` (challenge single-use);
  `apps/web/src/app/api/v1/p/events/[slug]/selfies:reuse/route.ts` — the reuse
  handler's `chargeSelfieAttempt` call and its `rateLimitIdentity` stage.
- **Lane:** the shared attendee block `0780`–`0798` is exhausted. At this head
  (`OP-132-task-reuse-cap-and-rate-pins`, on top of `origin/main` `9c5bbbb`)
  `0803` is the branch's own pins record and `0802` is in flight in another
  worktree (the OP-133 soft-delete pins), so this record draws **`0804`**, and
  both `Next free` cells advance to `0805`. No new lane row.
- **Amends:** [ADR-0803](ADR-0803-op132-reuse-attempt-cap-and-rate-pins.md)
  §Open questions 1–3 (all three are answered below) and
  [ADR-0792](ADR-0792-op132-liveness-selfie-green.md) — the reuse route, which
  that record shipped without a budget and without a rate stage.
- **Consumes:** `0804`.

## Context

Review finding **F2** (Medium) of `t_3b8151c3` / PR #543, in two halves:

1. `POST …/selfies:reuse` resolved no attempt budget (it read
   `selfieAttemptNumbers` only **after** the write, to fill the envelope), so an
   attendee who had spent every `selfies.per_attendee` attempt on an event still
   minted one more `selfies` row and one `q:selfie` pointer per call. §14.1 calls
   that entitlement "the hard cap", so reuse was a cap bypass.
2. Both routes read the count **outside** the write path. Snapshot isolation does
   not conflict on two inserts into different documents, so two submits that both
   observe `used = allowed - 1` both pass — and moving the read inside the
   transaction does not close it either: five concurrent racers additionally
   exhaust `withTransaction`'s three-attempt budget through their own
   `upsertProcessingProfile` writes and two of them answer `500`.

The TEST card `t_75bc5afe` pinned both halves plus the missing §0.11 stage in
`selfie-reuse-attempt-cap.test.ts` (five cases, measured red on three consecutive
runs; [ADR-0803](ADR-0803-op132-reuse-attempt-cap-and-rate-pins.md)). This record
turns those pins green with **no test, fixture, helper or mock edited**.

## Decision

### 1. One critical section per profile, in the shared service

`selfie-submit.ts` gains `chargeSelfieAttempt`: resolve the profile id, resolve
the budget, refuse an exhausted one, and — only then — write the profile upsert,
the queued `selfies` row and the caller's extra `commit` work (the submit route's
challenge single-use update) in one `withTransaction`. Both writes call it, so
reuse and submit cannot disagree about the budget.

The read-and-write is serialized per profile by an in-process queue
(`attemptQueues`, keyed by tenant + event + subject — the same key
`subjectFilter` upserts on). The shape is `seed-plans.ts`'s and the billing
checkout route's private `runExclusive`, lifted to this module; the map entry is
removed once its charge settles, so a long-lived process does not accumulate one
entry per profile it has served.

Why a queue rather than a read inside the transaction: the count is
`countDocuments({profileId})` (schema §15.3 has no attempt counter), which is a
write skew, not a conflict. Serializing the read with its insert is what makes
the invariant hold, and it also keeps the losers out of `withTransaction`
entirely, so the measured `TransactionRetryLimitError` `500`s cannot happen.

```text
shortcut: the queue is per process; several instances can still overshoot by one
each. Upgrade to an atomic conditional claim on the profile when the cap must
hold across instances.
```

That limit is the only thing this card does **not** close; the pins observe one
process (ADR-0803 §5 recorded the same boundary).

### 2. Reuse spends an attempt, and a refusal writes nothing

`…/selfies:reuse` keeps its documented precedence — consent for the addressed
event (`412`), ownership of the source selfie (`404`, never `403`), the source
row still exists — and only then calls `chargeSelfieAttempt`. A spent budget is
`403 plan_limit_exceeded` with `details.entitlementKey: "selfies.per_attendee"`,
the same refusal the submit route answers, thrown **before** the transaction, so
no `selfies` row, no asset reference and no `q:selfie` pointer is created.

The envelope is unchanged: the same seven keys, `status: "processing"` and the
same `pollUrl`/`pollIntervalMs`. `attemptsUsed` is now the pre-write count plus
one on both paths — the number the submit route already reported, and for reuse
the same number the old post-write read produced (the resolved budget is returned
by the charge so neither route has to re-read it).

### 3. Reuse declares `selfie.submit`, post-auth and attendee-keyed

```text
rateLimitIdentity: attendeeRateLimitStage("selfie.submit")
```

This is the same stage `POST …/selfies` and `POST …/selfies/uploads` already
declare: every selfie write in this lane carries it, and reuse **is** a selfie
write that spends an attempt and enqueues worker work. Two consequences the
DOCS card's §0.11 amendment should state, because §0.11 has no reuse row today:

- the class is `selfie.submit` — 6 calls an hour per attendee session and 20 an
  hour per client IP — enforced **after** auth and **after** the consent gate,
  keyed on the server-resolved attendee session (`attendeeRateLimitStage`), never
  on the client-supplied `X-Attendee-Session` header;
- it is the abuse-prone set in `classes.ts`, so a limiter failure fails
  **closed** (`503`), and a denial is `429 rate_limited` with `Retry-After` plus
  the `RateLimit-*` trio.

Sharing the bucket with submit is deliberate: separate classes would let a caller
alternate endpoints to double the allowance, and the attempt budget is one budget.

## Evidence

Measured on this branch head, with the implementation in place:

| gate                                | result                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| the five F2 pins                    | 5 passed (5) — first run, no retry                                     |
| the OP-132 + OP-131 neighbour specs | 56 passed (56) — consent, submit, submit-user, reuse, upload-collision |
| `tsc -p apps/web/tsconfig.json`     | exit 0                                                                 |
| test files changed by this record   | none — the diff is three production files, this record and the ledger  |

The pins' case 2 spends exactly six `selfie.submit` tokens (source submit,
target submit, reuse, target submit, refused fourth submit, refused fourth
reuse), which is the class's whole allowance: the sixth call is still admitted by
the limiter and refused by the cap. An editor who adds one more live call to that
case will see a `429` that looks like a cap bug — that is the class decision of
§3, not a regression.

## Consequences

- Submission and reuse draw on one budget and one limiter; the reuse route is no
  longer the lane's one unbounded selfie write.
- `selfie-submit.ts` now owns the write path of both routes. A future change to
  how an attempt is stored belongs there, not in either handler.
- No response shape, status code or the seven-key envelope moved.
- The serializer's scope is one process. Multi-instance correctness needs a
  conditional claim (an attempt counter on the profile, or a unique
  `(profileId, attemptNumber)` key); that is a schema change beyond this card.

## Alternatives

1. **Coarse `write.normal` only** (60/min, pre-auth, IP-keyed for anonymous
   callers). Rejected: it does not bound one attendee's attempts, and it breaks
   the lane's convention that every selfie write declares `selfie.submit`.
2. **A new `selfie.reuse` class.** Rejected: §0.11 has no row for it, and two
   classes for one attempt allow alternating between them.
3. **Read the count inside the existing transaction.** Measured on the pins'
   branch: five racers still overshoot and two answer `500`
   (`TransactionRetryLimitError`), so it satisfies neither half of F2.
4. **An atomic conditional claim now.** It is the right long-term answer (§1's
   `shortcut:`), but schema §15.3 has no counter and adding one is a schema
   change the card does not authorise.
