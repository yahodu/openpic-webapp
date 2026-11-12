# ADR-0773 — OP-128 follow-up GREEN: one refusal seam logs `auth.denied` and throws the guard's decision

- **Status:** Accepted — the pins of [ADR-0771](ADR-0771-op128-signed-url-fallback-pins.md) and
  [ADR-0772](ADR-0772-op128-account-status-refusal-423-pins.md) are green
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_4b4c1a41` (GREEN follow-up of round-1 finding **F-G2**, Low, and the F-G1 re-pin's GREEN),
  worktree `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-account-status-refusal-423-green`, cut from the F-G1 pins head `5b55565`
  (`OP-128-task-account-status-refusal-423-pins`, stacked on `79bd74a` / PR #447, itself stacked on the gate
  branch `cfed101`)
- **Consumes:** ADR-0025 (the auth guard table and its log line), ADR-0767 (the endpoint's implementation),
  ADR-0770 (the inline gate this record replaces), **ADR-0772** (the envelope this record implements)
- **Supersedes:** nothing; **amends** ADR-0770's mechanism (the inline `throw appError("forbidden")` is gone) while
  keeping its gate; ADR-0768 D2 (the all-denied `403` for an allowed principal) is untouched

## Context

`reqAuth`-based routes emit one `warn` event `auth.denied` with `{label, reason}` before they throw
(`apps/web/src/server/auth/guards.ts`, `requireAuth`). The media signer is `public`-labelled so an anonymous caller
can reach its per-item `denied[] authentication_required` answer (ADR-0766 D3), so it resolves the principal itself
and ran the `user` table inline; on a denial it threw `appError("forbidden")` directly. Measured by the reviewer
(finding **F-G2**, Low): an account refusal there produced **only** `http.request.rejected status=403` — no
`auth.denied` event — so security monitoring of suspended and banned accounts lost this endpoint. The same inline
throw also flattened the guard's `code` and `details`, which is what **F-G1** re-pinned to Appendix A.1
(ADR-0772). One seam fixes both: the route duplicated `requireAuth`'s denial action instead of calling it.

## Decision

### D1 — extract the denial action as `enforceAuth` in `@/server/auth/guards`

`enforceAuth(label, facts, request, route)` runs `evaluateAuth`, returns on an allowed decision, and otherwise emits
one `requestLogger(request, { route }).warn("auth request denied", { event: "auth.denied", label, reason:
decision.code })` and throws `appError(decision.code, decision.details === undefined ? {} : { details:
decision.details })`. `requireAuth` now calls it with its own facts (`allowBanned` / `allowDeletionPending`
included), so its behaviour — one `auth.denied` line, the catalogue status and details — is unchanged; the helper is
the same body, not a second copy. `AppErrorOptions` is compiled with `exactOptionalPropertyTypes: true`, hence the
spread instead of `{ details: undefined }`.

### D2 — the media route refuses through that seam and stays `public`

`POST /api/v1/media/signed-urls` calls `enforceAuth("user", { principal, now: systemClock.now() }, ctx.request,
ctx.route)` for a `kind: "user"` principal in place of the inline `evaluateAuth` + `throw`. No route-level `auth`
stage is added: a `user`/`attendee` label would `401` the anonymous caller before the handler and break I6's `200`
with `denied[] authentication_required`. The handler's `413` cap still runs first, so a suspended caller with 201
items keeps `413` (ADR-0772 D3).

### D3 — the wire answer is ADR-0772's A.1 envelope, unchanged from the pins

`suspended` → `423 account_suspended` `{ reason: "suspended", supportUrl: "/support" }`; an active or permanent ban
→ `423 account_banned` `{ banReason, banExpires }` (`banExpires` an ISO string, or `null`); `deletion_pending` /
`deleted` → `403 forbidden` with no `details` key. The statuses come from the guard, so the route names no account
state.

### D4 — no new read, no contract change

The status and ban fields are already on the principal `resolvePrincipal` returns; the refusal costs no query and
I5's `reads(200) === reads(2)` still holds. `docs/API Contract.md` is not edited — ADR-0772 already brought the
implementation to §0.3 and Appendix A.1.

## Evidence (measured on this branch)

**GREEN from the pins.** `npx vitest run --project integration apps/web/src/test/integration/media-signed-urls.test.ts`
→ **31 passed (31)** (was `4 failed | 27 passed (31)`, every failure `expected 403 to be 423`). The focused unit spec
is untouched at **24 passed (24)**. Full suites: unit **157 files / 2526 passed | 3 skipped**, integration **104
files / 1038 passed**.

**The F-G2 line, verbatim** (`grep '"event":"auth.denied"'` on the focused run; six lines, one per refusal row):

```
{"level":"warn","service":"openpic-web","env":"test","requestId":"req_01M777JE37XG7NNA07KN93QB4K","route":"/api/v1/media/signed-urls","event":"auth.denied","label":"user","reason":"account_suspended","ts":"2026-11-12T06:36:53.233Z","msg":"auth request denied"}
```

**Gates.** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 errors (one pre-existing
`security/detect-object-injection` warning at `guards.ts:207`, the `user[flag]` completion filter); `prettier
--check` clean on both touched files; the `adr-numbering` guard green.

## Consequences

- **O1 — monitoring sees this endpoint.** A suspended or banned caller on the media signer now emits the same
  `auth.denied` `{label, reason}` event as every `reqAuth` route, with the reason naming the real code
  (`account_suspended` / `account_banned` / `forbidden`) instead of a generic status, and `reason` never carries a
  credential.
- **O2 — the two `403`s now mean different things.** `403 forbidden` is either a `deletion_pending`/`deleted`
  account refusal (no `details`) or §5.6's all-denied collapse for an **allowed** principal (ADR-0768 D2). A client
  distinguishes them by context, not status; a future contract change could give the deletion states their own
  code (ADR-0772 O4).
- **O3 — the log line is not pinned by a spec.** The media spec asserts the wire envelope only, so a future
  refactor could drop the `auth.denied` emission silently; `auth-guards.test.ts`'s I5 covers the seam on a normal
  route, not this call site. Recorded as a coverage gap for the Test Author, not fixed here.
- **O4 — one seam, so the two paths cannot drift.** A change to the denial action (a new event field, a different
  throw) reaches `requireAuth` and this route together; the `requireAuth` refactor is behaviour-preserving and its
  integration pins are green.

## Alternatives

- **Log locally in the route, keep the inline `throw`** — rejected: duplicates the guard's decision _and_ its log
  call, which is the F-G2 defect itself; the next account code would need a third copy.
- **Add a route-level `auth: "user"` stage** — rejected: the pipeline would answer `401` before the handler, so an
  anonymous caller could not receive I6's per-item `denied[] authentication_required`.
- **Keep `403 forbidden` and only add the log** — rejected by ADR-0772 (F-G1): a whole-request refusal denies the
  request, not one item, so the Appendix A.1 envelope owns it.

## Round-1 review (artifact lens)

Reviewed by the `openpic-webapp-reviewer` profile on PR #452 (head `75ffbbd`), squash-merged into
`OP-128-task-account-status-gate-pins` as `1676673`. The base branch tip equalled the merge base (`cfed101`) and
`git diff 75ffbbd 1676673` is empty, so the merged tree is byte-identical to the reviewed head. Verdict:
**approved with findings** — the seam is right, the pins are untouched, and the three findings below are routed.

**Gates the reviewer re-ran at `75ffbbd`.** Focused integration `media-signed-urls.test.ts` **31 passed (31)** (was
`4 failed | 27 passed (31)` at `5b55565`), with **6** `auth.denied` lines — two `account_suspended`, two
`account_banned`, two `forbidden`; focused unit + `adr-numbering` **53 passed (53)** (24 + 29); full unit **157
files / 2526 passed | 3 skipped**; full integration **104 files / 1038 passed**; `tsc -p apps/web/tsconfig.json
--noEmit` exit **0**; ESLint 0 errors (one pre-existing `security/detect-object-injection` warning at
`guards.ts:207`, byte-identical on the base blob); `prettier --check` clean; `git diff --stat 5b55565..75ffbbd --
apps/web/src/test` is empty, so no pin moved. Merged-tree re-check at `1676673`: `media-signed-urls.test.ts` +
`auth-guards.test.ts` **44 passed (44)**, focused unit + `adr-numbering` **53 passed (53)**.

**Behaviour audit.** The `403` collapse for an allowed principal (`route.ts:294-296`) is untouched; an account
refusal is now distinguished by its `details`, which ADR-0772's envelope owns. The item cap still runs before
`resolvePrincipal`, so a suspended caller with 201 items keeps `413`. The route is still `public`, so the anonymous
per-item `denied[] authentication_required` answer is intact, and the gate spends no read — `I5`'s
`reads(200) === reads(2)` still passes.

**F1 — Low, and it is the reason for a follow-up pin.** The media route's **call site** is not pinned for the
`auth.denied` event. Measured: replacing `enforceAuth(...)` with an equivalent route-local `evaluateAuth` plus a
throw of the same envelope keeps the focused spec **31 passed (31)** and emits **0** `auth.denied` lines, because
`auth-guards.test.ts:583` pins the shared helper through `requireAuth`, not through this route. Routed to card
`t_86191c8d` (PR #455), squash-merged as `c62471d`.

**F2 — Info.** The superseded drafts PR #447 and PR #450 stayed open after the review; their pins were already on
the lane branch via `1676673`. Both were closed with a supersession comment in the sign-off follow-up (card
`t_e7500b65`), so the same specs cannot land twice.

**F3 — Info.** The ADR lane-range overlap (F-L1) was already closed: card `t_95e7ed1e` is done, the allocator and
guard work is PR #448, and `0773` exists on this lane only.

**One line worth knowing when this spec is read.** The `ratelimit.limiter_failed` warn in the test output is the
documented `media.sign` coarse-stage fail-open under the synthetic `Request`, not a regression from this change.
