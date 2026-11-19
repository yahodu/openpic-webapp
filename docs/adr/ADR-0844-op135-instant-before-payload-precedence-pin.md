# ADR-0844 — OP-135 TEST: the instant gate also precedes the payload gate, and that rung is pinned

- **Status:** Accepted (characterization pin — green on arrival against the shipped route, so the PR is
  non-draft and merges)
- **Card:** `t_c7abcc83` (OP-135 TEST, Low, the rung below **F-B**) · **Branch:**
  `OP-135-task-forbidden-payload-precedence-pin` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_ca95e452` · **Base:** `origin/main` `e4273dd7` — the branch
  was cut from `f9257747` (the squash of PR #692, which carries ADR-0843's spec split) and rebased onto
  `e4273dd7` when the trunk advanced by 37 commits (OP-104 follow-up pins and review sign-offs, the
  OP-101 tenant-members chain, ADR-0318, and one whitespace-only edit to this spec's docblock); none of
  those commits touches the route, the emitter or the case this record adds, and the rebase's only
  conflict was this ledger, resolved as a union keeping the trunk row.
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0844`** at this base (ADR-0843 consumed `0843`). The sweep immediately before minting
  found no `ADR-0844*` path in `docs/adr` (395 ADR files at `e4273dd7`; the lane's own files stop at
  `0843`), no `ADR-0844`–`ADR-0848` path in any of the 33 `.worktrees/*/docs/adr` trees (the highest
  number in any of them is `0877`, the OP-136 lane), no `ADR-0844*` path in
  `git log --all -- docs/adr/ADR-0844*` and, at the sweep, **zero** `ADR-0844` hits in
  `git rev-list --objects --all -- docs/adr` — which covers the 654 `refs/remotes/pr/*` heads — while
  the highest number on any object is **`0877`** (the OP-136 lane) and the lane's range end is `0848`.
  The only `ADR-0844` object on any ref now is this record, carried by this branch.
  So this record takes **`0844`** and advances **only** the `OP-135 worker interface lane` cell to
  `0845`; the `OP-136 jobs lane` cell, the `OP-129 attendee identity lane` cell and the
  `unallocated (future lanes)` cells are left as found. No range is re-cut.
