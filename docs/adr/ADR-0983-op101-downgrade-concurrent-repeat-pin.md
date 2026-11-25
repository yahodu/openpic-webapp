# ADR-0983 — OP-101: the concurrent double-submit is idempotent — `[200, 200]`, one event — so ADR-0980 §Consequences is corrected, not implemented

- **Status:** Accepted · **Date:** 2026-11-24
- **Card:** OP-101 TEST/DOCS `t_9eafff78` (openpic-webapp-testcase-writer) · **Branch:** `OP-101-task-downgrade-concurrent-repeat` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op101-downgrade-concurrent-repeat-pins`
- **Lane:** OP-101 follow-up (request-side billing record) · **Consumes:** `0983` — the reservation the orchestrator card `t_cb891a2c` carried, used as given (not a fresh draw); the four pool-mirror cells advance to `0984`
- **Spec sources:** contract §3.3 (`POST …/billing/downgrade`), §7.7; schema §18.3 (`domainEvents`); [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2 (the `dedupeKey`), §D3 (the repeat reads before it writes)
- **Consumers:** `apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts` (`B5`)
- **Relates to:** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) (§D2/§D3 — the decision the shipped answer implements), [ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) (§Consequences — the sentence this record corrects), [ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) (§D5 — the measurement this record acts on), [ADR-0979](ADR-0979-op101-downgrade-scheduled-event-pins.md) (`B1`, the sequential sibling of `B5`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (§11 item 18, the pool draw), [ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md) (this record's own ledger row)

## Context

[ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2 and §D3 make a
repeated downgrade request **the same intent**: the request answers `200` and announces
nothing the second time. `B1` in
`apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts:644` pins that
for a **sequential** repeat — one `200`, then a second `200`, and one `domain_events` row.

[ADR-0980](ADR-0980-op101-downgrade-scheduled-event-green.md) §Consequences then recorded
what a **concurrent** double-submit does, and it recorded a `500` on the loser, reached
through the unique partial index on `domain_events.dedupeKey`. That prediction was never
measured at the time it was written.

[ADR-0981](ADR-0981-op101-actor-exemption-audience-scope-pins.md) §D5 measured it: eight
independent rounds of `Promise.all([request, request])`, each answering `[200, 200]` with
**one** event. That pack did not pin the result, and said why — the outcome is a function of
how the two transactions interleave, so a pin of it is a decision-shaped question, not a
test-shaped one. It routed the contradiction to the orchestrator instead.

The orchestrator card `t_cb891a2c` decided both halves of that routing. For this one it
decided to **accept `[200, 200]` with one event** and to **correct** ADR-0980 §Consequences
rather than implement its `500`. This card makes that answer executable as one pin (`B5`) and
publishes the correction. No production file changes: the shipped code already answers this
way.

## Decision

**D1 — the answer is `[200, 200]` with exactly one event, and a client may rely on it.**

1. **A concurrent double-submit is the same intent arriving twice, so timing must not decide
   the status.** [ADR-0978](ADR-0978-op101-billing-downgrade-scheduled-event.md) §D2/§D3 make
   a repeat answer `200` and announce nothing, and `B1` pins exactly that for the sequential
   shape. An interleaving-dependent `500` would make the API's answer depend on when the two
   requests happen to overlap, and would give a client a status it cannot tell apart from a
   retryable failure.
2. **The mechanism is the shipped transaction design, not a lucky schedule.**
   `withTransaction` (`apps/web/src/server/db/transaction.ts:63`, retry budget `maxAttempts = 3`
   at `:22`) runs `session.withTransaction` with `{ readConcern: majority, writeConcern:
majority }` (`:89`) and re-runs the callback on any `TransientTransactionError`. A
   `WriteConflict` carries that label. Both requests write the **same** `subscriptions`
   document at the top of the callback
   (`apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts:163-177`), so the
   loser aborts **there** — before the `domain_events` insert — and the retried callback
   re-reads the dedupe key after its own write, with the session and a majority read
   (`route.ts:182`), sees the winner's committed row, and skips the emit. The unique partial
   index on `domain_events.dedupeKey`
   (`apps/web/src/server/db/indexes.ts:586-594`) is therefore never reached by the loser. The
   `DuplicateKey → 500` that ADR-0980 §Consequences records cannot happen on this path.
3. **The pin is deterministic.** The fixture's live row carries `currentPeriodEnd`, so
   `effectiveAt` — and with it the §D2 `dedupeKey` — is fixed by the seed and not by a request
   clock. `B5` therefore compares the surviving row's key with a literal, not with a pattern.
4. **What the pin does not promise.** Retry-budget exhaustion — a pathological interleaving
   past `maxAttempts` — is still a `500`, and that path is already characterised by `C1`. The
   unique index stays as a backstop for an emit that reaches it by another route. `B5` claims
   neither of those; it pins the answer two concurrent identical requests get today.

**D2 — the rejected alternative is "make the `500` deterministic".** That would require
deleting the §D3 pre-read (`route.ts:182-189`) so the emit always runs and the index always
refuses the loser. It was rejected twice over: it regresses the sequential repeat that `B1`
pins at `200`, and it turns the API's answer into a function of the interleaving — the exact
defect D1.1 names. The mutation below measures that regression on this very file.

**D3 — the correction to ADR-0980 is an append, never an edit.** ADR-0980 §Consequences,
§Decision, §Numbering, its header and its ledger row stand as written; a new
`## Correction — 2026-11-24` section quotes the wrong sentence, states the measured answer,
states the mechanism in one sentence, and cites this record. An accepted record is not
rewritten in place (ADR-0302's immutability rule), and the wrong prediction is worth keeping
visible: it is what the measurement corrected.

## Consequences

- The API's answer to two concurrent identical downgrade requests is a pinned fact: `B5`
  reds if it ever becomes a `500`, a second row, or a second delivery.
- **Cost:** one appended case in an existing integration file and no production file. The case
  is green on the shipped tree, so this PR is test-and-docs only and its CI is green: it is a
  **characterisation** pack, like ADR-0981, not a RED-by-design pack.
- **Reversal condition:** if the transaction budget, the write order inside the callback, or
  the in-transaction re-read is deliberately changed so that the loser reaches the index, the
  new answer is a product decision that supersedes this record and renegotiates `B5` in one
  card. Neither the `500` nor any other status is to be "restored" by editing `B5`.
- **Left deliberately unpinned:** the retry-exhaustion `500` (`C1` covers the aborted
  transaction, not a spent budget) and the exact interleaving. A pin of either would freeze a
  schedule rather than an answer.

## Numbering

This record consumes `0983`, the number its card carried, as given — the orchestrator
reserved it when it routed the three OP-101 cards, and `0984`/`0985` went to the two
`no_period_end` cards behind this one. The four-surface sweep at this cut finds no
`ADR-0983` anywhere:

```
$ git rev-parse --short origin/main                                   6ae204af
$ git ls-tree -r --name-only origin/main -- docs/adr | grep -oE 'ADR-09[0-9][0-9]' | sort -u | tail -3
                                                                      0980 0981 0982
$ for d in /root/openpic/openpic-webapp/.worktrees/*/; do ls "$d/docs/adr" 2>/dev/null | grep -oE 'ADR-098[0-9]'; done | sort -u
                                                                      0980 0981 0982 0986   # 0983 held by nobody
$ git rev-list --objects --all -- docs/adr | grep -c 'ADR-0983'       0
$ gh pr list --state open --json number,headRefName,headRefOid
                                                                      #921 -> 0986 ; #896 -> 0973
$ python3 <read-only board probe over the 11 non-done cards>
                                                                      t_e05af75c 0984
                                                                      t_b4d8d70e 0985
                                                                      no card holds 0983
```

`0986` is in flight on PR #921 and `0984`/`0985` are reserved by the sibling cards; `0983` is
the next free number and nothing outside this record's own cells moves. The four pool-mirror
cells that read `0983` at the trunk — `board-wide / process`, `OP-129 attendee identity lane`,
`OP-136 jobs lane`, `unallocated (future lanes)` — advance to **`0984`** (forward only; no
cell is lowered and no range is re-cut). Hotspot: `docs/adr/README.md` (row `0983`, four
cells) — merge as a union keeping the highest value in every cell.

## Evidence

**The pin, on the shipped tree.** Measured on the branch cut `origin/main` `6ae204af`, with
`apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts` the only changed
file (15 cases before, `B5` the sixteenth):

```
$ pnpm exec vitest run --project integration apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts
Tests  16 passed (16)
```

**The concurrent measurement, ten rounds.** `B5` alone in a fresh worker each round, so each
round is an independent pair of overlapping requests (the case's first two assertions are
`first.status === 200` and `second.status === 200`, so a pass _is_ the pair `[200, 200]`, plus
one event and one delivery):

```
run  1: Tests  1 passed | 15 skipped (16)
run  2: Tests  1 passed | 15 skipped (16)
run  3: Tests  1 passed | 15 skipped (16)
run  4: Tests  1 passed | 15 skipped (16)
run  5: Tests  1 passed | 15 skipped (16)
run  6: Tests  1 passed | 15 skipped (16)
run  7: Tests  1 passed | 15 skipped (16)
run  8: Tests  1 passed | 15 skipped (16)
run  9: Tests  1 passed | 15 skipped (16)
run 10: Tests  1 passed | 15 skipped (16)
```

Ten of ten rounds answered `[200, 200]` with one event; none answered `500` and none left a
second row. That is ADR-0981 §D5's `P3` reproduced on the pin's own fixture, quoted verbatim
there as

```
P3 [{"statuses":[200,200],"events":1}, … eight rounds, all {"statuses":[200,200],"events":1}]
```

**Load-bearing, proved by mutation.** With the in-transaction dedupe pre-read deleted — the
`findDomainEventByDedupeKey` call at `route.ts:182` and its `if` at `:189`, so the emit runs
unconditionally inside the same callback — `B5` reds, and `B5` is the only case that does:

```
× B5: answers 200 to two concurrent identical requests and leaves one event and one delivery
AssertionError: expected 500 to be 200 // Object.is equality
- Expected  + Received
- 200
+ 500
 ❯ apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts:728:27
Tests  1 failed | 15 skipped (16)
```

That is precisely the "make the `500` deterministic" shape D2 rejects: the loser reaches the
index and answers `500`. The probe file was restored with `git checkout --` and is
byte-identical to its pre-probe state:

```
$ sha256sum apps/web/src/app/api/v1/tenants/[tenantId]/billing/downgrade/route.ts
4cc75efa53b5707da6a9b471b8a0cf59fb805b6a13be306fc5e203a891353479   (before == after; cmp identical)
$ git status --porcelain
 M apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts
?? docs/adr/ADR-0983-op101-downgrade-concurrent-repeat-pin.md
```

**Static gates and the whole projects.** Measured on the same tree (`origin/main` `6ae204af`
plus this card's one spec and three records): `pnpm typecheck` exit `0` on all three projects
(`tsconfig.json`, `packages/contracts`, `apps/web`); the ten `adr-*` guard files `10 files /
340 passed (340)`; the whole `unit` project `201 files / 3422 passed | 3 skipped (3425)`,
exit `0`; the whole `integration` project `167 files / 1813 passed (1813)`, exit `0` — the
`167 / 1812` the trunk carried plus this card's one case; `eslint` on the spec `No issues
found`; `prettier --check` clean on the spec, this record, ADR-0980 and the ledger.

## The pinned case

`apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts` — case `B5`, in the
existing dedupe `describe` beside `B1`–`B4`. `B1`–`B4`'s assertions, the `C`/`D`/`E` groups and
every fixture helper in that file keep their bytes; the only other edit in the file is the
head-of-file docblock line `B1–B4` → `B1–B5` with one sentence naming the concurrent shape. No
other file cites this record, and no production file is in the diff.

## Correction — 2026-11-25

This section is appended; no earlier byte of this record changes, and **nothing in §Context,
§Decision or §Consequences is withdrawn**. The answer stays `[200, 200]` with one event, `B5`
stays exactly as it shipped, and the mechanism stays the shipped transaction design. The
correction narrows two sentences in §Evidence and restates two clauses of §Decision that the
measurements below do not support. It mints no number, adds no consumer and changes no code.

**Where the probes were run.** On this record's own branch cut, `origin/main` `7ae790f7` — the
trunk after the #922 squash `a92b468a` plus #921/#923; the spec and the two source files are
byte-identical between the two. Each probe changed one production file, ran the **whole spec
file with no filter**, and restored the file with `git checkout --`. `route.ts` returns to
`sha256 4cc75efa…` and `transaction.ts` to `sha256 0e997e2e…`, and `git status --porcelain` is
clean after every probe.

### E1 — the "only case" sentence is a filtered-run artefact

§Evidence says, of the mutation that deletes the in-transaction dedupe pre-read:

> `B5` reds, and `B5` is the only case that does

The count quoted under that sentence, `Tests 1 failed | 15 skipped (16)`, is a `-t "B5:"`-filtered
run: the other fifteen cases were **skipped**, not passing, so the count cannot show that no
other case reds. The same mutation applied to the whole file — `findDomainEventByDedupeKey` at
`route.ts:182` and its guard at `:189` removed, so the emit runs unconditionally in the callback
— measures:

```
× B1: answers 200 on a repeated identical request and leaves one row
× B5: answers 200 to two concurrent identical requests and leaves one event and one delivery
      Tests  2 failed | 14 passed (16)
```

Both cases red — `B1` at `:651:27` and `B5` at `:727:26`, each `expected 500 to be 200` — which
is expected, because both share the `alreadyEmitted` pre-read. The deletion therefore describes
what the pre-read prevents, but it does not show that `B5` adds coverage over `B1`.

### E2 — the discriminating proof is the retry budget

`DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3` at `transaction.ts:22` changed to `1`, everything else
untouched, whole file, no filter:

```
× B5: answers 200 to two concurrent identical requests and leaves one event and one delivery
  TransactionRetryLimitError: transaction retry limit reached after 1 attempts
  http.error  status 500   (route.ts:163 → transaction.ts:73 → :77)
  ❯ apps/web/src/test/integration/billing-downgrade-scheduled-event.test.ts:728:27
      Tests  1 failed | 15 passed (16)
```

`B5` is the only case that reds; `B1`–`B4`, `C1`–`C2` and `D`/`E` stay green. **That, not the
pre-read deletion, is what shows `B5` covers the concurrent path**: the case depends on the
driver re-running the whole callback, and no other case in the file needs a retry to stay green.

The budget probe is an **interleaving-dependent** discriminator, and the record must say so: six
further rounds of the same mutation measured three red (`1 failed | 15 passed (16)`) and three
green (`16 passed (16)`). The loser answers `500` only in the rounds where the two callbacks
actually conflict, and which request loses decides whether the red surfaces on `:727:26`
(`first.status`) or on `:728:27` (`second.status`), which is why the quoted stack above and a
re-run can differ in their first failing line. The shipped budget of `3` is what makes the case
stable: ten of ten rounds in §Evidence and every whole-file run in this correction are green.

### E3 — the mechanism is the whole-callback retry, not the read's position

§D1.2 says the retried callback re-reads the dedupe key "after its own write". Moving the
`findDomainEventByDedupeKey` call to **before** `subscriptions.updateOne` inside the same
callback — a legal-looking refactor that keeps the read inside the transaction — measures
`Tests 16 passed (16)`, twice. The read's position is therefore not what produces the answer;
the driver's retry of the **whole callback** is. The requirement `B5` needs is the weaker one:
the dedupe read happens inside the transaction callback, on the same `{ db, session }`, so a
retried callback reads committed state. The read's position relative to the write is not
measured by `B5`, and no later change should cite §D1.2 as a reason to keep the read after the
write.

### E4 — §D1.4 contradicts §Consequences about `C1`, and the measurement sides with §Consequences

§D1.4 says retry-budget exhaustion "is still a `500`, and that path is already characterised by
`C1`". Under E2's budget of `1`, `C1` stayed green in every round. `C1` pins a **refused
`domain_events` insert** — a non-transient driver error that aborts the transaction — not a
spent budget. §Consequences already states the correct bound ("`C1` covers the aborted
transaction, not a spent budget"), and this section adopts it: the retry-exhaustion `500` stays
deliberately unpinned as a direct case, and `B5` now pins the budget **indirectly**, because a
budget below two attempts reds it whenever the conflict fires (E2). A direct pin of the spent
budget would be a new case on a new card, not a reinterpretation of `C1`.

### What this correction leaves standing

§Context, §Decision and §Consequences stand. The measured answer, the determinism argument
(§D1.3), the rejected "make the `500` deterministic" alternative (§D2), the append-only repair
of ADR-0980 (§D3), the numbering, the header and the ledger row are unchanged. What is narrowed
is §Evidence: the "only case" sentence and the filtered count quoted for it. What is restated
here, without editing the clauses in place, is §D1.2's "after its own write" and §D1.4's `C1`
attribution.
