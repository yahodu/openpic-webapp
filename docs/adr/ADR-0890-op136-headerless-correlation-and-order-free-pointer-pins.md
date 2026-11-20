# ADR-0890 — OP-136 TEST: the header-less correlation arm, and an order-free broker pointer

- **Status:** Accepted (characterization pins — both halves were green on the
  trunk when the card was cut, so there is no GREEN sibling and the PR is
  non-draft)
- **Date:** 2026-11-20
- **Card:** OP-136 TEST `t_26366405` (Low; findings **F-1** and **F-2** of the
  round-1 review of PR [#748](https://github.com/yahodu/openpic-webapp/pull/748),
  card `t_9e0979c4`, squash `8b2a7f2c`). Branch
  `OP-136-task-headerless-correlation-pin`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_26366405`, cut from
  `origin/main` `65d3017d`.
- **Implements:** nothing. This record changes **no** production file, no other
  spec, no fixture and no helper: `git diff --numstat` is `62 5` in one spec
  file plus this record, the ledger row, the two `Next free` cells and the
  ledger's prose note.
- **Consumes:** [ADR-0885](ADR-0885-op136-requeue-warn-request-scoped-logger.md)
  §1 (both reprocess routes pass `requestLogger(ctx.request, { route:
ctx.route })`), [ADR-0868](ADR-0868-op136-requeue-warn-request-correlation-pins.md)
  (the four cases this file already carries, and their `A1`/`B1`/`B2` ids),
  [ADR-0865](ADR-0865-op136-requeue-enqueue-warn.md) (§18.1's
  `queue.enqueue_failed` warn and its logger parameter), and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §10 item 14 /
  §11 items 18–21 (a pool draw advances both cells and keeps the block).
- **Consumers:** `apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts`
  (the appended case's doc-comment and this record cite each other).
- **Findings:** **F-1** (Low, coverage) and **F-2** (Low, brittle) of the
  round-1 review of PR #748.

## Context

**F-1 — the arm most traffic takes was unmeasured.**
`requestLogger` resolves the correlation id from the request context **first**
and the inbound header only as a fallback
(`apps/web/src/server/logging/index.ts:223`,
`context?.requestId ?? request.headers.get(REQUEST_ID_HEADER) ?? newRequestId()`),
and `defineRoute` populates that context
(`apps/web/src/server/http/define-route.ts:232-236`). The two route cases the
file already carries (`B1`, `B2`) send `x-request-id`, so they exercise the
**fallback** only — while a browser or a CDN normally sends no such header and
reaches the **context** arm. A future change that built the logger before the
request scope existed, or read the header directly, would keep `B1`/`B2` green
and silently break correlation for real traffic. The review measured the arm
green at `33f8d430` in the app's own harness: `POST …/images:reprocess-failed`
with no `x-request-id` and a refusing broker answered `202`, the response
carried `x-request-id: req_01M7W3JEY2ZJ7GW9N9MX8K2Q77`, and the single warn
carried the same id with `route:
"/api/v1/tenants/:tenantId/events/:eventId/images:reprocess-failed"`.

**F-2 — `A1`'s broker pointer was order-dependent.**
`A1` asserted the stored pointer with `toEqual({ queueKey: "q:image", provider:
"memory", messageId: "memory-1" })`. That literal holds only because `A1` is the
first case in the file to enqueue: `beforeEach` drains the memoised adapter
(`getWorkQueue().claim("q:image", 500)`) but does not reset its sequence, and
`apps/web/src/server/adapters/memory-queue.ts:60` mints
`memory-${String(sequence)}`. Any case inserted above `A1` that enqueues one
message renumbers it. It was also the only `"memory-<n>"` literal anywhere in
`apps/web/src/test/**`; the house pattern is
`toMatchObject({ queueKey, provider })` without the id
(`liveness-selfie-submit.test.ts:496`).

## Decision

1. **One case appended** to
   `apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts`,
   `C1: a header-less request correlates queue.enqueue_failed with the id the
response mints`, in the existing routes `describe`, after `B2`:
   `seedWorkspace` + a `POST` carrying **only** the organizer cookie (no
   `x-request-id`, so the id can only come from the request context); the
   process logger swapped for `recordingLogger()` and the broker made to refuse
   through `refuseEnqueue()`, both restored in a `finally`; `202` and
   `{ requeuedCount: 1 }` asserted; the response's `x-request-id` read and
   asserted non-null **before** it is used; then exactly one
   `queue.enqueue_failed` whose `fields.requestId` **equals that response
   header** and whose `fields.route` equals the bulk template.
2. **The minted id is never asserted literally** — it is a ULID
   (`req_<ulid>`) — so equality with the id the caller can see on its own
   response is the contract.
3. **`A1`'s pointer assertion made order-free**: `toMatchObject({ queueKey:
"q:image", provider: "memory" })` plus `expect(processing?.queueRef?.messageId)
.toMatch(/^memory-\d+$/)`, the house pattern with the id's shape kept
   checked. Every other `A1` assertion (`status`, the outbox envelope,
   `traceId`) and both `B1`/`B2` cases are byte-identical.
4. Nothing else is touched. No production file, no other spec, no fixture, no
   helper, and `postRequest` (which sends the header) is left alone — `C1`
   builds its own header-less `Request` inline.

## Evidence

All counts are the file's own case count, measured in the delivery worktree.

| Surface                                   | Result                              |
| ----------------------------------------- | ----------------------------------- |
| `image-requeue-enqueue-warn-pins.test.ts` | `5 passed (5)` (was `4 passed (4)`) |
| `event-images-management.test.ts`         | `27 passed (27)`, unchanged         |
| both files, one command                   | `2 files / 32 passed (32)`          |
| `tsc -p apps/web/tsconfig.json --noEmit`  | exit `0`                            |
| `eslint` on the spec                      | `0`                                 |
| `prettier --check` on the spec            | clean                               |
| the six `adr-*` guards                    | green                               |

**P1 — `C1` is load-bearing (F-1's claim, measured).** In a **throwaway**
worktree detached at the delivered commit `33fa14f` (not the shared checkout),
`requestLogger` was mutated to resolve the id from the header only
(`request.headers.get(REQUEST_ID_HEADER) ?? newRequestId()`, dropping
`context?.requestId`) and the pin file was run:

```
× C1: a header-less request correlates queue.enqueue_failed with the id the response mints
AssertionError: expected 'req_01M7WADSS82TN9S98FA6ZKYDJA' to be 'req_01M7WADSRVAR1GQJRXTVN6KCDT'
Tests  1 failed | 4 passed (5)
```

`C1` alone reds — `B1`/`B2` stay green, which is exactly the finding: the header
pins cannot see this regression. The two ids are two different mints (the warn
minted its own at logger construction, the response echoed the context's), so
the failure names the divergence rather than a missing field. The file was
restored byte-identically: `sha256 9b993118b9fadc5ce36341bbc5ae6d8b5ad14ac40eff5dc964f9121d5d91b302`
before and after, `git status --short` empty.

**P2 — `A1` is order-independent (F-2's claim, measured).** In the same
throwaway worktree a case that enqueues **one** message was inserted above `A1`
(bumping the adapter's sequence):

- delivered assertion (`toMatchObject` + `/^memory-\d+$/`) → `6 passed (6)`;
- the old `toEqual(… messageId: "memory-1")` restored, same inserted case →
  `1 failed | 5 passed (6)`, `A1` alone, with
  `- "messageId": "memory-1"` / `+ "messageId": "memory-2"`.

So the literal was the brittle part and the replacement assertion survives the
insertion the finding describes. The spec was restored byte-identically
(`git status --short` empty at `33fa14f`).

## Consequences and known limits

- **`C1` pins an equality, not a value.** It cannot tell a context id from a
  header id by itself; what it pins is that the warn an operator reads and the
  response the caller holds carry **one** id. That is the correlation the review
  asked for, and it is the only assertion that stays true whichever mint wins.
- **The header arm stays covered by `B1`/`B2`** with a trusted literal
  (`req_pin_0001`/`req_pin_0002`), so the two arms remain distinguishable: a
  change that stopped echoing the request id altogether still reds them.
- **The response header is the oracle.** If a future change stopped echoing
  `x-request-id` at all, `C1` fails on its non-null guard with a message naming
  that (`the header-less response carried no x-request-id`) rather than on a
  confusing equality.
- **`A1`'s id is now shape-checked, not value-checked.** Nothing in the file
  depends on the adapter's sequence any more, so cases can be reordered freely;
  the id's presence and form are still asserted.
- **Accepted residual:** `C1` drives the bulk route only. The single-image route
  shares `requestLogger` and `defineRoute`, so the arm is the same code; a
  second header-less case there would measure the same line twice.

## Alternatives

- **Assert the minted id's shape in `C1` (`/^req_[0-9A-Z]+$/`)** — rejected: it
  would pass on a logger that minted its **own** id and never read the context,
  i.e. on exactly the regression the case exists for. Equality with the
  response header is the only ordering-free form that discriminates.
- **Assert the literal `req_01M7W3JEY2ZJ7GW9N9MX8K2Q77` the review measured** —
  rejected: it is a ULID minted per request, so it can never hold again.
- **Send an invalid `x-request-id` on `C1` instead of none** — rejected: that
  exercises `resolveRequestId`'s rejection path (a different seam, already
  pinned elsewhere) and still reaches `defineRoute`'s context, so it would not
  distinguish the two arms any better than the header-less request does.
- **Drop `A1`'s pointer assertion instead of loosening it** — rejected: the
  healthy-broker arm must still prove the accepted pointer was stored;
  `toMatchObject` + the id regex keeps that proof without the ordering
  dependency.
- **Reset the adapter's sequence in `beforeEach`** — rejected: it would change a
  shared hook for every case in the file to protect one literal, and the
  sequence is process-wide state other specs share; the assertion was the
  brittle part, not the hook.

## Number allocation

`0890`, a **pool draw**. At the delivery run on the trunk `65d3017d` both
`Next free` cells read `0888` and the trunk's highest record is `ADR-0887`; the
block `0849`–`0868` is exhausted (§11 items 18–21), so the draw advances **both**
the `OP-136 jobs lane` cell and the `unallocated (future lanes)` cursor to
`0891` — one above this record, so neither can re-mint it. The sweep immediately
before minting found two in-flight reservations above the trunk:
`ADR-0888` (`.worktrees/t_8290f915`, branch `OP-137-task-contact-digest-pins`,
PR [#752](https://github.com/yahodu/openpic-webapp/pull/752)) and `ADR-0889`
(`.worktrees/t_df4e6eb3`, branch `OP-137-task-suppression-strength-pins`, PR
[#755](https://github.com/yahodu/openpic-webapp/pull/755)); the trunk cell
`0888` therefore already names a number another lane holds, and
`git rev-list --objects --all -- docs/adr` (every fetched PR head included)
stops at `0889`. This record is that highest in-flight number plus one. No
`ADR-0890` file, object or PR-head path exists on any surface, and no number
outside `0890` is consumed.

## Review — round 1

Sign-off card `t_a2174a66` records the round-1 review of the pin card `t_26366405` (PR
[#757](https://github.com/yahodu/openpic-webapp/pull/757)). The delivery merged by its own card's
mandate before the review ran, so this is a **post-merge verification** of the bytes the trunk
carries. Every figure below is the reviewer's own measurement; none is transcribed from the
delivery comment. The trunk figures were measured at the squash `f370cf5b`; this section lands on
`origin/main` `1c2d519f`, which has since taken three other lanes' commits (`3da2dae1`,
`63dbe750`, `a69f0340`) and the release chore `1c2d519f` — `git log f370cf5b..origin/main -- <this
record>` is empty, so this record's bytes are unchanged.

- **Verdict:** accepted, `APPROVED WITH FINDINGS` — posted as PR comment
  [`issuecomment-7038383669`](https://github.com/yahodu/openpic-webapp/pull/757#issuecomment-7038383669).
  One **Low** docs finding (**F-A**, the ledger note's closing italic) is corrected by this
  sign-off card; no code finding is open.
- **Merge proof.** Head `708df0d0`, squash `f370cf5b0f0d90104f1aff79eb5d5888d454a537b`.
  `git diff --stat 708df0d0 f370cf5b` over the three PR paths
  (`apps/web/src/test/integration/image-requeue-enqueue-warn-pins.test.ts`, `docs/adr/README.md`
  and this record) is **empty**: the spec blob is `e92b116a`, the README blob `0baa2186` and this
  record's blob `91b9f4c2` on both sides. The one whole-tree difference to the branch head is
  `docs/adr/ADR-0886-op136-row-failed-warn-reason-pin.md` (+54), added by trunk commit `9e8b2f96`
  (`docs(adr): OP-136 sign off ADR-0886 round 1 (#756)`) — a commit that is **not** an ancestor of
  the branch, so the squash carries exactly the branch's bytes.
- **Re-run at the merged squash `f370cf5b`** (throwaway worktree, not the shared checkout): the pin
  file and `event-images-management.test.ts` → `2 files / 32 passed (32)` (`5 passed (5)` and
  `27 passed (27)`); the six `adr-*` guards → `6 files / 236 passed (236)`;
  `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `prettier --check` clean on the spec, this
  record and the README; **15/15** check runs `success` on `708df0d0` (`ci`, `unit_test`,
  `test_coverage`, `lint`, `secret-scan`, `audit`, `audit-dev`, `env-changes`,
  `validate-branch-name`, `validate-pr-title`, `Assert CI evidence`, CodeQL ×3, `notify-discord`).
- **P1 is load-bearing (F-1), reproduced by an independent probe.** `requestLogger` mutated to
  `request.headers.get(REQUEST_ID_HEADER) ?? newRequestId()` (the context arm dropped) →
  `1 failed | 4 passed (5)`, `C1` alone
  (`expected 'req_01M7WB9RW1VS9EN7B028VGTC7B' to be 'req_01M7WB9RVN262WA266GB8WW21G'`), `B1`/`B2`
  green; `apps/web/src/server/logging/index.ts` restored byte-identically
  (`sha256 9b993118b9fadc5ce36341bbc5ae6d8b5ad14ac40eff5dc964f9121d5d91b302`, `git status` clean).
- **P2 is order-independent (F-2), reproduced by a probe other than the delivery's.** Instead of
  inserting a case above `A1`, the adapter's sequence was started at `1`
  (`apps/web/src/server/adapters/memory-queue.ts`, `let sequence = 0` → `1`) — the state any
  preceding enqueuing case creates, and a wider one than a single insertion. The delivered
  assertion stays `5 passed (5)`; with the old literal restored under the same sequence, `A1`'s
  pre-delivery `toEqual(… messageId: "memory-1")` reads `1 failed | 3 passed (4)`, `A1` alone:

  ```
  -   "messageId": "memory-1",
  +   "messageId": "memory-2",
  ```

  Probe worktree restored clean.

- **Ledger.** At `f370cf5b`: 413 records, `uniq -d` over the numbers **empty**, `ADR-0890` present
  once, both `Next free` cells `0891`, rows ascending, both prose blocks kept. On this section's
  base `1c2d519f` the ledger reads **416** records with `ADR-0891` landed and both cells `0892`, no
  duplicate number and no gap below the cursor; this section mints no number and moves no cell.
- **F-A — the ledger note's closing italic (Low, docs).** The `docs/adr/README.md` note this
  delivery added ended `… the two cells and this note.__` while every other note in the file ends
  `this note._` — `od -c` read `n o t e . _ _ \n` and `prettier` does not normalize emphasis, so
  the gate was blind to it. This sign-off corrects that one character:
  `git diff --numstat docs/adr/README.md` is `1 1`, no row, cell, number or other lane's prose is
  touched, and `prettier --check` is clean on the file.
- **Residuals accepted, not retracted.** The single-image route stays unpinned — it shares
  `requestLogger` and `defineRoute` with the bulk route `C1` drives, so a second case there would
  measure the same line twice — and `C1` asserts an equality rather than a value, which is the only
  ordering-free form that discriminates (§Alternatives).
- **The two in-flight OP-137 branches' cells lag the trunk.** Their `Next free` cells read `0889`
  and `0890` while the trunk is at `0892` and holds the numbers those cells name, so their merges
  take the highest cell, not their recorded one ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md)
  §10 item 14); neither branch holds an `ADR-0890` file, so no duplicate exists.
- **No retraction.** Nothing in §Context, §Decision, §Evidence, §Consequences and known limits,
  §Alternatives or §Number allocation is retracted, reworded or re-badged, and every measurement
  those sections state stands — including the `6 passed (6)` the delivery's own insertion probe
  read, which this review's shifted-sequence probe reproduces in a second, independent form.
