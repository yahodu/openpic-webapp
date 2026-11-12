# ADR-0776 — OP-128 follow-up TEST: the `I4` cap row states the no-signed-object pair too

- **Status:** Accepted (characterization pin — green on arrival against the gate branch tip `c62471d`)
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_cb3119c9` (TEST follow-up of the round-1 review finding **F3**, Low, on card `t_116afbb5`'s
  PR #454 at head `527a83e`), worktree `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-task-gate-i4-no-signed-object-pin`, cut from `origin/OP-128-task-account-status-gate-pins` =
  `c62471d` (the card named `42652bf`; `t_86191c8d`'s PR #455 landed after the card was written) — the
  uploads lane is unmerged, so `origin/main` carries no `apps/web/src/server/media/signed-urls.ts` to
  branch from
- **Consumes:** **ADR-0774 O2** (the open item this record closes), **ADR-0772 D3** (the item cap runs
  ahead of the account gate), ADR-0766 (the endpoint and its handler-owned `413`), ADR-0775 (the sibling
  refusal-row pin that showed the ledger's cell had moved to `0776`)
- **Supersedes:** nothing; ADR-0768, ADR-0770, ADR-0772, ADR-0773 and ADR-0774 are not edited, and
  `docs/API Contract.md` is unchanged

## Context

ADR-0774 pinned the no-signed-object pair — no `urls` key, no occurrence of the image's content hash in
the serialized JSON — on the sixth whole-request refusal row, `I7b > answers 413 payload_too_large for a
suspended caller's 201-item batch`. Its Consequences section recorded the remaining gap as open item
**O2**: `I4 > refuses 201 items with 413 payload_too_large` is an **authorized organizer's** cap refusal,
so the card that delivered the `I7b` pin was forbidden to touch it, and the row kept asserting only the
status and the `payload_too_large` code.

The behaviour is already correct. A `413` rejects the whole request before any item is authorized: the
cap check (`items.length > MAX_ITEMS`) precedes `resolvePrincipal` and the account gate (ADR-0772 D3),
and the Appendix A.1 error envelope has no member that could carry a URL or a content hash. So the
missing assertions protect nothing today — but they are the difference between six of seven refusal rows
stating the invariant and seven of seven, and an invariant with one silent exception is how it acquires
a second one.

## Decision

### D1 — the pair belongs on the `I4` cap row too

`I4 > refuses 201 items with 413 payload_too_large` is a whole-request refusal exactly like the other six:
no item is authorized, so no signed object may appear. The row now asserts
`expect(payload.urls).toBeUndefined()` and `expect(JSON.stringify(payload)).not.toContain(HASH_A)`
alongside the status and the code. The assertion is near-vacuous on today's envelope by design — it is a
characterization pin on the wire shape, not a claim about a reachable bug.

### D2 — one body read, the `I7b` shape copied verbatim, no new helper

`errorOf(response)` consumes the body, so the row reads it once — `const payload = await body(response);`
— and keeps the code assertion as `.code` on the parsed envelope (`payload.error as ErrorBody`), which is
exactly the shape ADR-0774 D2 established on the sibling row. No helper, fixture or factory is added: the
other refusal rows already read `body(response)` directly, and hoisting the pair into a shared assertion
would have to edit six reviewed rows.

### D3 — one case body edited, none added

Only the body of the `I4` `413` case changes. The case count is unchanged — **32 before, 32 after**,
because PR #455 added a case after this card was written (the card's `31 → 31` was the count at its
authoring cut) — no other row is touched, and no production file, contract text or mock moves.

## Number allocation

`0776` is taken from the **OP-126 uploads lane** row of `docs/adr/README.md` (`Reserved range`
`0760`–`0779`), whose `Next free` cell read `0776` at this branch cut (`0775` was consumed by
`t_86191c8d`); the cell advances to `0777`. Swept before minting, because this lane has collided three
times: no `ADR-0776` file exists in any `.worktrees/*/docs/adr`, on any `origin` ref, or in any open PR's
`docs/adr` tree.

## Evidence (measured on this branch)

**Focused integration**, `vitest run --project integration apps/web/src/test/integration/media-signed-urls.test.ts`
→ **32 passed (32)**; the case count does not change, because this pin edits one case body rather than
adding a row.

