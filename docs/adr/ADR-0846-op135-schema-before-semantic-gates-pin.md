# ADR-0846 — OP-135 TEST: the structural schema gate precedes both semantic gates, and that last rung is pinned

- **Status:** Accepted (characterization pin — green on arrival against the shipped emitter, so the PR
  is non-draft and merges)
- **Card:** `t_2428b2b5` (OP-135 TEST, Low — finding **F1** of the round-1 review of `t_6d67d20f`) ·
  **Branch:** `OP-135-task-invalid-before-catalogue` · **Worktree:**
  `/root/openpic/openpic-webapp/.worktrees/t_ca95e452` · **Base:** `origin/main` `e0032a61` (the squash
  of PR #731), read at the branch cut.
- **Lane:** the OP-135 lane block `0829`–`0848` (row `OP-135 worker interface lane`), whose `Next free`
  cell read **`0846`** at this base (ADR-0845 advanced it `0845` → `0846`). The sweep immediately
  before minting found no `ADR-0846`–`ADR-0848` path in `docs/adr` (399 ADR records at `e0032a61`; the
  lane's own files stop at `0845`, and the only later names are the OP-136 lane's own `0849`–`0853`),
  no `ADR-0846`–`ADR-0848` path in any of the 35 `.worktrees/*/docs/adr` trees, and none in
  `git rev-list --objects --all -- docs/adr` — which covers the 657 `refs/remotes/pr/*` heads — where
  the highest number on any object is **`0879`** (the OP-136 lane). The four open PRs (#732, #729,
  #690, #272) were fetched into `refs/remotes/pr/*` for that sweep and their `OP-135 worker interface
lane` cells read `0846`, `0845`, `0843` and no row at all, so no reachable ref has drawn `0846`. So
  this record takes **`0846`** and advances **only** that cell to `0847`; the `OP-136 jobs lane`, the
  `OP-129 attendee identity lane` and both `unallocated (future lanes)` cells are left as found, and
  no range is re-cut.
- **Consumers:** `apps/web/src/server/domain/domain-events.test.ts`
- **Consumes:** [ADR-0845](ADR-0845-op135-unknown-key-before-payload-precedence-pin.md) §1 and §3 (the
  ladder this record completes, and the §3 claim it corrects),
  [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md) §1 and
  [ADR-0844](ADR-0844-op135-instant-before-payload-precedence-pin.md) §1 (the same reasoning applied at
  the route), [ADR-0029](ADR-0029-domain-events-outbox.md) §3 (`FORBIDDEN_PAYLOAD_KEYS`), and
  [ADR-0830](ADR-0830-op135-internal-worker-endpoints-green.md) §8.1 (the "more specific failure wins"
  argument, rejected for this ladder too).
- **Findings:** **Low** F1 of the round-1 review of the OP-135 F-B2 pin `t_6d67d20f` (PR #730, squash
  `61d7e947`, ADR-0845), which recorded the unpinned pair and routed it to this card.

## Context

`apps/web/src/server/domain/domain-events.ts` has **three** refusal sites, in the order the code asks
them at `e0032a61`: the structural schema `domainEventInputSchema.safeParse` (**line 308**,
`invalid_domain_event`), the catalogue gate `isRegisteredEventKey` (**line 317**, `unknown_event_key`),
then the payload gate `findForbiddenPayloadKey` (**line 324**, `forbidden_payload_field`). All three
throw before the settings read, the clock stamp and the `insertOne`.

ADR-0845 pinned the **catalogue-vs-payload** pair. Its §3 then recorded `invalid_domain_event` as not
needing a case, on the grounds that "the existing `input validation` block already pins it". That holds
for the **lone** fault only: the single case in
`describe("emitDomainEvent — input validation")`, `rejects an input that fails the structural schema`,
sends `makeDomainEventInput({ tenantId: "" })` with the factory's **valid** payload, so it passes the
payload gate on its way to the schema and cannot tell the two orders apart.

An input can carry both faults. Measured at `61d7e947` by the reviewer's throwaway probe spec:

```
makeDomainEventInput({ tenantId: "", payload: { email: "leak" } })
  => {"outcome":"invalid_domain_event","inserts":0}
```

`tenantId: ""` fails the schema's `min(1)`, and `email` is on `FORBIDDEN_PAYLOAD_KEYS` at depth 0
(ADR-0029 §3) while the payload itself is schema-valid — `z.record(z.string(), z.unknown())` accepts
`{ email: "leak" }` — so both the schema and the payload gate have a reason to refuse. The shipped
answer is `invalid_domain_event` with no row written, and **no case pinned it**.

This is the **last** unpinned pair of refusal-site orders inside `emitDomainEvent`. With this record the
function's ladder is written down pair by pair — schema against both semantic gates here, catalogue
against payload in ADR-0845 — and nothing outside the function is in scope.

## Decision

### 1. Pin the shipped answer: `invalid_domain_event`

Three grounds, and the first is structural rather than a preference:

1. **The schema must run first by construction.** `safeParse` is what produces `parsed.data`, and every
   later gate reads `parsed.data.eventKey` and `parsed.data.payload`. No reordering is even available
   without a rewrite that parses the input twice or scans a value the schema never checked.
2. **The more specific failure does not win.** A structural fault (`tenantId: ""`) and a semantic fault
   (a forbidden payload key) are **disjoint**, and neither subsumes the other, so specificity cannot
   order them. This is the reasoning
   [ADR-0842](ADR-0842-op135-event-instant-precedence-pin.md) §1,
   [ADR-0844](ADR-0844-op135-instant-before-payload-precedence-pin.md) §1 and
   [ADR-0845](ADR-0845-op135-unknown-key-before-payload-precedence-pin.md) §1 apply up this ladder.
   ADR-0830 §8.1's "more specific failure wins" ordered two halves of **one** credential and does not
   reach disjoint fields.
3. **A caller's retry logic needs one written-down ladder, not two live shapes.** The `code` is the one
   machine-readable field a caller branches on, a single `code` cannot report two faults, and both
   faults are permanent for the input as sent.

**Correction to ADR-0845 §3.** That record's "a structurally invalid compound input is that code's
subject, not this one's" left the pair unpinned. This record supplies the compound case. ADR-0845's text
is **not** edited (README line 3 and ADR-0792 §Consequences forbid editing an accepted record), and this
paragraph is the correction of record.

What this record does **not** claim: a lone structural fault still answers `invalid_domain_event` (the
`input validation` case pins it), a lone unregistered key still answers `unknown_event_key` (U1), a lone
forbidden payload still answers `forbidden_payload_field` (U2 ×7), and the doubly-**semantic** input
still answers `unknown_event_key` (U4, ADR-0845).

### 2. One appended case, and what each assertion is for

The colocated unit spec (`--project unit`) gains one `describe`/`it` pair **at its end** (`+21/−0`;
every existing case, helper, fixture, mock and spec literal untouched):

- a separate block, `emitDomainEvent — the structural schema gate precedes the semantic gates`, whose
  comment states that this is a characterization pin (ADR-0846);
- the input is `makeDomainEventInput({ tenantId: "", payload: { email: "leak" } })` — schema-invalid
  **and** a forbidden key at depth 0, so the schema and the payload gate both have a reason to refuse;
- `await expect(emitDomainEvent(input, { db: fake.db, clock: fixedClock(T0) })).rejects.toMatchObject({ code: "invalid_domain_event" })`
  — the answer is pinned through `code`, which is what a caller branches on;
- `expect(fake.calls.some((call) => call.method === "insertOne")).toBe(false)` — guards a
  refuse-then-write regression.

The case reuses the file's own `makeFakeMongo`, `makeDomainEventInput`, `fixedClock` and `T0`; no new
helper, constant or fixture is minted.

**Which assertion carries the verdict: the `code` assertion.** The `insertOne` assertion is **inert for
the ordering question** — every refusal site precedes `getDb()` and the insert, so under any order the
emitter refuses without writing and this assertion answers `false`. Probe B below shows what it does
guard, and probe A shows it never speaking when the order is the thing that changed.

**Characterization, green on arrival.** The behaviour ships, so this is not a RED pin: there is no GREEN
sibling card, the case is declared green on arrival here and in its own comment, and the PR is
non-draft.

### 3. Deliberately not pinned

- **The error message.** The pin asserts `code`, never the `DomainEventError` text; a reworded message
  must not redden the ladder.
- **The lone faults.** U1, U2 ×7 and the `input validation` case own them; this case needs exactly one
  structural fault and one forbidden key to keep both refusals live.
- **A nested forbidden key, a second forbidden key, a malformed `dedupeKey`.** U2 ×7 owns the scan's
  depth and the schema's other fields; adding them would multiply this case's reasons without ordering
  any new pair.
- **The route-level rungs.** ADR-0842 and ADR-0844 own them; this case starts inside
  `emitDomainEvent` and cannot see the route.

## Consequences

- The refusal ladder inside `emitDomainEvent` is fully written down — schema → catalogue → payload, one
  record per pair (this one, ADR-0845) — beside the route pairs ADR-0842 and ADR-0844.
- A refactor that moves the `safeParse` refusal **after** the payload gate now reddens **exactly this
  case**, with `invalid_domain_event` → `forbidden_payload_field` in the diff (probe A).
- The host spec goes `28 → 29` cases at this base, with every pre-existing case green. An append keeps
  the file's decomposition from growing anywhere but the end.
- `docs/adr/README.md` is the shared-ledger hotspot: this record's lane cell (`0846` → `0847`), its one
  index row and its one note merge as a union keeping the highest cells, and no other row is touched.

## Alternatives

1. **Pin `forbidden_payload_field`** (the payload gate ahead of the schema). Rejected, and **measured**:
   probe A shows this case reds with that code once the schema refusal sits behind the payload gate.
   Choosing it would mean keeping the case RED, opening a **draft** PR and creating a GREEN card for a
   reorder the code cannot express without parsing twice, and it would answer inconsistently with the
   three rungs above it, so the ladder would stop being one ladder.
2. **Leave the rung unpinned.** Rejected: a silent flip of the caller-visible `code` is precisely the
   finding class F1 named, and this was the last such pair inside the function.
3. **Accept either code** (`expect([...]).toContain(code)`). Rejected: a pin that accepts both orders
   pins nothing and leaves two live shapes in a caller's branch table.
4. **Append inside the existing gate-precedence block** (ADR-0845's `emitDomainEvent — gate precedence
when both gates refuse`). Rejected: that block's title speaks of "both gates" — the catalogue and
   payload gates — and a schema-vs-payload case inside it would leave the title under-describing its
   block, the exact defect the OP-136 I24/I25 retitle card had to repair. A separate, correctly titled
   block costs one line.

## Evidence

Base `origin/main` `e0032a61`. Host spec, measured at this head:

```
baseline  (28 cases):  Test Files  1 passed (1)   Tests  28 passed (28)
delivered (29 cases):  Test Files  1 passed (1)   Tests  29 passed (29)
```

**Green on arrival — a characterization, not a RED pin.** Two probes, both in a throwaway detached
worktree at `e0032a61` with the delivered spec copied in and `node_modules` symlinked, never in the lane
tree, each reverted byte-identically afterwards.

**Probe A — the discriminating half.** The `safeParse` refusal moved **behind** the payload gate (the
catalogue and payload gates asked of the raw `input`, then the schema, then `const event = parsed.data`):

```
Test Files  1 failed (1)
     Tests  1 failed | 28 passed (29)
 × answers invalid_domain_event when a structurally invalid input also carries a forbidden payload key

- Expected
+ Received
-   "code": "invalid_domain_event",
+   "code": "forbidden_payload_field",
```

This case reds **alone** — U1, the seven U2 rows, U4 and the lone `input validation` case stay green —
and that is the point: the lone case passes the payload gate on its way to the schema, so only the
compound case can see the order.

**Probe B — what the write assertion guards.** A row inserted **before** the schema refusal (a
refuse-then-write regression):

```
Test Files  1 failed (1)
     Tests  2 failed | 27 passed (29)
 × rejects an input that fails the structural schema
 × answers invalid_domain_event when a structurally invalid input also carries a forbidden payload key
AssertionError: expected true to be false
```

Both cases red on the `insertOne` assertion while their `code` assertion passes. So the write assertion
is a real guard — and it is orthogonal to the ordering question: under probe A it never spoke, because
the `code` assertion failed first. That is why this record names `code` as the assertion carrying the
verdict.

`git checkout --` returned `domain-events.ts` to
`sha256 741e9a7ac6e6e512dc15aa2d3e6b9e2507fb7994735c582f79df78b50c272bad` after each probe — the hash
measured before the first mutation — `git status --short` showed only the spec, the re-run answered
`29 passed (29)`, and the probe worktree was removed.

Gates on the delivered commit: `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors;
`prettier --check` clean on the spec, this record and `docs/adr/README.md`; the `adr-*` guard family
green (6 files, 236 tests); the host spec `29 passed (29)` with all 28 pre-existing cases green.
