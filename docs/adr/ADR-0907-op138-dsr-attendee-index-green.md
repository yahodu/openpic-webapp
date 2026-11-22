# ADR-0907 — OP-138 GREEN: declare the `dataSubjectRequests` attendee index in `INDEX_SPECS`

- **Status:** Accepted
- **Date:** 2026-11-22
- **Card:** `t_146bfc4e` (OP-138 GREEN, Low; finding **F-R3** of the review card
  `t_47a8e5e0` on the landed lane PR
  [#786](https://github.com/yahodu/openpic-webapp/pull/786) squash `8f45462b`,
  routed by the decision card `t_8680d063`; the pins of
  [ADR-0906](ADR-0906-op138-dsr-attendee-index-red.md) are the contract)
- **Branch:** `OP-138-task-attendee-dsr-index-green`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op138-dsr-index`
- **Base:** `origin/main` **`dc270105`** (the RED pin's squash `dc270105`,
  `test(db): OP-138 pin the attendee DSR list read to a §20.3 index (#789)`),
  read with `git fetch origin` immediately before the branch was cut.
- **Consumes:** `0907` — reserved for this card by the allocator at creation.

## 1. Context

`GET /api/v1/me/data-requests` serves the anonymous attendee the rows its own
session filed. The route
(`apps/web/src/app/api/v1/me/data-requests/route.ts:355`–`359`) filters

```
{ "subject.kind": "anonymous",
  "subject.attendeeSessionId": <session hex> }
```

and then `.sort({ receivedAt: -1, _id: -1 }).limit(query.limit + 1)`.

`INDEX_SPECS` declared §20.3's three `dataSubjectRequests` indexes
(`{subject.userId:1, receivedAt:-1}`, the `{status:1, slaDueAt:1}` partial on the
open statuses, `{regulation:1, status:1}`), none of which has an attendee
session prefix — so the read was a collection scan whose sort had to see every
scanned row. The behaviour is correct and shipped by PR #786; only the index
coverage was missing (ADR-0906 §1).

`dataSubjectRequests` is **not** in `TENANT_SCOPED_COLLECTIONS`
(`indexes.ts:62`–`72`), so the U1 tenant-prefix lint has no lead to violate
([ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) §4).

## 2. Decision — one appended spec

Declared in `apps/web/src/server/db/indexes.ts`, directly after
`dataSubjectRequests_regulation_status`:

- **collection:** `COLLECTIONS.dataSubjectRequests`
- **name:** `dataSubjectRequests_attendee_received`
- **keys:** `[["subject.attendeeSessionId", 1], ["receivedAt", -1]]`
- **partial:** `partialFilterExpression: { "subject.kind": "anonymous" }`

The three shipped specs are byte-identical: nothing is renamed, re-keyed,
re-partialled or reordered. Schema §20.3
(`docs/Notification and Database Design.md:2053`) gains the fourth clause on
its existing `**Indexes:**` line.

Rationale:

- the equality prefix `subject.attendeeSessionId` is the route's own filter, so
  the planner seeks the session's rows instead of scanning the collection;
- the trailing `receivedAt:-1` is the sort's leading key, so the in-memory sort
  is bounded by the session's own rows instead of the whole scanned collection;
- the partial keeps `subject.kind:"user"` rows — which carry no session key at
  all — out of the index, so it stays the size of the attendee population;
- the route's attendee filter **always** carries
  `"subject.kind": "anonymous"`, so the query implies the partial predicate and
  the index is a legal match.

## 3. Measured evidence

Focused suite on this head, before and after the spec: the assertion is
load-bearing, and nothing else moves.

```
pnpm vitest run --project unit apps/web/src/server/db/indexes.test.ts

spec removed →  Test Files  1 failed (1)
                Tests  1 failed | 18 passed (19)
                AssertionError: missing the §20.3
                {subject.attendeeSessionId:1, receivedAt:-1} index on
                dataSubjectRequests: … expected undefined to be defined
                (indexes.test.ts:349)

spec present →  Test Files  1 passed (1)
                Tests  19 passed (19)
```

The removed-spec run reds exactly the RED case at assertion level and leaves
the three shipped cases green; production was restored byte-identically
(`sha256 4f75ab57…78c` before and after, `git status` showing only the two
production/doc edits). ADR-0906 §4 already measured the partial assertion in
isolation (spec without the partial → `expected undefined to deeply equal
{ 'subject.kind': 'anonymous' }`), so the pass is not an artefact of the
sibling assertions.

### 3.1 `$explain` of the no-cursor page (throwaway probe, not a committed test)

A probe on a throwaway `MongoMemoryReplSet` (`startTestApp` + `ensureIndexes`,
300 anonymous rows across sessions, 100 user-kind rows, one target session)
explained the route's filter with `.sort({receivedAt:-1,_id:-1}).limit(21)`:

```
with the index:    IXSCAN dataSubjectRequests_attendee_received   (isPartial: true)
                   totalKeysExamined 1, totalDocsExamined 1
                   → FETCH → SORT (simple, totalDataSizeSorted 379 B)
without the index: COLLSCAN, totalDocsExamined 401
                   → SORT (simple, over the one filtered row)
```

So the plan picks the new index and stops examining the collection. Honest
limit: a `SORT` stage **remains**, because the sort key carries the `_id:-1`
tie-break that the index does not — the sort now sorts only the session's own
rows (1 row here) instead of one row reached through 401 examined documents.
Adding `_id` to the key was not the settled decision and is not done here.
The probe file was deleted; `git status` shows no test change.

The cursor page adds an `$or` on `receivedAt`
(`route.ts:365`–`372`). Its planner behaviour was **not** separately measured:
the card left that note optional, and the no-cursor arm is the one this index
is shaped for.

## 4. Consequences

- The attendee list read is index-served (see §3.1) rather than a collection
  scan; `ensureIndexes` creates the index on boot
  (`db.indexes.created` lists `dataSubjectRequests_attendee_received`).
- `subject.kind:"user"` filings are not indexed by it, so the user population's
  write cost is unchanged.
- A future change to the sort shape (dropping `_id`, or adding a third key)
  changes what the planner can do; the pin asserts the declared keys and the
  partial, not a plan stage, so a plan regression stays visible only through
  an `$explain` probe like §3.1.

## 5. Alternatives rejected

- **No index (the shipped state).** Collection scan on the anonymous
  compliance read, on a collection with no TTL that grows for the statutory
  retention window.
- **A non-partial `{subject.attendeeSessionId:1, receivedAt:-1}`.** Same keys,
  but it would carry the `subject.kind:"user"` rows that can never match: pure
  size and write cost.
- **Re-keying `dataSubjectRequests_subject_received`.** One index cannot serve
  two equality prefixes; it would trade the user list read (ADR-0901/`0902`)
  for the attendee read.
- **Leading with `subject.kind`.** Spends a key column on a value the partial
  predicate already encodes.
- **Adding `_id` to the key.** Out of the settled decision; see §3.1.
- **Changing the route's sort or pagination.** Route behaviour, shipped and
  correct, and out of this card's scope.

## 6. Number allocation

The OP-138 lane holds `0898`–`0917`; the lane's `Next free` cell
(`docs/adr/README.md:77`) read **`0907`** on this base. This record takes
**`0907`** — the number reserved for the card — and advances the cell to
**`0908`** (`max(trunk value, highest consumed + 1)`), never down. No other
cell and no range is touched.

## 7. Out of scope

- No route, repo, contract or test file changes. The diff is one index spec,
  one schema-document clause, this record and the ledger bookkeeping.
- No new plan test (the Low card forbids one); §3.1 is a one-off probe.
- `dataSubjectRequests` stays platform-scoped.
