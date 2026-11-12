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

**The pin bites.** A throwaway mutation made the `413` path answer with a `urls` key (the cap branch
returned a `413` whose body spread one signed thumbnail entry carrying the content hash, with the error
code alongside it), and only that row failed:

```
AssertionError: expected [ { …(4) } ] to be undefined
 ❯ apps/web/src/test/integration/media-signed-urls.test.ts:1910:26
   1910|     expect(payload.urls).toBeUndefined();
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