**Focused unit**, `media-signed-urls-authorization.test.ts` **24 passed (24)** untouched, and
`adr-numbering` **29 passed (29)** (53 together). **Full unit** → **157 files / 2526 passed | 3 skipped
(2529)**. **Full integration** (`TMPDIR=/root/tmp-mongo ./node_modules/.bin/vitest run --project
integration`) → **104 files / 1039 passed**. `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; prettier
clean and eslint `0 errors` on the touched spec (its single `security/detect-object-injection` warning at
`:176` is the pre-existing `requireHandler` namespace read, the same warning the base blob carries).

**The pin bites — and the reachable direction is the hash.** In a throwaway worktree the cap branch was
made to throw
`appError("payload_too_large", { details: { entries: [{ url, contentHash: <HASH_A> }] } })` — the shape
the sibling `uploads/batch-resolve` route already uses for a `413`. The `I4` row goes red on the
`expect(JSON.stringify(payload)).not.toContain(HASH_A)` line, and so does the sibling `I7b` `413` row
(which already carried the pair): both send a `>200`-item batch, so both see the same response body.
Measured, full file:

```
× I4: the batch limits > refuses 201 items with 413 payload_too_large
AssertionError: expected '{"error":{"code":"payload_too_large",…' not to contain 'bb6fc2a51ee46b2e25aa34a937bccb7dba859…'
Expected: "bb6fc2a51ee46b2e25aa34a937bccb7dba859e29aa6d5fddf3514180c7a5f3dc"
Received: "{"error":{"code":"payload_too_large","message":"The request body is too large.",…,"details":{"entries":[{"url":"https://pic.openpic.in/t/bb6fc2a5….webp","contentHash":"bb6fc2a5…"}]}}}"
 ❯ apps/web/src/test/integration/media-signed-urls.test.ts:1070:41
    1070|     expect(JSON.stringify(payload)).not.toContain(HASH_A);
× I7b: the gate's breadth … > answers 413 payload_too_large for a suspended caller's 201-item batch
 ❯ apps/web/src/test/integration/media-signed-urls.test.ts:2018:41
 Test Files  1 failed (1)
      Tests  2 failed | 30 passed (32)
```

Filtered to the `I4` row alone (`-t "refuses 201 items"`) the run is **1 failed | 31 skipped (32)**,
failing at the same `:1070:41` line.

**The `payload.urls` half is documentation-grade on this endpoint, stated exactly.** A mutation that
produces a top-level `urls` key cannot reach the wire here: the response serializer rejects a handler
body holding both `error` and `urls` (`500`, `Unrecognized key: "error"`), and the error envelope
projection emits only `error`. So `expect(payload.urls).toBeUndefined()` can only redden if that shared
projection grows a key — the same conclusion the reviewer of #454 recorded, repeated here rather than
inventing a probe for it. That is consistent with the six rows ADR-0774 and ADR-0772 approved.

The probe ran in a throwaway worktree that was removed afterwards; `route.ts` is
`sha256 2db3d986cb0c90c03454228a2ad7e6c458a56fdbe31f9e0abf7f5f8731526566` before and after, so the change
set holds no production byte.

## Consequences

- **O1 — ADR-0774 O2 is closed.** All seven whole-request refusal rows on this endpoint now state the same
  no-signed-object property. A future refactor that starts leaking a content hash on the cap path reddens
  this row, not only the account and deletion rows.
- **O2 — the pair is a wire-shape pin, not a reachable-bug guard.** The `urls` half cannot fail through
  any path available today (see Evidence); the hash half is the half a probe can move. Recorded so a
  later reader does not read more into the assertion than it proves.
- **O3 — no behaviour change, no GREEN sibling.** The pin is green on arrival; nothing downstream is owed.

## Alternatives

- **Leave the row alone** — rejected: six of seven refusal rows would state an invariant the seventh does
  not, which is exactly the asymmetry ADR-0774 O2 recorded and the reviewer had already measured.
- **Hoist the pair into a shared assertion helper and use it on all seven rows** — rejected: it would edit
  six reviewed, approved rows for no behavioural gain; this card must not touch them.
- **Probe a top-level `urls` mutation to "prove" the other half** — rejected: that shape answers `500`
  instead of `413` on this endpoint, so reporting it as a red would be a false measurement.
