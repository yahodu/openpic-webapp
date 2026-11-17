# ADR-0842 — OP-135 TEST: a doubly-invalid batch item is refused on its instant, and that ladder is contract

- **Status:** Accepted (characterization pin — green on arrival against the shipped route, so the PR is
  non-draft and merges)
- **Card:** `t_715cc420` (OP-135 TEST, Low, **F-B**) · **Branch:**
  `OP-135-task-event-instant-precedence-pin` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_ca95e452` · **Base:** `origin/main` `4a98f013`
  (release 1.65.6), which this branch was cut from
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0842`** at this base (ADR-0841 consumed `0841`). The sweep immediately before minting
  found no `ADR-0842*` file in `docs/adr`, none in any of the forty-one `.worktrees/*/docs/adr` trees
  (their maxima ranged `0856`–`0863`), no `ADR-0842*` path in `git log --all -- docs/adr/ADR-0842*`
  (which covers the 654 `refs/remotes/pr/*` heads), and `git rev-list --objects --all -- docs/adr`
  returning **`0863`** as the highest number on any object (the OP-136 lane) with no object **path**
  carrying `0842` — the three `0842` hits in that listing are hex substrings of object ids. So this
  record takes **`0842`** and advances **only** the `OP-135 worker interface lane` cell to `0843`; the
  OP-136 cell then read `0863` (the merge of `origin/main` `4a295db5` into this branch brought a newer
  trunk that had advanced it to `0864`, and the resolution keeps both moves), and the
  `OP-129 attendee identity lane` cell and both `unallocated (future
lanes)` cells stay `0869`. No range is re-cut.
- **Consumers:** `apps/web/src/test/integration/internal-worker-endpoints.test.ts`
- **Consumes:** [ADR-0835](ADR-0835-op135-internal-worker-boundary-hardening-green.md) §4 (where the
  forward-window guard lives and why) and its §"Review sign-off (round 1, artifact lens)" **F-B** (the
  finding this record pins), [ADR-0834](ADR-0834-op135-internal-worker-boundary-pins.md) §5 (the
  reason code and the measured one-sided window), [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md)
  §8.1 (the "more specific failure wins" argument this record considers and **rejects** for this
  ladder), [ADR-0829](ADR-0829-op135-internal-worker-endpoints-red.md) §2 (the batch contract),
  contract §10.3.2 (the batch body and its three-counter answer) and §7.6 (the closed catalogue).
- **Findings:** **F-B** (Low) of the review of the OP-135 hardening GREEN `t_b4a1ee9c`, recorded in
  ADR-0835's review sign-off and never carded until now; the chain's parent is `t_7513b52a`.

## Context

`apps/web/src/app/api/v1/internal/domain-events/route.ts` asks its two per-item questions in a fixed
order: the forward-window guard first, the catalogue gate second (the latter inside
`emitDomainEvent`). An item that is **both** more than 24 h ahead **and** keyed outside `EVENT_KEYS`
therefore answers:

```json
{ "index": 1, "eventKey": "pipeline.event.not_a_real_key", "reason": "occurred_at_out_of_window" }
```

Both rungs refuse the item and neither writes a row, so nothing about the stored data is at stake.
What is unpinned is **which** refusal the caller sees. ADR-0835 §4 says the hardening left
"`unknown_event_key`'s per-item behaviour, indices and reasons unchanged", and ADR-0834 §5 pinned
that for the unknown key **alone**, so the compound item's answer is decided by code order rather
than by a decision. The reason string is the only machine-readable thing a worker branches on, which
is why an accidental order is worth one case and one record even where the data outcome is identical.

## Decision

### 1. The envelope's instant gate runs first, and that order is contract

Pinned as shipped: `occurred_at_out_of_window`. Four grounds, recorded so the choice is auditable
rather than a rationalisation of the status quo:

