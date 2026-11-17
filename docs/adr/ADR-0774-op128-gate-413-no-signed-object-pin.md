# ADR-0774 — OP-128 follow-up TEST: the `413` refusal row pins the no-signed-object pair

- **Status:** Accepted (characterization pin — green on arrival against the GREEN `t_4b4c1a41`, `1676673`)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_116afbb5` (TEST follow-up of round-1 review finding **F1**, Low, on card `t_79d646b0`'s PR
  #450 at head `5b55565`), worktree `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-gate-413-no-signed-object-pin`, cut from the GREEN's branch tip `1676673`
  (`OP-128-task-account-status-gate-pins`) — the uploads lane is unmerged, so `origin/main` carries no
  `apps/web/src/server/media/signed-urls.ts` to branch from
- **Consumes:** ADR-0766 (the endpoint and its `413`), **ADR-0772 D3** (the item cap stays ahead of the
  account gate), ADR-0773 (the refusal seam whose rows carry the pair)
- **Supersedes:** nothing; the five account/deletion refusal rows, the expired-ban row, the `active`
  control and the mixed-batch row are untouched

## Context

The F-G1 re-pin (ADR-0772, card `t_79d646b0`) stated, for every whole-request refusal row, that the body
carries **no signed object**: no `urls` key, and no occurrence of the image's content hash anywhere in
the serialized JSON. Five rows carry that pair — the `I7` `it.each` table over `suspended` /
`deletion_pending` / `banned`, the suspended **matched attendee**, and `I7b`'s permanent ban and
`deleted` cases. The sixth refusal row, `I7b > answers 413 payload_too_large for a suspended caller's
201-item batch`, asserted only the status and the `payload_too_large` code.

The behaviour is correct: the cap runs before the account gate (ADR-0772 D3), and the Appendix A.1 error
envelope has no place to put a URL. So the missing pair costs two assertions and protects nothing today —
but it is the one row of six that does not _state_ the invariant, which is exactly how an invariant
quietly acquires an exception. The round-1 review of `t_79d646b0` recorded it as finding **F1** (Low).

## Decision

### D1 — the pair belongs on the `413` row too

A `413` rejects the **whole request**, exactly like the account refusals: no item is authorized, so no
signed object may appear. The row now asserts `expect(payload.urls).toBeUndefined()` and
`expect(JSON.stringify(payload)).not.toContain(HASH_A)` alongside the status and the code. The assertion
is near-vacuous on today's envelope by design — it is a characterization pin on the wire shape, not a
claim about a reachable bug.

### D2 — one body read, no new helper

`errorOf(response)` consumes the body, so the row reads it once — `const payload = await body(response);`
— and keeps the code assertion as `.code` on the parsed envelope (`payload.error as ErrorBody`), matching
the casts the file already uses. No helper, fixture or factory is added: the other refusal rows already
read `body(response)` directly, and a shared "refusal row" helper would have to be introduced into
reviewed rows.

### D3 — one case edited, none added

Only the body of the `I7b` `413` case changes. The case count is unchanged (31 before, 31 after), no
other row is touched, and no production file, contract text or mock moves.

## Evidence (measured on this branch)

**Focused integration**, `vitest run --project integration apps/web/src/test/integration/media-signed-urls.test.ts`
→ **31 passed (31)**; the case count does not change, because this pin edits one case body rather than
adding a row. **Focused unit**, `media-signed-urls-authorization.test.ts` → **24 passed (24)**, untouched.

**The pin bites.** A throwaway mutation made the `413` path leak and exactly one row failed. The mechanism and the
failure line are **corrected at round-1 review**: the reachable direction is the content hash, not a `urls` key. A
handler body that holds both `error` and a top-level `urls` is rejected by the response serializer, the route
answers `500` (`Unrecognized key: "error"`), and the error envelope (`toErrorEnvelope`) emits only `error` — so
`payload.urls` cannot redden from this route today. Throwing
`appError("payload_too_large", { details: { entries: [{ url, contentHash: <HASH_A> }] } })` in the cap branch — the
shape the sibling `uploads/batch-resolve` route already uses for its `413` — reddens the row as follows:

```
AssertionError: expected '{"error":{"code":"payload_too_large",…' not to contain 'bb6fc2a5…'
 ❯ apps/web/src/test/integration/media-signed-urls.test.ts:1911:26
   1911|     expect(JSON.stringify(payload)).not.toContain(HASH_A);
