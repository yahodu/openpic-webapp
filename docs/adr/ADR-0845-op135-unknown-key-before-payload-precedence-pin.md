# ADR-0845 — OP-135 TEST: the catalogue gate precedes the payload gate, and that last rung is pinned

- **Status:** Accepted (characterization pin — green on arrival against the shipped emitter, so the PR
  is non-draft and merges)
- **Card:** `t_6d67d20f` (OP-135 TEST, Low — finding **F1** of the round-1 review of `t_c7abcc83`) ·
  **Branch:** `OP-135-task-unknown-key-before-payload` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_ca95e452` · **Base:** `origin/main` `da6ed432` (the squash
  of PR #728), read at the branch cut; `origin/main` advanced to `187eafb8` (PR #727) while this branch
  was open, and was merged here before the PR, resolving the shared ledger as a **union** (this
  record's row, cell and note kept beside PR #727's `0878` row and its cell moves).
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0845`** at this base (ADR-0844 advanced it `0844` → `0845`). The sweep immediately
  before minting found no `ADR-0845`–`ADR-0848` path in `docs/adr` (397 ADR records at `da6ed432`; the
  lane's own files stop at `0844`, and the only `084[5-9]` name is `ADR-0849-op136-jobs-red.md`, the
  OP-136 lane's own), no `ADR-0845`–`ADR-0848` path in any of the 35 `.worktrees/*/docs/adr` trees,
  and none in `git rev-list --objects --all -- docs/adr` — which covers the 654 `refs/remotes/pr/*`
  heads — where the highest number on any object is **`0878`** (the OP-136 lane). The
  `OP-135 worker interface lane` cell of every reachable ref stops at `0845`. So this record takes **`0845`** and
  advances **only** that cell to `0846`; the `OP-136 jobs lane`, the `OP-129 attendee identity lane`
  and both `unallocated (future lanes)` cells are left as found, and no range is re-cut.
- **Consumers:** `apps/web/src/server/domain/domain-events.test.ts`
- **Consumes:** [ADR-0844](ADR-0844-op135-instant-before-payload-precedence-pin.md) §3 (where this rung
  is named as deliberately unpinned and owned by no card), [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md)
  §1 and [ADR-0844](ADR-0844-op135-instant-before-payload-precedence-pin.md) §1 (the ladder this record
  completes), [ADR-0029](ADR-0029-domain-events-outbox.md) §3 (`FORBIDDEN_PAYLOAD_KEYS`),
  [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §8.1 (the "more specific failure wins"
  argument, rejected for this ladder too), and contract §7.6 (the closed event catalogue).
- **Findings:** **Low** F1 of the round-1 review of the OP-135 F-B2 pin `t_c7abcc83` (PR #725, squash
  `4ba8c1fc`), recorded in ADR-0844 §3 as "one rung further down again … and no card owns it".

## Context

`apps/web/src/server/domain/domain-events.ts` asks its two semantic gates in a fixed order: the
catalogue gate `isRegisteredEventKey` (line 316), and only then the payload gate
`findForbiddenPayloadKey` (line 324). Both throw a `DomainEventError` before the settings read, the
clock stamp and the `insertOne`.

The emitter's own spec, `apps/web/src/server/domain/domain-events.test.ts`, pins each gate **alone**:
U1 answers `unknown_event_key` for an unregistered key with no forbidden payload, and U2 ×7 answers
`forbidden_payload_field` for a registered key with a forbidden key at some depth. No case carries
**both** faults, so the order between the two gates was written down nowhere.

An input can carry both faults: `eventKey: "totally.unknown.event"` (in no catalogue) with a payload
of `{ email: "leak" }` (`email` is on `FORBIDDEN_PAYLOAD_KEYS`, ADR-0029 §3, at depth 0). Both gates
refuse it, and neither lets a row through. What was unpinned is **which** `code` a caller sees.

This is the **last** rung of the ladder ADR-0842 and ADR-0844 pin from the route: the route's
forward-window guard runs ahead of the catalogue gate (ADR-0842) and ahead of the payload gate
(ADR-0844). With this record, no pair on that ladder is unpinned.

## Decision

### 1. Pin the shipped answer: `unknown_event_key`

Three grounds, and the first two are the ones that decide it:

1. **Both gates live in the same function.** No cross-module duplication is at stake here. The choice
   is code order inside one function, so the alternative buys nothing structural — it only gives a
   caller a second live shape to branch on.
2. **The more specific failure does not win.** An unregistered key and a forbidden payload are
   **disjoint** faults in disjoint fields; neither subsumes the other, so specificity cannot order
   them. This is the same reasoning [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md) §1 and
   [ADR-0844](ADR-0844-op135-instant-before-payload-precedence-pin.md) §1 applied one and two rungs
   up. ADR-0830 §8.1's "more specific failure wins" ordered two halves of **one** credential (bearer
   and signature) and does not reach disjoint fields.
3. **Retry logic needs one written-down ladder, not two live shapes.** A single `code` cannot report
   two faults, both faults are permanent for the input as sent, and the caller's branch table is the
   only consumer of the field.

What this record does **not** claim: a lone forbidden payload under a **registered** key still
answers `forbidden_payload_field` (U2 pins it), and a lone unknown key still answers
`unknown_event_key` (U1 pins it). Only the compound input's answer is decided here.

### 2. One appended case, and what each assertion is for

The host spec gains one `describe`/`it` pair **at its end**, after the `claimPendingEvents` block
(every existing case, helper, fixture, mock and spec literal untouched, `+18/−0`):

- a separate block, `emitDomainEvent — gate precedence when both gates refuse`, whose doc comment
  states that this is a characterization pin (ADR-0845);
- the input is `makeDomainEventInput({ eventKey: "totally.unknown.event", payload: { email: "leak" } })`
  — an unregistered key **and** a forbidden key at depth 0, so both gates have a reason to refuse;
- `await expect(emitDomainEvent(input, { db: fake.db, clock: fixedClock(T0) })).rejects.toMatchObject({ code: "unknown_event_key" })`
  — the answer is pinned through the `code` field, which is what a caller branches on;
- `expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false)` — neither gate lets a
  row through, so a "refuse in the error, write anyway" regression cannot pass.

The case reuses the file's own `makeFakeMongo`, `makeDomainEventInput`, `fixedClock` and `T0`; no new
helper, constant or fixture is minted.

**Characterization, green on arrival.** The behaviour already ships, so this is not a RED pin: there
is no GREEN sibling card, the case is declared green on arrival here, in the case's own comment and
in the handoff, and the PR is non-draft.

### 3. Deliberately not pinned

- **The route-level rungs.** ADR-0842 (window before the catalogue gate) and ADR-0844 (window before
  the payload gate) own them; this case starts inside `emitDomainEvent` and cannot see the route.
- **The error message.** The pin asserts `code`, never the `DomainEventError` text; a reworded message
  must not redden the ladder.
- **A nested or second forbidden key.** U2 ×7 and the array case own the scan's depth; this case needs
  exactly one forbidden key to keep the payload gate live.
- **`invalid_domain_event`.** The structural schema runs ahead of both gates and the existing
  `input validation` block already pins it; a structurally invalid compound input is that code's
  subject, not this one's.

## Consequences

- The ladder is fully written down: route window guard → catalogue gate → payload gate, one record per
  pair (ADR-0842, ADR-0844, this one).
- A refactor that moves `findForbiddenPayloadKey` ahead of `isRegisteredEventKey` now reddens **exactly
  this case**, with `unknown_event_key` → `forbidden_payload_field` in the diff (probe P1 below).
- The host spec goes `27 → 28` cases at this base. An append keeps the file's decomposition from
  growing anywhere but the end.
- `docs/adr/README.md` is the shared-ledger hotspot: this record's lane cell (`0845` → `0846`), its one
  index row and its one note merge as a union keeping the highest cells, and no other row is touched.

## Alternatives

1. **Pin `forbidden_payload_field`** (the payload gate before the catalogue gate). Rejected, and
   **measured**: probe P1 shows the case reds with that code. Choosing it would mean keeping the case
   RED, opening a **draft** PR and creating a GREEN card for a reorder with no behavioural benefit,
   and it would answer inconsistently with the two rungs above it (ADR-0842 §1, ADR-0844 §1), so the
   ladder would stop being one ladder.
2. **Leave the rung unpinned.** Rejected: the code is the one machine-readable field a worker's retry
   logic branches on, and a silent flip is exactly the finding class F1 named.
3. **Accept either code** (`expect([...]).toContain(code)`). Rejected: a pin that accepts both orders
   pins nothing and leaves two live shapes in a caller's branch table.
4. **Append inside U1 or U2.** Rejected: the card requires an append at the end, and a separate block
   keeps the compound case's documentation apart from the single-fault cases.

## Evidence

Base `origin/main` `da6ed432`. Host spec, measured at this head:

```
baseline  (27 cases):  Test Files  1 passed (1)   Tests  27 passed (27)
delivered (28 cases):  Test Files  1 passed (1)   Tests  28 passed (28)
```

**Green on arrival — a characterization, not a RED pin.** The case is not vacuous: probe **P1**, in a
throwaway detached worktree at `da6ed432` with the spec copied in and `node_modules` symlinked,
swapped the two gates (the payload scan ahead of the catalogue gate) in `domain-events.ts` and left
everything else as shipped:

```
Test Files  1 failed (1)
     Tests  1 failed | 27 passed (28)
 × U4: answers unknown_event_key when the unregistered eventKey also carries a forbidden payload key

- Expected
+ Received
-   "code": "unknown_event_key",
+   "code": "forbidden_payload_field",
```

This case reds **alone** — the other 27, U1 and the seven U2 rows included, stay green — which is what
makes the pin discriminating rather than decorative. `git checkout --` returned `domain-events.ts` to
`sha256 741e9a7ac6e6e512dc15aa2d3e6b9e2507fb7994735c582f79df78b50c272bad`, the same hash measured
before the mutation, `git status --short` showed only the spec, and the re-run answered
`28 passed (28)`. The probe worktree was removed.

The spec diff is `+18/−0`: one appended block, no existing case, helper, fixture, mock or literal
edited, and no production file in the delivered diff.

Gates on the delivered commit: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors;
`prettier --check` clean on the spec, this record and `docs/adr/README.md`; the `adr-*` guard family
green (6 files, 236 tests); the host spec `28 passed (28)` with all 27 pre-existing cases green.
