# ADR-0775 — OP-128 follow-up TEST: the media refusal's `auth.denied` line is pinned

- **Status:** Accepted (characterization pin — green on arrival against the gate branch tip `42652bf`)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_86191c8d` (TEST follow-up of round-1 review finding **F1**, Low, on card `t_4b4c1a41`'s PR
  #452 at head `75ffbbd`), worktree `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-auth-denied-log-pin`, cut from `origin/OP-128-task-account-status-gate-pins` = `42652bf`
  (the card named `1676673`; `t_116afbb5`'s PR #454 landed after the card was written) — the uploads lane
  is unmerged, so `origin/main` carries no `apps/web/src/server/media/signed-urls.ts` to branch from
- **Consumes:** ADR-0025 (the guard table and its `auth.denied` line), **ADR-0773** (the single refusal
  seam this pin observes), ADR-0772 (the Appendix A.1 envelope the refusal answers)
- **Supersedes:** nothing; **closes ADR-0773 O3** (the recorded coverage gap). ADR-0768, ADR-0770,
  ADR-0772 and ADR-0773 are not edited, and `docs/API Contract.md` is unchanged

## Context

F-G2's deliverable is the `warn` event `auth.denied` `{label, reason}` that security monitoring reads for
suspended and banned accounts. `enforceAuth` (`apps/web/src/server/auth/guards.ts`) writes it, and the
shared helper's log **is** pinned: `auth-guards.test.ts:583` asserts it through `requireAuth`, and deleting
the `warn` from `enforceAuth` reddens that spec (`1 failed | 12 passed`).

The media route's **call site** was not pinned. `POST /api/v1/media/signed-urls` is `public`-labelled
(ADR-0766 D3) so an anonymous caller can reach its per-item `denied[] authentication_required` answer, so
the route resolves its own principal and calls `enforceAuth` itself. The reviewer replaced that call with
the pre-F-G2 route-local `evaluateAuth(...)` + `throw appError(decision.code, …)` — the **same** wire
envelope, **no** log — and measured **31 passed (31)** with **zero** `auth.denied` lines. The deliverable's
observable half was therefore deletable on this endpoint without a red pin, which ADR-0773 O3 had already
recorded: "the log line is not pinned by a spec … recorded as a coverage gap for the Test Author".

## Decision

### D1 — one new case captures the port through `memoryTransport`

`apps/web/src/test/integration/media-signed-urls.test.ts` gains **one** case (case count `31 → 32`; no
delivered row is edited). It installs a capturing logger exactly as `auth-guards.test.ts:583-621` does —
`getLogger()` → `memoryTransport()` → `setLogger(createLogger({ level: "info", transports: [sink], … }))`
— and restores `setLogger(previous)` in a `finally`. The sink, not stdout, is the observable: a refusal
therefore prints no line to the run output, which is why the assertion is the evidence.

### D2 — the suspended refusal is the driver, and the entry is pinned field by field

The case drives the `I7` refusal state that already exists in the file (`userProfiles.status =
"suspended"` with the signed-in cookie). The response stays `423 account_suspended`, and the sink must hold
**exactly one** entry with `event === "auth.denied"`, `level === "warn"`, `label === "user"`,
`reason === "account_suspended"` and `route === "/api/v1/media/signed-urls"`. The route field is the
`requestLogger` child binding `enforceAuth` sets from `ctx.route`; pinning it here is the first assertion
on this endpoint that the line is attributable to this route rather than to the pipeline.

### D3 — the allowed control proves the event is denial-only

After the refusal, the same fixture shape with an `active` profile answers `200` with an empty `denied[]`,
and the `auth.denied` count stays at **one**. Without that control a refactor that logged the event on
every authenticated request would pass, and "the log is denial-only" is part of what monitoring assumes.

### D4 — the credential check is part of the pin

The raw cookie value of **both** callers must be absent from `JSON.stringify(sink.entries)` — the same
leak assertion `auth-guards.test.ts` makes. Two tokens rather than one, because the control's session is
written through the same logger.

### D5 — nothing else moves

No production byte (`route.ts`, `guards.ts`, `media/signed-urls.ts` are frozen at `42652bf`), no other
spec, no fixture, factory or helper, no contract text, and no edit to ADR-0768 / ADR-0770 / ADR-0772 /
ADR-0773.

## Number allocation

`0775` is taken from the **OP-126 uploads lane** row of `docs/adr/README.md` (`Reserved range`
`0760`–`0779`), whose `Next free` cell read `0775` at this branch cut; the cell advances to `0776`.
Swept before minting, because this lane has collided three times: no `ADR-0775` file exists in any
`.worktrees/*/docs/adr`, on any `origin` ref (including every open PR head), and none of the open PRs'
`docs/adr` trees carries `0775`.

## Evidence (measured on this branch)

**Focused integration**, `vitest run --project integration apps/web/src/test/integration/media-signed-urls.test.ts`
→ **32 passed (32)** (31 before this case). Filtered to the new case → **1 passed | 31 skipped (32)**, with
the sink holding exactly one `auth.denied` entry and the allowed control adding none. Note that the
`auth.denied` line for this case is captured by the memory transport and therefore does **not** appear in
the run's stdout; the four lines the full-file run prints belong to the other refused rows (`I7`, `I7b`),
which use the default logger.

**Focused unit**, `media-signed-urls-authorization.test.ts` → **24 passed (24)**, untouched; `adr-numbering`
→ **29 passed (29)** (53 together). Full `unit` and full `integration` measured on this branch; `tsc -p
apps/web/tsconfig.json --noEmit` exit `0`; prettier clean and eslint `0 errors` on the touched file (the one
`security/detect-object-injection` warning is the pre-existing `requireHandler` namespace read).

**The pin bites.** A mutation probe replaced the route's `enforceAuth(...)` call with the pre-F-G2 inline
`evaluateAuth(...)` + same-envelope `throw` shown in the review, ran the focused spec, and reverted:

```
route mutated; sha256 before=2db3d986cb0c90c03454228a2ad7e6c458a56fdbe31f9e0abf7f5f8731526566
     × logs exactly one warn auth.denied for a suspended caller and none for the active control 122ms
AssertionError: expected [] to have a length of 1 but got +0
 ❯ apps/web/src/test/integration/media-signed-urls.test.ts:1574:77
 Test Files  1 failed (1)
      Tests  1 failed | 31 passed (32)
sha256 after=2db3d986cb0c90c03454228a2ad7e6c458a56fdbe31f9e0abf7f5f8731526566
restored byte-identical: True
git diff empty: True
```

Only the new case fails, the other 31 stay green, and the route is byte-identical afterwards — so the
change set holds no production byte.

## Consequences

- **O1 — ADR-0773 O3 is closed.** The endpoint's `auth.denied` emission can no longer be deleted while
  keeping the wire envelope: the new case reddens with a count of `0`.
- **O2 — the pin covers the `user` label's account refusals, not the per-item denials.** `denied[]` codes
  (`not_found`, `forbidden`, `feature_not_available`, `authentication_required`) are per-item answers and
  are not auth denials; they stay unpinned as log events, which matches ADR-0025's denial action (the
  guards' table only).
- **O3 — the same call site serves `banned` and the deletion states.** They run through one `enforceAuth`
  call, so deleting the emission reddens this pin for all of them; their individual `reason` strings are
  not separately asserted, because the card scopes the case to the suspended row. A future refusal code
  added to the guards' table cannot silently lose its log — `enforceAuth` writes it — but its value is
  pinned only by `auth-guards.test.ts`.
- **O4 — no behaviour change, no GREEN sibling.** The pin is green on arrival; nothing downstream is owed.

## Alternatives

- **Capture stdout and grep the run output** — rejected: `setLogger` is the sanctioned seam,
  `auth-guards.test.ts` already uses it, and grepping text is neither assertable per-entry nor stable
  against the transport's formatting.
- **Spy on the logger (`vi.spyOn`) instead of replacing the port** — rejected: the port is a factory
  (`getLogger()`), so a spy would have to intercept every call site's `getLogger()`; the memory transport
  observes what the port actually wrote, including child bindings such as `route`.
- **Pin a line for each of the three refusal states** — rejected: the card asks for one case, and one call
  site produces all three, so a second row would duplicate the same assertion.
- **Skip the allowed control** — rejected: "logs nothing when allowed" is the half that keeps the event
  denial-only, and an always-warn refactor would otherwise pass this pin.