- **Consumers:** `apps/web/src/test/integration/internal-worker-endpoints.test.ts`
- **Consumes:** [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md) §1 (the shipped order this
  record extends one rung down) and §3 (the rung, named there as deliberately unpinned),
  [ADR-0835](ADR-0835-op135-internal-worker-boundary-hardening-green.md) §4 (where the forward-window
  guard lives and why), [ADR-0029](ADR-0029-domain-events-outbox.md) §3 (`FORBIDDEN_PAYLOAD_KEYS`),
  [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §5 and §6 (the reason code and the
  measured one-sided window), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §8.1 (the
  "more specific failure wins" argument, rejected for this ladder too), contract §10.3.2 (the batch
  body and its three-counter answer) and §7.6 (the closed catalogue).
- **Findings:** **Low** finding of the round-1 review of the OP-135 F-B pin `t_715cc420`
  (PR #665, squash `1d471f2f`), recorded in ADR-0842 §3 and owned by no card until this one.

## Context

`apps/web/src/app/api/v1/internal/domain-events/route.ts` asks its per-item questions in a fixed order:
the forward-window guard (line 74), then `emitDomainEvent`, which asks its own semantic questions in
turn — the catalogue gate `isRegisteredEventKey`, then the payload gate `findForbiddenPayloadKey`
(ADR-0029 §3). ADR-0842 pinned the **first** rung of that ladder for the compound item _future-dated
and outside the catalogue_, which answers `occurred_at_out_of_window`. The rung **below** it was
named there as deliberately unpinned, with the same shape:

```json
{ "index": 1, "eventKey": "pipeline.event.indexed", "reason": "occurred_at_out_of_window" }
```

The item carries a **registered** key, `occurredAt = now + 25 h` (outside `MAX_EVENT_AHEAD_MS`) **and**
a payload nesting `email`, a key the outbox refuses at any depth. The shipped answer is the window, so
`forbidden_payload_field` is never the reason a caller sees when the instant is also out of window.

Both rungs refuse the item and neither writes a row, so nothing about the stored data is at stake.
What is unpinned is **which** string a worker's retry logic branches on — the one machine-readable
field in the answer.

## Decision

### 1. The shipped answer stands: `occurred_at_out_of_window`, for the reasons ADR-0842 §1 already gave

This record **applies** ADR-0842 §1 rather than re-deciding it, and the argument carries one rung down
unchanged:

1. **Layer ownership decides it, again.** The window guard can only live in the route (ADR-0835 §4:
   `emitDomainEvent`'s clock seam _is_ the worker's instant and that function's own specs drive fixed
   clocks), while the payload gate must stay inside `emitDomainEvent`, which every in-process publisher
   of a domain event calls. The route can answer the instant question with one comparison; answering
   the payload question first would require the route to carry a **second copy** of
   `FORBIDDEN_PAYLOAD_KEYS` (and of the depth-first scan that walks nested objects and arrays), i.e.
   a second vocabulary that drifts from the emitter's.
2. **The §8.1 analogy is rejected here too.** Bearer + signature were two halves of **one** credential,
   so "the more specific failure wins" could order them. `occurredAt` and the payload key live in
   disjoint fields and neither refusal subsumes the other, so specificity does not discriminate.
3. **No order saves the caller a round trip, and stability is what retry logic needs.** A single
   `reason` cannot report two faults; both faults are permanent for the item as sent. What a caller
   needs is one written-down ladder across a refactor.

What this record does **not** claim: that the payload gate is unimportant, or that a lone forbidden key
is ever wrong to answer `forbidden_payload_field`. A **lone** forbidden key inside the window still
answers `forbidden_payload_field` (probe P1 below measures it in the emitter); only the compound item's
verdict is decided here.

### 2. One appended case, and what each assertion is for

The host spec gains one `describe`/`it` pair at its end, after ADR-0842's case (every existing case,
helper, fixture, mock and spec literal untouched):

- the batch has two items under one tenant: a **registered** key with an instant an hour in the past
  (inside the one-sided window) and the compound item — the **same** registered key, so nothing it
  carries can answer `unknown_event_key`, `occurredAt = now + 25 h`, and a payload of
  `{ email: "probe@example.test" }`;
- `202`, `keysOf(body)` = the three counters, `accepted: 1`, `deduped: 0`, and `rejected` **exactly**
  `[{index: 1, eventKey: "pipeline.event.indexed", reason: "occurred_at_out_of_window"}]`;
- the compound item sits at **index 1**, not 0, so a ladder that only refuses a batch's first item
  cannot pass by position;
- the tenant-scoped `domain_events` rows are **exactly** `[pipeline.event.indexed]`, and the stored
  documents do not contain the forbidden value — so a "refuse in the answer, write anyway" regression
  cannot pass, and the data-safety half of the finding is stated on the data surface.

The case reuses the file's own `world()`, `domainEvent()` (with its `payload` override), `signedPost()`,
`domainEventsHandler`, `bodyOf()`, `keysOf()`, `BATCH_KEYS`, `PIPELINE_INDEXED_EVENT`,
`EVENT_INSTANT_WINDOW_MS`, `OUT_OF_WINDOW_REASON` and `DomainEventRow`; no new helper, constant or
fixture is minted.

**Characterization, green on arrival.** The behaviour already ships, so this is not a RED pin, there is
no GREEN sibling card, and the PR is non-draft.

### 3. Deliberately not pinned

- **The lone-forbidden-key arm** inside the window: `emitDomainEvent`'s own spec owns the code
  (`forbidden_payload_field`), and probe P1 below measures that it is live. This case adds only the
  intersection.
- **The order of the catalogue gate against the payload gate** (unknown key _and_ forbidden payload):
  one rung further down again, decided by the same layer-ownership argument in the same function, and
  no card owns it.
- **`dedupeKey` interaction**: a refused item never reaches the dedupe index.
- **A symmetric window**: the bound stays one-sided forward (ADR-0834 §6).

## Consequences

- The rung below F-B is **documented and pinned, not changed**: no production code, no GREEN sibling,
  and the PR merges.
- A refactor that answers the payload question in the route, or moves the window guard behind
  `emitDomainEvent`, now reddens **exactly this case**, with the reason string in the diff (probe P2).
- The host spec goes `32 → 33` cases at this base (it was `51` before ADR-0843's split, of which this
  file kept 32). An append keeps the decomposition from growing anywhere but the end.
- `docs/adr/README.md` is the shared-ledger hotspot: this record's lane cell (`0844` → `0845`), its one
  index row and its note merge as a union keeping the highest cells, and no other row is touched.

## Alternatives

1. **Pin `forbidden_payload_field` (the semantic gate before the envelope gate).** Rejected, and
   **measured**: probe P2 shows the case reds with
   `- "reason": "occurred_at_out_of_window"` / `+ "reason": "forbidden_payload_field"`. Choosing it
   would mean keeping the case RED, opening a **draft** PR and creating a GREEN card whose content is a
   second copy of the forbidden-key list (and its recursive scan) in the route — the duplication
   ADR-0842 §1 ground 1 exists to prevent. ADR-0842 §1 would also have to be superseded, since the two
   rungs must answer consistently or the ladder stops being one ladder.
2. **Leave it unpinned.** Rejected: the reason is caller-visible and an unrelated refactor could flip
   it silently, which is exactly the class of finding that produced this card.
3. **Accept either reason** (`expect([...]).toContain(reason)`). Rejected: a pin that accepts both
   orders pins nothing and leaves two live shapes in a worker's branch table.
4. **Append inside ADR-0842's `describe`.** Rejected: that block's literals are F-B's (an unknown key),
   and the card requires an append after it; a separate block also keeps the two findings'
   documentation apart.

## Evidence

Base `origin/main` `e4273dd7` (the branch was rebased onto it; it was cut from `f9257747`). Host spec,
measured at this head:

```
baseline  (32 cases):  Test Files  1 passed (1)   Tests  32 passed (32)
delivered (33 cases):  Test Files  1 passed (1)   Tests  33 passed (33)
```

**Green on arrival — a characterization, not a RED pin.** The case is not vacuous; two probes, each
applied alone to the shipped route in this worktree and reverted, with the route restored
byte-identically (`sha256 4eb0d7f045a9fa2ea503070cb82fcbd2aacfe6619aa4fd8ba40c77923728fb2f`, measured
before the probes and after the revert; `git status` clean apart from the spec):

| Probe | Mutation of the shipped route                                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | the window bound widened to 365 days, so the compound item reaches `emitDomainEvent`                                                                   | `2 failed \| 31 passed (33)` — this case **and** F-B: `+ "reason": "forbidden_payload_field"` for the compound item and `+ "reason": "unknown_event_key"` for F-B's. This measures that the payload gate **is** live and would answer if the instant did not refuse first, so the compound item genuinely carries two reasons.                                                                                                                                            |
| P2    | a route-local forbidden-key pre-check placed **ahead** of the window branch (the forbidden list copied into the route, as alternative 1 would need it) | `1 failed \| 32 passed (33)` — **this case alone**: `AssertionError: expected [ { index: 1, …(2) } ] to deeply equal [ { index: 1, …(2) } ]` with `- "reason": "occurred_at_out_of_window"` / `+ "reason": "forbidden_payload_field"`. The 32 pre-existing cases stay green, so the pin discriminates this rung and nothing else; the counters and the stored-row assertions are satisfied either way, which is why the reason string is the surface the case exists for. |

Gates on the delivered commit: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors;
`prettier --check` clean on the spec, this record and `docs/adr/README.md`; the `adr-*` guard family
green (6 files, 236 tests); the host spec `33 passed (33)` with all 32 pre-existing cases green. No
production file, helper, fixture or mock is touched: the delivered diff is `+82/−0` in the one spec.

## Review sign-off (round 1, artifact lens)

The round-1 review of this pin was posted on PR
[#725](https://github.com/yahodu/openpic-webapp/pull/725) as comment `#issuecomment-7008095164`;
this sign-off is card `t_bfeda273`, which consumes **no** ADR number, changes no ledger cell and
leaves `docs/adr/README.md` byte-identical. **Verdict: APPROVED.** The deliverable had already merged
when the review ran (`gh pr merge 725 --squash --admin`, `2026-11-19T11:27:20Z`, squash `4ba8c1fc`), so
the review is a verification of **the merged bytes**, not of a proposed head.

**Tree identity — the review measures what shipped.** `800fd8ca^{tree}` == `4ba8c1fc^{tree}` ==
`9a4cba36998fa78257ce89f18e6e9db4a6f84192`, which was `origin/main^{tree}` at review time (`origin/main`
then stood at `4ba8c1fc`), and `git diff --stat 800fd8ca 4ba8c1fc` is empty over the whole tree, so no
path differs between the reviewed head and the squash. PR #725 reads **15/15 checks pass**, CI on
`4ba8c1fc` is `success`, and local `main` == `origin/main` == `4ba8c1fc`. The trunk has since advanced
to `750c0398` (the OP-132 fix `f7246b9d` and release `1.66.7`), and this record is byte-identical at
both trees — `git diff --stat 4ba8c1fc origin/main` over this file is empty — so the sign-off still
describes the bytes on `main`.

**Scope measured, not transcribed.** `git diff --name-only e4273dd7 800fd8ca` lists exactly three
paths, `+256/−1`: this record, `docs/adr/README.md` (its one cell, one row and one note) and
`apps/web/src/test/integration/internal-worker-endpoints.test.ts` at `+82/−0` — one `describe`/`it`
appended **after** F-B's block, with no existing case, helper, fixture or spec literal touched. No
production file is in the diff, which is the shape a characterization pin must have.

**Counts re-measured at the merged tree, not transcribed.** The host spec reads `33 passed (33)`; the
six `adr-*` guards read **6 files / 236 passed (236)**; `tsc -p apps/web/tsconfig.json --noEmit` exits
`0`; `eslint` exits `0`; `prettier --check` is clean on all three paths; the ledger holds 396 ADR files
with an empty duplicate-number sweep, and the only cell that moved is the OP-135 lane's `0844` →
`0845`. The recorded `32 → 33` reproduces independently: `32 passed (32)` at `e4273dd7`, measured in a
throwaway detached worktree, so the appended case is the only delta in the count.

**Both probes reproduced independently.** In a throwaway worktree at `800fd8ca`, with the route
reverted byte-identically (`sha256 4eb0d7f045a9fa2ea503070cb82fcbd2aacfe6619aa4fd8ba40c77923728fb2f`
before and after), both probes reproduce. **P2**, the route-local forbidden-key pre-check placed
**ahead** of the window branch, gives `1 failed | 32 passed (33)` — **this case alone**, with
`- "reason": "occurred_at_out_of_window"` / `+ "reason": "forbidden_payload_field"` in the assertion
diff. **P1**, the window bound widened to 365 days, gives `2 failed | 31 passed (33)` — this case and
F-B. §Evidence's two rows therefore hold as written, and the pin discriminates the rung it names and
nothing else.

**Findings and their post-review status.** **F1 (Low)** — the next rung down is still unpinned and was
ownerless: the catalogue gate against the payload gate **inside** `emitDomainEvent`, where an
unregistered key that also carries a forbidden payload answers `unknown_event_key`.
`apps/web/src/server/domain/domain-events.test.ts` pins each gate alone (U1 and U2) and no case
carries both. Routed to a TEST card created by this review, **`t_6d67d20f`**, gated behind this
sign-off. **F2 (Info)** — the appended case derives its instants from `Date.now()` like its F-B
sibling; the margins are ±1 h and +25 h, far above execution jitter, and two consecutive runs were
green. **F3 (Info)** — this record's claim that the emitter's own spec owns `forbidden_payload_field`
is accurate (`apps/web/src/server/domain/domain-events.test.ts:196,245`), and a `grep` scoped to
`apps/web/src/test` misses it only because that spec is colocated next to its module.

**Nothing above is retracted.** §Context, §Decision, §Consequences, §Alternatives and §Evidence stand
as written: the review changed no decision, added no number and touched no other file. F1's outcome is
not decided here — the TEST card `t_6d67d20f` carries it, and that card's own record documents what
follows.
