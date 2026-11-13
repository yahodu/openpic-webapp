# ADR-0820 — OP-132 TEST: a genuinely failing confirm transaction answers `500`, not a masked `200`

- **Status:** Accepted (characterization pin; green on the cut, no production change)
- **Consumers:**
  `apps/web/src/test/integration/selfie-confirm-publication.test.ts` — case 6
  ("when the confirmation's transaction fails for a reason that is not a
  duplicate-key collision"), the `driverUpdateOne` / `fieldOf` / `setOf` /
  `ProfileWrite` / `selfieIsActive` helpers beside it, and the file docblock's
  bullet that cites this record.
- **Lane:** the shared attendee block `0780`–`0798` is exhausted, so this record
  draws from the `unallocated (future lanes)` pool — the
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) /
  [ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) precedent. At this head
  **both `Next free` cells read `0818`**, while `0818`
  (`ADR-0818-op134-claim-endpoint-arms-pins.md`, PR #573) and `0819`
  (`ADR-0819-…`, PR #574) are in flight; no ref and no `.worktrees/*/docs/adr`
  carries `0820`, so this record draws **`0820`** and both cells advance to
  `0821`.
- **Consumes:** `0820`.
- **Relates to:** [ADR-0805](ADR-0805-op132-confirm-publication-pins.md),
  [ADR-0808](ADR-0808-op132-late-match-publication-ownership.md),
  [ADR-0816](ADR-0816-op132-concurrent-confirm-publication.md) and
  [ADR-0817](ADR-0817-op132-concurrent-confirm-reread.md) — the records whose
  cases this one sits beside. None of them is edited.
- **Satisfies:** the Medium finding of the review of `t_6e62ee84` that the whole
  confirm pin set is blind to a transaction failure which is answered as a
  success.

## Context

The confirmation is the only publisher in this repo, and its state write, its
§15.3 watermark and its `attendee.matches.new` row are one `withTransaction`.
Five cases pin what that transaction must produce: one delivery on a repeat
(ADR-0805 case 1), the delta count (case 2), the shared delivery identity
(ADR-0808), the confirmation's own late publication (ADR-0808 §1) and two
simultaneous confirms both answering `200` (ADR-0816, made true by ADR-0817).

None of them observes the **failure** direction. The review of `t_6e62ee84`
measured it: with the route's transaction wrapped in a degenerate repair —

```ts
async function swallow<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
// …
await swallow(() =>
  withTransaction(async (session) => {
    /* unchanged body */
  })
);
```

— the whole file was `Tests 5 passed (5)` on three runs of three. So a GREEN that
"catches the duplicate-key abort and continues" can catch **broadly**, every pin
stays green, and a genuine database failure — not the outbox's duplicate-key
collision the retry path exists for — is answered `200 status: "ready"` with no
activation write, no watermark and no notification. The attendee then reads a
ready selfie that was never activated: a silent failure with a success envelope.
ADR-0817 §Decision 4 rejected that shape on exactly this ground, but rejection
alone is not a pin — nothing in the tree reddens if the swallow returns.

The precedent for the missing shape is
[ADR-0812](ADR-0812-op132-submit-object-transport-500.md) (the submit's storage
transport): one load-bearing case that forces a non-domain failure and requires
the `500`, with the seam asserted to have been reached.

## Decision

1. **One new case in the existing file, not a new file.** The file already owns
   the fixture chain (`readyEvent` → `submitOne` → `runWorker`), the readers
   (`profileRow`, `matchesNewRows`) and the file-local `vi.mock` of
   `@/server/db/transaction` with its `confirmRaceGate` latch, which the card
   requires to stay intact. A second file would copy that harness and add a
   second module-level mock of the same seam.
2. **The seam is the transaction's own activation write.** The
   `attendeeEventProfiles` `updateOne` — the write that sets `activeSelfieId`,
   `status`, `matchCount` and the watermark — fails with a driver
   `Object.assign(new Error("not primary"), { code: 91 })`: a database outage,
   **not** the outbox's duplicate-key collision. Code 91 carries no
   `TransientTransactionError` label, so `withTransaction` does not retry it: the
   case records exactly one attempt, which also pins that the failing write is
   not silently retried into a success.
3. **The dedupe read is not stubbed.** The in-transaction
   `countDocuments({ dedupeKey })` runs for real, so the case cannot pass by
   breaking the read that ADR-0816/ADR-0817 pin.
4. **The wire answer is `500 internal_error`, and nothing may be activated.**
   Status `500` unconditionally (never `200`), the `error.code` of the app-wide
   §0.12 envelope, and the row exactly as the submit left it: `status:
"processing"`, `activeSelfieId: null`, `firstMatchNotifiedAt: null`,
   `matchCount: 0`, the selfie still not active, and **zero**
   `attendee.matches.new` rows.
5. **The seam must be proven reached.** The stub records every
   `attendeeEventProfiles` write it sees; the case requires exactly one, naming
   **this** profile's `_id`, asking for `status: "ready"` and carrying a session.
   A route that answers `500` before opening the transaction, or that never
   reaches the activation, fails the pin.
6. **The fixture is proven a happy path.** With the stub restored, the same
   request answers the documented seven-key `200` with `status: "ready"`,
   activates the row and produces exactly one delivery — so the `500` is
   attributable to the injected failure and the API is retryable.

## Consequences

- **This is a characterization pin, so it is green on the cut and mints no
  sibling GREEN card.** The shipped route propagates transaction errors, so the
  case passes on first run; the PR is non-draft. If a later change reddens it,
  the change is the defect, not the pin.
- **It pins the class, not the text.** The status, the `internal_error` code and
  the absence of state are asserted; the message, the `requestId`, the log line
  and `retryable` are deliberately free, so an implementation that answers the
  same envelope from a different internal path stays green.
- **It does not decide the recovery shape.** A catch that narrows to the
  duplicate-key abort and re-throws everything else satisfies it, and so does no
  catch at all. What is now observable is the swallow.
- **It does not cover the retry budget.** A burst of `N > 3` simultaneous
  confirms still spends `DEFAULT_TRANSACTION_MAX_ATTEMPTS` and answers `500` for
  the unluckiest racers; that is routed to the burst pin (`t_3032fa5a`) and its
  GREEN (`t_e0b862be`), and this record does not measure it.
- **The seam is the driver's `Collection.prototype.updateOne`,** captured at
  module load so the stub forwards to the real method without recursing (the
  `billing-checkout.test.ts:177` precedent). It is restored in a `finally` and by
  the file's `afterEach(vi.restoreAllMocks)`, so no case inherits it.

## Alternatives

- **Stub the dedupe `countDocuments` to fail.** Rejected: the card forbids it,
  and it would prove a failure _before_ the writes rather than the masked
  activation the finding is about.
- **Poison the collection with a `collMod` validator** (the deterministic
  write-failure technique this repo uses elsewhere). Rejected: it leaves no
  record of the call, so the case could not prove the transaction was entered and
  reached this profile — the non-vacuity requirement — and the validator would
  also block the fixture's own writes unless it is toggled mid-case.
- **Stub `withTransaction` to reject.** Rejected: the file-local mock exists to
  hold racers at the transaction boundary; rejecting there would test the mock,
  not the route's error mapping, and the card requires that mock to stay
  untouched.
- **A new spec file.** Rejected in §Decision 1: the harness, the readers and the
  required file-local mock all live in this file.
- **Assert the `transaction retry limit` path** (`isTransactionRetryLimitError`).
  Rejected: that is the burst budget's failure, not a genuine write failure, and
  it is already routed to `t_3032fa5a`.

## Evidence — measured at this branch's head

- **Cut:** `origin/main` `553a92f` (the trunk that carries PR #571's squash
  `a49599c`), so the concurrency pin and the ADR-0817 fix are both included.
- **Focused, green on first run and after the probe:** `Tests 6 passed (6)` on
  the first run, and `Tests 6 passed (6)` on each of two further runs after the
  mutation probe below was reverted and the file formatted; the five
  pre-existing cases are unmodified (`git diff` deletes exactly one line: the
  `mongodb` import that gains `Collection`).
- **The injected failure reaches the wire:** the run logs
  `"route":"/api/v1/p/events/:slug/selfies/:selfieId/confirm","event":"http.error","status":500,
"err":{"message":"not primary"}`, and the case's recorded write list is exactly
  the one activation write for the submitted profile.
- **The pin is load-bearing — mutation measured, then reverted.** With the
  route's `withTransaction` wrapped in the degenerate `swallow` above, the file
  answers `Tests 1 failed | 5 passed (6)` and the failure is the new case:
  `AssertionError: expected 200 to be 500`. The five shipped cases stay green
  under the swallow, which is exactly the blind spot this card exists to close.
  The route was restored byte-identically (`sha256
dc89b9413519614e06b4c7df70ebe658957122cb30cc0802696d4741ae72f4f4` before and
  after) and `git status` names only the spec file.
- **Static checks:** `tsc -p apps/web/tsconfig.json --noEmit` exit 0, ESLint on
  the spec 0 errors / 0 warnings, `prettier --check` clean on the spec, this
  record and the ledger.
- **Whole suites.** `--project unit`: **178 files / 2938 passed | 3 skipped
  (2941)**, exit 0. `--project integration`: **5 failed | 123 passed (128
  files)**, **8 failed | 1315 passed (1323)** — all eight are
  `Error: Test timed out in 5000ms` in five files this diff does not touch
  (`billing-self-serve`, `event-members`, `notification-digest-flush-claim-lease`
  ×3, `notification-dispatch-retry`, `tenant-members` ×2), and the same five
  files answer **5 passed (5) / 74 passed (74)** when run alone, so this is the
  load-induced 5 s timeout the ADR-0817 review reported for this shared machine,
  not an assertion failure — and this branch changes no production file and no
  other spec. The five ADR guards
  (`adr-numbering`, `adr-consumers`, `adr-source-references`,
  `adr-record-links`, `adr-lane-ranges`) are **5 files / 218 passed (218)**.