1. **Layer ownership decides it.** The window guard can only live in the route: ADR-0835 §4 places it
   there because `emitDomainEvent`'s clock seam _is_ the worker's instant and that function's own
   specs drive fixed clocks. The catalogue gate, in contrast, must stay inside `emitDomainEvent`,
   which every in-process publisher of a domain event calls (`attendee/claim.ts`, the billing
   projection and its jobs). The route has no access to the vocabulary — `isRegisteredEventKey` is
   private to that module. So the ladder is structurally: the route's envelope question, then the
   emitter's semantic ones. Resolving the key first would require the route to carry a **second copy**
   of a rule the emitter must keep anyway, which is how two vocabularies drift apart.
2. **The §8.1 analogy is rejected, explicitly.** ADR-0830 §8.1 ordered two verdicts because they were
   answers about **one** authentication act: bearer and signature are two halves of one credential,
   and a signature that is present but does not verify is specific evidence about that same attempt.
   Here the two faults live in **disjoint fields** — `occurredAt` and `eventKey` — and neither
   refusal subsumes the other, so "the more specific failure" does not discriminate and cannot order
   them. Applying §8.1 to this pair would be importing a rule from a case it was not about.
3. **No order saves the caller a round trip.** No single `reason` can report two faults, so a caller
   that fixes the instant still learns the key on its next send, and a caller told the key first still
   has to fix the instant. The order therefore costs nothing in retry budget and cannot be chosen on
   that ground either way.
4. **What retry logic actually needs is stability.** The presence of a rejection, its `index` and its
   `eventKey` are what make an item permanently un-sendable; the `reason` names which field to fix and
   both faults are permanent for the item as sent. One ladder, written down, is what keeps a caller's
   branch table valid across a refactor.

What this record does **not** claim: that the instant is the more important fault, or that
`unknown_event_key` is ever wrong to answer. A **lone** unknown key still answers `unknown_event_key`
(I1 in the host spec, ADR-0834 §3); only the compound item's verdict is decided here.

### 2. One appended case, and what each assertion is for

The spec gains one `describe`/`it` pair at its end (the frozen 50 cases, every helper, fixture, mock
and spec literal untouched; the diff is `+68/−0` in that one file):

- the batch has two items: a **registered** key with an instant an hour in the past (inside the
  one-sided window) and the compound item — `UNKNOWN_EVENT_KEY` with `occurredAt = now + 25 h`;
- `202`, `keysOf(body)` = the three counters, `accepted: 1`, `deduped: 0`, and `rejected` **exactly**
  `[{index: 1, eventKey: UNKNOWN_EVENT_KEY, reason: "occurred_at_out_of_window"}]`;
- the compound item sits at **index 1**, not 0, so a ladder that only refuses the batch's first item
  cannot pass by position;
- the tenant-scoped `domain_events` rows are **exactly** `[PIPELINE_INDEXED_EVENT]` — the finding says
  neither path writes a row, so the case states that on the data surface too and a "refuse in the
  answer, write anyway" regression cannot pass it (probe M2 below).

The case reuses the file's own `world()`, `domainEvent()`, `signedPost()`, `domainEventsHandler`,
`bodyOf()`, `keysOf()`, `BATCH_KEYS`, `UNKNOWN_EVENT_KEY`, `PIPELINE_INDEXED_EVENT`,
`EVENT_INSTANT_WINDOW_MS` and `OUT_OF_WINDOW_REASON`; no new helper, constant or fixture is minted.

### 3. Deliberately not pinned

- **The lone-unknown-key arm** (I1, ADR-0834 §3) and **the lone-out-of-window arm** (F6, ADR-0834 §5):
  both already pinned; this case adds only their intersection.
- **The rung below.** An item that is future-dated **and** carries a forbidden payload key answers
  `occurred_at_out_of_window` today, the same question one rung lower. Unpinned and named here so the
  omission is auditable; no contract text decides it and this card owns only F-B.
- **`dedupeKey` interaction.** Not part of the finding: a refused item never reaches the dedupe index.
- **A symmetric window.** The bound stays one-sided forward (ADR-0834 §6 measured the symmetric form
  reddening four frozen cases); this record restates nothing about it.

## Consequences

- F-B is closed as **documented and pinned, not fixed**: the shipped order is judged defensible, so
  there is no production change, no GREEN sibling card, and this PR is non-draft and merges.
