# ADR-0093 — OP-94 GREEN review sign-off: notification fan-out consumer (outbox → feed + dispatches)

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-reviewer`
- **Card:** `t_d8f1e9e5` (OP-94 GREEN) · **Deliverable:** branch `OP-94-task-notification-fan-out-green`, PR #189
- **Contract under review:** `docs/adr/ADR-0090-op94-notification-fan-out-red.md` (pins + module contract), `docs/adr/ADR-0091-op94-fan-out-red-review-signoff.md` (RED sign-off), `docs/adr/ADR-0092-op94-notification-fan-out-green.md` (implementer decisions)
- **Implements (review stage):** ADR-0085 (`resolveChannel`/`renderTemplate`), ADR-0076 (`MessageTransport`), ADR-0029 (`domainEvents` outbox)

## Verdict

**APPROVED WITH FINDINGS** (round 1, artifact lens + execution). The nine
integration pins (I1–I8 + I2b) and three unit pins (U1–U3) are turned green for
the right reason by a single production module that keeps every load-bearing
property the contract pins: audience resolved at send time, actor excluded,
`readAt: null`-safe aggregation, database-enforced dedupe, per-recipient failure
isolation and secret non-retention. No test, factory, fixture or MSW file was
modified, no Critical security or honesty finding exists, and no refactor was
warranted (the reviewer edited no implementation). The findings below are
Medium/Low and all are already owned by existing downstream cards or are
optional polish; none blocks this merge.

## Evidence (reproduced independently by the reviewer)

- Unit: `vitest run --project unit` → **78 files / 1438 tests passed**.
- Focused unit: `vitest run --project unit fan-out` → **1 file / 15 passed**.
- Integration: `TMPDIR=/root/tmp-mongo vitest run --project integration` →
  **39 files / 294 tests passed**; focused `notification-fan-out` → **9 passed**
  against a real `MongoMemoryReplSet` + index bootstrap.
- `git diff 855c7be..HEAD` (the GREEN-only span) touches **`fan-out.ts` (new) +
  ADR-0092 + `docs/adr/README.md` + `eslint.config.mjs`** — **no test file**.
  The `feat` commit `05f0b41` is exactly one production file.
- PR #189 CI (head `5e63f9e`): validate-branch-name, validate-pr-title,
  env-changes, secret-scan, lint, unit_test, test_coverage, ci, CodeQL, Analyze
  (actions/javascript-typescript) — **all passing**.
- Honesty audit: no `process.env`/`NODE_ENV`/`VITEST` branch, no `@ts-ignore`
  /`@ts-expect-error`/`eslint-disable`, no fixture-shaped hardcoding in
  `fan-out.ts`.
- Security audit: destinations are never logged — only the SHA-256
  `contactHashPrefix` appears on `notification.dispatched`/`skipped`/
  `dispatch_failed`; no dispatch row ever stores a rendered body (I6's sentinel
  is absent); no server-only env reaches a client bundle (server-only module).

## Pin fidelity (why each pin is green for the right reason)

- **U1/U2** exercise the pure `resolveRecipients` against the injected port;
  the actor-exclusion assertion holds because the repository source (not the
  test) supplies the actor, so exclusion is attributable to the code path.
- **I3** proves the aggregation filter is `readAt: null` by reading the row,
  forcing `readAt`, then emitting again: a resurrection regression produces
  `groupCount: 10` on one row instead of two rows.
- **I4/I8** prove dedupe is the unique index: the second attempt inserts, hits
  E11000, and is recorded as `skipped`/`deduped` with `dedupeKey: null`, while
  the first is `sent` — no pre-check `findOne`.
- **I5** proves isolation and retryability: one recipient's Novu 503 yields
  `failed`/`attempts:1`/`retryable:true` while the peer is `sent` and the
  outbox row stays `pending`.
- **I6** proves `retainBody:false` field-agnostically (sentinel in the sent
  message, absent from the stored dispatch).

## Findings

### Medium — a quiet-hours `defer` is persisted as a terminal `skipped` row and the event is marked `done`

`dispatchOutbound` maps a `defer` decision to `writeSkip(..., "quiet_hours_deferred")`
and returns no failure, so `processEvent` marks the outbox row `done`; the stored
dispatch row carries no `until`. Design §5 says quiet hours _schedules_ the send
after the window, so a non-critical, quiet-hours-respecting type emitted inside a
user's quiet window is currently dropped with no durable field from which a
releaser can reconstruct it. Location: `fan-out.ts:788-791` (`defer` →
`writeSkip`) + `runNotificationFanOut` (`markDone`). No pin asserts the deferral
outcome (the RED contract only pins "every skip is persisted"). **Routing:** the
existing OP-96 lane (`t_bf539e5b` RED / `t_609968cf` GREEN, "Digest buckets,
dispatch retry and quiet-hours release crons") owns this; that lane must decide
whether the defer row carries `until` or the release is derived elsewhere. No
new card.

### Low — card §1 (cron route + `after()` trigger) and §6 (`sendTransactionalNow`) are not implemented

The GREEN-only diff adds `fan-out.ts` only. ADR-0090 explicitly de-scoped the
`/internal/cron/notification-fanout` route, the `after()` opportunistic trigger
and `sendTransactionalNow()` (OP-95), and no pin references them. **Routing:**
existing cards cover the surface — OP-95 (`t_3bd2a7b4`/`t_0e8a6a84`) for the OTP
`NotificationService`, OP-87 for the internal HMAC cron framework, OP-96 for the
digest/retry/quiet-hours crons. The orchestrator should confirm the fan-out cron
route lands in one of them so the card's §1 is not silently dropped.

### Low — the test-file `unbound-method` relaxation is broader than the idiom it targets

`eslint.config.mjs` disables `@typescript-eslint/unbound-method` for all test
files to accommodate `expect(repository.method).toHaveBeenCalled…`. The
relaxation is documented (ADR-0092) and production keeps the rule on, but it now
also silences a genuine `this`-loss in any future test helper. Location:
`eslint.config.mjs` (+5). **Routing:** optional Implementer polish — a narrower,
file-scoped disable would keep the guard for other specs. Low.

### Low — per-recipient data reads are serial

`loadRecipientContext` issues three independent `findOne`s sequentially
(`fan-out.ts:492-501`), once per recipient; `processEvent` loads
`getPlatformSettings` and `loadTemplates` serially though both are
recipient-independent (`fan-out.ts:999-1029`). A `Promise.all` (settings +
templates; the three contact/profile/preference reads) is behaviour-preserving
and cuts round trips. **Routing:** optional Implementer polish. Low.

### Low — `groupChannel`'s mobile fallback (`sms`) diverges from the resolver's default candidate order (`whatsapp`, `sms`)

For a skip decided before candidate selection on a mobile group that declares no
`candidates`, `groupChannel` records `sms` (`fan-out.ts:666-669`) while
`resolveChannel` would have attempted `whatsapp` first. No seed type hits this
(all mobile types declare candidates), so it is latent. **Routing:** optional
Implementer polish. Low.

## Consequences

- PR #189 is squash-merged to `main`; local `main` synced to `origin/main`.
- Because #189 is stacked on the unmerged OP-93 PR #187, this merge lands the
  OP-93 (`resolveChannel`/`renderTemplate`) content as well; #187 and the RED
  draft #188 are then superseded and routed to an orchestrator hygiene card.
- The reviewer edited no implementation and no test file; this ADR and its
  README row are the only review-time changes.
- The Medium/Low findings are carried by OP-96 (deferral release + outbound
  digest), OP-95/OP-87 (transactional entry point + cron route) and one optional
  polish card — none requires this PR to change.

## Alternatives

- **Request changes on the quiet-hours deferral.** Rejected: the semantics are
  genuinely owned by the OP-96 release-cron lane, whose pins do not exist yet;
  requesting a change here would invent untested routing, which ADR-0090
  explicitly de-scopes. Recorded as a Medium finding with routing instead.
- **Retitle the merge to cover both lanes.** Rejected: the PR title already
  names OP-94 and the squash body can note the stack; renaming would break the
  conventional-commit scope the release tooling reads.
- **Leave a review sign-off ADR unwritten.** Rejected: every prior GREEN review
  lane records one (0084/0089/0091) and the lane's ADR allocation is sequential.
