# ADR-0905 — OP-138 TEST: the anonymous attendee's durable DSR receipt, and the attendee list read

- **Status:** Accepted — pinned RED-first by `t_b8e9aa3d`, implemented by the
  gated GREEN `t_84c1b83e` (§11), and landed as PR
  [#786](https://github.com/yahodu/openpic-webapp/pull/786) squash `8f45462b`;
  the round-1 review is appended in `## Review — round 1`.
- **Date:** 2026-11-22
- **Card:** `t_b8e9aa3d` (OP-138 TEST, Medium; finding **F2** of the round-1
  review of the GREEN `t_0eab7a02` /
  [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md), PR
  [#781](https://github.com/yahodu/openpic-webapp/pull/781) squash `50a5e56f`),
  decided and routed by `t_4fdff479`
- **Branch:** `OP-138-feature-attendee-dsr-receipt`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op138-dsr-receipt`
- **Base:** `origin/main` **`2c278191`** (`test(compliance): OP-138 pin the
verbatim verifiedEmail comparison against a case variant (#784)`), read with
  `git fetch origin && git log --oneline -1 origin/main` immediately before the
  worktree was cut. The base spec ran **`39 passed (39)`** there.
- **Pins:** contract §8.1 (`docs/API Contract.md:2875`, its new auth line and
  receipt rules) and §1.5 (`:591`–`626`, the new cross-reference bullet); schema
  §20.3 (`docs/Notification and Database Design.md`, the collection with no TTL);
  [ADR-0898](ADR-0898-op138-data-subject-requests-red.md) §4,
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §3 and
  [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) §5.
- **Number allocation:** the OP-138 lane holds `0898`–`0917` and its `Next free`
  cell read **`0904`** on this base. This record takes **`0905`** — the number
  the decision card reserved for it — and advances the cell to **`0906`**, the
  higher of the trunk cell and `max(consumed) + 1`. No cell is lowered and no
  range is re-cut. The re-sweep at write time read: `origin/main` `2c278191`
  (highest record `ADR-0903`); `APP_ENV`-independent **`0904` nowhere in git** —
  it is an _untracked_ hold in `.worktrees/t_48e4b3a2`
  (`ADR-0904-op138-consent-policy-url-rotation-pin.md`), reserved for that
  blocked card and left alone; every open PR head (`#783` `d48199f3` stops at
  `0902`, `#780` `4662ca93` at `0918`, `#755` `c90ae3ba`, `#743` `40df0afd`,
  `#272` `d5be9af4` carry no `09xx`); and
  `git rev-list --objects --all -- docs/adr`, which resolves `ADR-0900`–`ADR-0903`
  and `ADR-0918` only.

## 1. Context — the receipt outlives the credential that earned it

`GET /api/v1/me/data-requests/{id}` admits the anonymous session that filed the
row ([ADR-0902 §5](ADR-0902-op138-dsr-consent-contract-green.md)), and an
attendee's session is a **30-day** credential: `retention.attendeeSessionDays`
(`apps/web/src/server/settings/platform-settings.ts:387`) equals
`compliance.slaDays.gdpr` (`:320`–`328`). So the credential dies on the very date
the statutory answer is due. Measured on the base:

- after `expireAt`, `findAttendeeSession` throws `attendee_session_expired`
  (`apps/web/src/server/attendee/session-resolver.ts:96`–`100`), which
  `resolvePrincipal` surfaces through `resolveAttendee` before the route body
  runs (`apps/web/src/server/auth/guards.ts:392`–`399`);
- after the TTL monitor deletes the row, the lookup returns `null` and the route
  answers `401 unauthenticated` (`…/data-requests/[id]/route.ts:69`–`72`);
- a re-created session carries a new `_id`, so it is not the owner and the read
  is `404`;
- `dataSubjectRequests` has **no TTL** (`apps/web/src/server/db/indexes.ts:604`–`636`),
  so the record outlives every credential that could read it;
- `GET /api/v1/me/data-requests` was `requireAuth("user")` (`route.ts:329`), so
  the same session could not enumerate the rows it filed either (ADR-0902 §9's
  residual);
- an anonymous attendee has no verified email and no phone on file, and contract
  §1.5 says they are "deliberately unreachable by notifications".

Row present, every path to it closed. That is the gap F2 named.

## 2. Decision — a signed, stateless receipt token is the attendee's durable channel

The `202` receipt for an **attendee** filing now names
`pollUrl: "/api/v1/me/data-requests/<id>?receipt=<token>"`; a **user** filing
keeps the bare path, because the account is the durable credential. The receipt
keeps its **six keys** — the token rides inside `pollUrl`, never beside it.

- **Wire format:** `base64url(payload) + "." + lowercase-hex
HMAC-SHA256(base64url(payload))`, with
  `payload = {"v":1,"kind":"dsr_receipt","requestId":"<24-hex>"}`, keyed with a
  domain-separated subkey (`"dsr-receipt:v1"`) of `INTERNAL_API_SECRET`. No new
  env var, no new settings key.
- **Stateless:** no column stores the token; nothing is minted at read time and
  nothing can be revoked, because nothing is held.
- **No `exp` claim:** the token's lifetime _is_ the request row's lifetime, and
  the row has no TTL. A claim would reintroduce the very cliff the receipt
  exists to remove.
- **Bound to its own id:** a valid token for another request is the ordinary
  `404 not_found`; a bad signature or a malformed payload is
  `401 unauthenticated`; never `403`, so the endpoint stays no oracle.
- **Resolved before the attendee session:** a stale `op_att` cookie cannot
  shadow a receipt the client still holds.
- **Not a session:** it reads one request (metadata + counted `executionLog`).
  It cannot list and it cannot file.
- **No re-issue path:** stated in the contract. The receipt is the only channel,
  so losing it loses the channel — a fact the attendee-facing copy must carry.

## 3. Decision — the list read is attendee-symmetric

`GET /api/v1/me/data-requests` replaces `requireAuth("user")` with the same
`dsrAuth` stage the two writes already use, and the handler branches on
`ctx.principal`: a user keeps today's `subject.userId` filter exactly, an
anonymous session filters on
`{"subject.kind":"anonymous","subject.attendeeSessionId": <session hex>}`. The
envelope, the cursor and the sort are unchanged, and the **receipt is not a list
credential** — one token names one row, so a `?receipt=` on the list with no
session is `401 unauthenticated`. This closes ADR-0902 §9's asymmetry residual:
the owner rule is now the same on both reads.

## 4. The contract now states it

`docs/API Contract.md` §8.1 gains the auth line (`user` **or** `attendee`), the
receipt paragraph and its six rules, inserted at the
`### GET … /me/data-requests · …/{id}` heading above the response example; §1.5
gains one cross-reference bullet at the end of the session's bullet list, so a
reader of the attendee session learns that the receipt — not the cookie — is the
way back. Both texts are the decision card's, verbatim.

## 5. Alternatives rejected

- **An emailed magic link.** An anonymous attendee has no verified address on
  file; this is the reason they are unreachable in the first place.
- **Selfie/biometric re-verification bound to the stored
  `subject.attendeeSessionId`.** The session row is gone by the time the answer
  is due, and a re-created session has a new `_id`, so the binding cannot be
  re-established without new biometric processing of a person who asked to be
  erased.
- **Extending the attendee-session TTL.** Moves the cliff, does not remove it,
  and widens the exposure window of every attendee credential to fix one read.
- **A stored token hash (a revocation story).** Nothing asks for revocation, and
  a stored hash plus a delete path is a column, a write and a race for a
  property no requirement names.
- **A new env var / settings key for the signing secret.** `INTERNAL_API_SECRET`
  already exists and a domain-separated subkey keeps the receipt's key disjoint
  from every other use of it.

## 6. The pins — what each of `I28`–`I31` forces

Appended to `apps/web/src/test/integration/data-subject-requests.test.ts`
(`+297/−0`; the shipped `39` cases, every helper and the harness
byte-identical). Each case is one `it`, so the file runs **43**.

- **I28** — the attendee `202` keeps exactly `id, requestType, status,
slaDueAt, acknowledgement, pollUrl`; `pollUrl` is
  `/api/v1/me/data-requests/<id>?receipt=<token>`; the tail matches
  `^\?receipt=[A-Za-z0-9_-]+\.[0-9a-f]{64}$`; the payload segment decodes to
  `{v:1, kind:"dsr_receipt", requestId:<the id>}` **and** re-encodes to the
  segment as sent, so the signature is over the bytes on the wire. Second arm:
  a user's filing answers the bare path with no `?`.
- **I29** — (a) the TTL end-state: with `attendeeSessions` row **deleted**, the
  `pollUrl` alone answers `200`, `id` equal to the filed id and `executionLog`
  an array; the same dangling cookie **without** the receipt is
  `401 unauthenticated`. (b) precedence: with that session's `expireAt` in the
  past, the receipt **with** the stale cookie is `200`; the stale cookie alone
  is `401 attendee_session_expired` — the shipped §1.5 refusal the receipt must
  not change.
- **I30** — two filings A and B from one session: A's path with **B's** token
  and no credential is `404 not_found`; A's path with one hex character of A's
  signature flipped is `401 unauthenticated`; `?receipt=garbage` is
  `401 unauthenticated`; A's bare path with no credential is
  `401 unauthenticated`. Never `403`.
- **I31** — filings from session S1 (two) and S2 (one): S1's cookie answers
  `200` with envelope `{data, page}`, exactly S1's two ids (sorted set), S2's
  absent, every row carrying exactly
  `id, requestType, regulation, status, slaDueAt, receivedAt`; S2's cookie
  answers S2's one; no credential is `401 unauthenticated`; S1's
  `?receipt=` **on the list** with no cookie is `401 unauthenticated`.

## 7. Measured evidence

On the base `2c278191` with the block appended, the focused command is:

```
pnpm vitest run --project integration apps/web/src/test/integration/data-subject-requests.test.ts
→ Tests  4 failed | 39 passed (43)
```

The four reds are exactly `I28`–`I31`, each at assertion level with its own
message and no harness or import error:

```
AssertionError: expected '' to match /^\?receipt=[A-Za-z0-9_-]+\.[0-9a-f]{6…/     (I28)
AssertionError: expected 401 to be 200 // Object.is equality                     (I29)
AssertionError: expected '' to match /^\?receipt=[A-Za-z0-9_-]+\.[0-9a-f]{6…/     (I30)
AssertionError: expected 401 to be 200 // Object.is equality                     (I31)
```

`I28`/`I30` red because the shipped `pollUrl` is the bare path, so the tail after
the path is the empty string; `I29`/`I31` red because the shipped detail read
refuses a receipt-only call and the shipped list refuses an attendee session.
The `39` shipped cases — including `I23`/`I24` (a live session's own read, and
another session's `404`), `I7b`/`I7c`, `I25`–`I27` — stay green: they are the
control that the pins are additive.

Checks on this head: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`;
`eslint` **0 errors, 0 warnings** on the spec; `prettier --check` clean on the
spec and both documents; the seven `adr-*` guards green.

## 8. Deviations and decisions taken while pinning

- **`I29`'s lapsed-cookie control asserts `attendee_session_expired`, not
  `unauthenticated`.** The card's control sentence wrote `unauthenticated`, but
  the card's own gap section reserves that code for the **deleted-row**
  end-state, which is where `I29(a)` pins it. A lapsed row throws the specific
  `attendee_session_expired` through `resolvePrincipal` before the route body
  runs, so `unauthenticated` would be an unsatisfiable assertion there. The
  truthful pin is recorded instead, and the receipt-precedence half is unchanged.
- **`I31`'s no-credential arm reds at base with `authentication_required`.** The
  shipped `requireAuth("user")` refuses a null principal with that code
  (`guards.ts:169`–`171`); the contract's `dsrAuth` refuses with
  `unauthenticated`. The pin states the decided end state, so this arm is red on
  the base as well — an intended consequence of moving the list onto `dsrAuth`,
  and a behaviour change the GREEN must make deliberately.
- **`I31` pins the row key set exactly** (`LIST_ROW_KEYS`), not "at least these
  keys": the list row is wire shape, and a seventh field is a contract change
  that should red.
- **Every case reuses the file's helpers** (`seedOwnerEvent`,
  `createAttendeeSession`, `fileRequest`, `getRequest`, `bodyOf`, `errorBody`,
  `asId`, `DATA_SUBJECT_REQUESTS`/`COLLECTIONS`, `app.db`) and adds only local
  readers: `receiptOf`, `pathOf`, `segmentsOf`, `receiptPayloadOf`,
  `tamperedReceiptOf`, `listRowsOf`, `listIdsOf`.

## 9. Residuals

- A leaked receipt reads **one** request — the same exposure class as the
  session cookie it replaces, and bounded to a row the attendee filed about
  themselves.
- **No re-issue path**, by design and stated in the contract. Losing the receipt
  loses the channel; the acknowledgement copy owes that sentence to the client.
- `export` stays `null` until OP-150.
- The receipt covers the attendee's own rows only. A **user** filing still has
  no receipt, because the account is already durable.

## 10. Out of scope

This card writes **tests, two documents and this ledger bookkeeping**. It adds no
route, no module, no setting, no index and no collection, and it does not touch
`apps/web/src/app/api/v1/me/data-requests/**` — the gated GREEN `t_84c1b83e`
does, on this same branch and worktree, and the REVIEW card `t_47a8e5e0` owns the
merge. PR **#783** (`OP-138-task-reuse-attendee-session`, head `d48199f3`, open)
edits the same `[id]/route.ts` + `_lib/principal.ts` pair; the GREEN merges the
then-current `origin/main` (**merge, never rebase**) rather than depending on it.

## 11. GREEN — how the shipped code satisfies the pins

`t_84c1b83e` landed `00e31253` on this branch with **no test, fixture or helper
edit** (`git diff --numstat 34d40d32..HEAD -- apps/web/src/test` is empty): the
new `apps/web/src/server/compliance/receipt.ts` mints and verifies the token
exactly as §2 specifies, keyed per call with
`hmacSha256Hex(INTERNAL_API_SECRET, "dsr-receipt:v1")`.

**Precedence is "missing or lapsed, never live".** `I29(b)` requires the receipt
to outrank a lapsed session; the shipped `I24` requires another **live** session
to keep answering `404`. `dsrReadAuth` therefore tolerates only
`unauthenticated` / `attendee_session_expired` when `?receipt=` is present, and
`liveAttendeeSession` turns a lapsed row into `null`; the handler applies the
live session's owner filter when one resolves and the receipt's `_id` +
`subject.kind: "anonymous"` binding only when none does. A valid token for
another id still answers `404`, a bad signature or payload `401`.

## Review — round 1

Sign-off card `t_31bf521f` records the round-1 (artifact-lens) review of this lane by
`t_47a8e5e0` (PR [#786](https://github.com/yahodu/openpic-webapp/pull/786)). The suite and
probe figures are the review card's own runs at head `e6044d2c`; the landing and
reconciliation facts are re-read by this sign-off. This section only appends — no decision of
§1–§11 is retracted or amended.

- **Verdict: `APPROVED WITH FINDINGS`, landed.** Posted as the review comment
  [issuecomment-7077723508](https://github.com/yahodu/openpic-webapp/pull/786#issuecomment-7077723508)
  and the landing comment
  [issuecomment-7077732719](https://github.com/yahodu/openpic-webapp/pull/786#issuecomment-7077732719).
- **Suites at `e6044d2c`.** Focused `data-subject-requests.test.ts` **43 passed (43)**; `unit`
  **191 files, 3209 passed | 3 skipped (3212)**; `integration` **153 files, 1636 passed
  (1636)**; `adr-numbering.test.ts` on the `origin/main`-merged tree **29 passed (29)** with the
  unique-prefix `uniq -d` empty; `tsc` exit `0` on `apps/web` and `packages/contracts`; `eslint`
  **0**; `prettier --check` clean; `git diff --numstat 34d40d32..c666778d -- apps/web/src/test`
  empty, so no shipped case, helper or harness moved.
- **Discrimination probes** (throwaway worktree, each mutation reverted):
  - `dsrReadAuth`'s tolerance of a missing or lapsed credential dropped → **2 failed | 41 passed
    (43)**: `I29` `expected 401 to be 200` and `I30` `expected 401 to be 404`.
  - the `requestId === verdict.requestId` binding dropped → **1 failed | 42 passed (43)**:
    `I30` `expected 200 to be 404`.
  - the `subject.kind: "anonymous"` predicate dropped from the receipt owner filter →
    **43 passed (43)**: nothing reds. That is finding **F-R1** and the reason `t_c093c433`
    exists — the property holds by construction, not by a pin.
- **Gate on the exact head `e6044d2c`: `GATE: PASS`** — G1 `MERGEABLE` / `BLOCKED` (the
  1-review rule), G2/G3 **14/14** `COMPLETED`/`SUCCESS` with every gating name present, G4 pass
  (`2dfd2cf4..origin/main` empty of audit inputs), G5 pass.
- **Landing.** `git merge-base --is-ancestor 8f45462b origin/main` is OK;
  `e6044d2c^{tree}` == `8f45462b^{tree}` ==
  `3865a5d181712842f6d350514fd97ff1b71d5cd4` at the squash, when `8f45462b` was the trunk. The
  later release chore `354e4c41` (`1.72.0`) changes only `CHANGELOG.md` and `package.json`, and
  `git diff e6044d2c origin/main` over all eight PR paths is empty, so every reviewed byte is
  still the byte the trunk carries.
- **Reconciliation, inherited.** `origin/main` had advanced to `2dfd2cf4` (#787) after the
  branch cut, so it was merged in as `0ccc2497` (**merge, never rebase**) and
  `docs/adr/README.md` was resolved as a **union**: main's `OP-136 jobs lane` cell `0939` and
  its `unallocated` cursor `0939`, this lane's `0905` row and `0906` cell. A later lane reusing
  the file keeps both halves and the higher cell — never re-cut a range, never lower a cell.
- **Findings, routed and not fixed here.**
  - **F-R1** (Medium) — the user-row refusal and the counted `executionLog` are unpinned →
    `t_c093c433` (Test Author).
  - **F-R2** (Low) — `constantTimeEquals`'s TSDoc claimed the opposite of the code; **fixed in
    this PR**, comment only, commit `e6044d2c`.
  - **F-R3** (Low) — the attendee list read has no supporting index (schema §20.3) →
    `t_8680d063` (orchestrator).
  - **F-R4** (Info) — a valid receipt presented by a signed-in **user** answers `404` because
    the user branch owns the read; contract §8.1's "every other credential's `404` are
    unchanged" sanctions it. Recorded, no change.
- **Nothing retracted, no number consumed.** No section of this record is amended and
  `docs/adr/README.md` stays byte-identical to `origin/main` (blob `dedc7f4b`), so the lane's
  `Next free` cell remains `0906`; this sign-off mints no ADR number and touches no ledger cell.