- A refactor that reorders the ladder — resolving the key before the window — now reddens **exactly
  this case**, with the reason string in the diff (probe M1). That is the regression this record buys.
- The host spec is `2638 → 2706` lines and `50 → 51` cases. The decomposition decision the earlier
  OP-135 records flag stays due; an append keeps it from growing anywhere but the end.
- `docs/adr/README.md` is the shared-ledger hotspot: this record's lane cell (`0842` → `0843`) and its
  one index row merge as a union keeping the highest cells, and no other row is touched.
- The card's acceptance line "the lane spec goes `42` → `43 passed`" is stale at this base: it is
  `50 → 51` here, measured, as the orchestrator's premise correction on the card records.

## Alternatives

1. **Pin `unknown_event_key` (resolve the key first).** Rejected, and **measured**: under that ladder
   the case reds with `- "reason": "occurred_at_out_of_window"` / `+ "reason": "unknown_event_key"`
   (probe M1, `1 failed | 50 passed (51)`). Pinning it would mean a RED case plus a GREEN card whose
   only content is a second copy of the catalogue rule in the route (or a new public predicate), and
   the order would still not be justified by specificity — see §1 ground 2.
2. **Leave it unpinned** ("ordered by accident", ADR-0835's own wording). Rejected: the reason is
   caller-visible and an unrelated refactor could flip it silently, which is exactly what the finding
   says is wrong with the present state.
3. **Accept either reason** (`expect([...]).toContain(reason)`). Rejected: a pin that accepts both
   orders pins nothing, and a worker's branch table would still have two live shapes.
4. **Add the case inside the F6 `describe`.** Rejected: the card requires an append, and editing a
   frozen describe risks the lane's contract; the finding also owns its own record.

## Evidence

Base `origin/main` `4a98f013` (release 1.65.6), branch cut from it. Lane spec, before and after the
append:

```
baseline  (50 cases):  Test Files  1 passed (1)   Tests  50 passed (50)
delivered (51 cases):  Test Files  1 passed (1)   Tests  51 passed (51)
```

**Green on arrival — a characterization, not a RED pin.** The case is not vacuous: two probes, each
applied alone to the shipped route in this worktree and reverted, with the route restored
byte-identically (`sha256 4eb0d7f045a9fa2ea503070cb82fcbd2aacfe6619aa4fd8ba40c77923728fb2f`, measured
before the probes and after the revert; `git status` clean apart from the spec):

| Probe | Mutation of the shipped route                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | the catalogue gate moved **ahead** of the window guard (both key lists imported into the route)         | `1 failed \| 50 passed (51)` — **this case alone**: `AssertionError: expected [ { index: 1, …(2) } ] to deeply equal [ { index: 1, …(2) } ]` with `- "reason": "occurred_at_out_of_window"` / `+ "reason": "unknown_event_key"`. The 50 frozen cases stay green, so the pin discriminates the ladder and nothing else.                                                    |
| M2    | the window branch answers as shipped **and** inserts the refused item's row (`domain_events.insertOne`) | `1 failed \| 50 skipped (51)` under `-t "F-B: applies the sibling"`: `AssertionError: expected [ 'pipeline.event.indexed', …(1) ] to deeply equal [ 'pipeline.event.indexed' ]` with `+ "pipeline.event.not_a_real_key"`. The counters stay `accepted: 1` with one rejection, so only the stored-row assertion can see the lie — that surface is load-bearing on its own. |

A first M2 variant is recorded as **measured and discarded**: with the window guard disabled and
`isRegisteredEventKey` opened, the case reds at `accepted` (`expected 2 to be 1`) before it reaches the
stored rows. The two surfaces are one fact seen twice; M2 is the variant that isolates the data one.

Gates on the delivered commit: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors;
`prettier --check` clean on the spec, this record and `docs/adr/README.md`; the `adr-*` guard family
green (6 files, including `adr-numbering`, `adr-record-links`, `adr-consumers`, `adr-lane-ranges`);
the lane spec `51 passed (51)` with all 50 pre-existing cases green. No production file, helper,
fixture or mock is touched: `git diff --numstat` is `+68/−0` in the one spec.