```

The probe was reverted with `git checkout --`, and `sha256sum` of
`apps/web/src/app/api/v1/media/signed-urls/route.ts` is `2db3d986cb0c90c03454228a2ad7e6c458a56fdbe31f9e0abf7f5f8731526566`
before and after, so the change set holds no production byte.

## Consequences

- **O1 — all six refusal rows state the same property.** A future refactor that starts returning a body
  with a URL on the cap path reddens this row, not just the account rows.
- **O2 — the `I4` batch-limit row still omits the pair.** `I4 > refuses 201 items with 413
payload_too_large` is an authorized organizer's cap refusal, not an account-gate refusal, so it sits
  outside this card's scope and stays as reviewed. Recorded as an open item: if the invariant is meant to
  cover _every_ `413`, that row is the remaining gap.
- **O3 — no behaviour change, no GREEN sibling.** The pin is green on arrival; nothing downstream is owed.

## Alternatives

- **Leave the row alone** — rejected: five of six refusal rows would state an invariant the sixth does
  not, and the reviewer had already measured the asymmetry.
- **Hoist the pair into a shared assertion helper and use it in all six rows** — rejected: it would edit
  five reviewed, approved rows for no behavioural gain; this card must not touch them.
- **Add a new case for the cap refusal** — rejected: no new behaviour to observe, and it would inflate
  the suite without protecting anything the existing row now protects.

## Round-1 review of the 413 no-signed-object pin (artifact lens)

Reviewed by the `openpic-webapp-reviewer` profile on PR #454 (head `527a83e`), squash-merged into
`OP-128-task-account-status-gate-pins` as `42652bf`. `git diff 527a83e 42652bf` is empty, so the merged tree is
byte-identical to the reviewed head. Verdict: **approved with findings** — one Low and two Info, none blocking.

**Gates the reviewer measured at `527a83e` and re-ran on the merged tree `42652bf`.** Focused integration
`media-signed-urls.test.ts` **31 passed (31)** — the case count does not change, because this row edits a case body
and the card's `32` was an assumption; focused unit `media-signed-urls-authorization.test.ts` + `adr-numbering`
**53 passed (53)**; full unit **157 files / 2526 passed | 3 skipped**; full integration **104 files / 1038 passed**;
`tsc -p apps/web/tsconfig.json --noEmit` exit **0**; ESLint 0 errors (the `security/detect-object-injection` warning
at `:169` is byte-identical on the base blob); `prettier --check` clean on the spec, this record and the ledger;
PR checks **11/11**. `ADR-0774` exists only on this lane — no other worktree, no `origin` ref, no open PR head —
inside the OP-126 block (`0760`–`0779`), cell `0774` → `0775`.

**The pin is load-bearing, and the Evidence mechanism is corrected.** The Evidence section first attributed the
failure to a `urls` key on the `413` answer and quoted `expected [ { …(4) } ] to be undefined` at `:1910`. That
shape is unreachable from the route: a handler body holding both `error` and a top-level `urls` is rejected by the
response serializer, the route answers `500` (`Unrecognized key: "error"`), and the error envelope (`toErrorEnvelope`)
emits only `error`, so `payload.urls` can redden only if that shared projection grows a key. The reachable direction
is the content hash, and it reddens exactly one row at `:1911`
(`expected '{"error":{"code":"payload_too_large",…' not to contain 'bb6fc2a5…'`); the Evidence section now states
that mechanism and that failure line. The substantive claim holds — the row is load-bearing — nothing else in this
record is retracted, and its decisions are not edited. The probe was reverted, and `route.ts` is `sha256 2db3d986…`
before and after it, so the reviewed tree holds no production byte.

**F2 — Info.** The `payload.urls` half of the pair is documentation-grade on this endpoint: no path reachable today
can make it fail. That matches the five refusal rows approved earlier, so no card is owed.

**F3 — Low.** The `I4` cap row (`refuses 201 items with 413 payload_too_large`, an authorized organizer) still
stated only the status and the code, while six whole-request refusal rows now state the no-signed-object pair.
Routed to card `t_cb3119c9` (PR #457), squash-merged as `a7b4083`.

**Landing.** PR #454 was squash-merged into `OP-128-task-account-status-gate-pins` (`42652bf`). The uploads lane is
still unmerged on `main`, so this is a stacked fold-in and no `main` ancestry is owed. The lane branch tips are no
longer the SHAs named in older cards.
