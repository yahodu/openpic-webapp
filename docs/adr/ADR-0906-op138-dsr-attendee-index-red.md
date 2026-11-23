# ADR-0906 — OP-138 TEST: pin the attendee branch of `GET /me/data-requests` to a §20.3 index

- **Status:** Accepted (RED by design; the gated GREEN `t_146bfc4e` declares the
  index and lands it on this branch)
- **Date:** 2026-11-22
- **Card:** `t_6bbae8a1` (OP-138 TEST, Low; finding **F-R3** of the review card
  `t_47a8e5e0` on the landed lane PR
  [#786](https://github.com/yahodu/openpic-webapp/pull/786) squash `8f45462b` /
  [ADR-0905](ADR-0905-op138-dsr-attendee-receipt.md), routed by the decision
  card `t_8680d063`)
- **Branch:** `OP-138-task-attendee-dsr-index-red`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/op138-dsr-index` (the
  follow-up pair's own checkout; the GREEN `t_146bfc4e` inherits it)
- **Base:** `origin/main` **`354e4c41`** (`chore(release): 1.72.0 [skip ci]`,
  the release chore above the OP-138 squash `8f45462b` the card names), read
  with `git fetch origin` immediately before the worktree was cut. The base spec
  ran **`18 passed (18)`** there.
- **Consumes:** `0906` — reserved for this card by the allocator at creation.

## 1. Context — the gap F-R3 names

The anonymous-attendee branch of `GET /api/v1/me/data-requests`
(`apps/web/src/app/api/v1/me/data-requests/route.ts:355`–`379`) reads:

```
filter = { "subject.kind": "anonymous",
           "subject.attendeeSessionId": session._id.toHexString() }
…
.find(filter).sort({ receivedAt: -1, _id: -1 }).limit(query.limit + 1)
```

`INDEX_SPECS` (`apps/web/src/server/db/indexes.ts:604`–`636`) declares exactly
three `dataSubjectRequests` indexes, and schema §20.3
(`docs/Notification and Database Design.md:2053`) lists the same three:

| index                                   | keys                                |
| --------------------------------------- | ----------------------------------- |
| `dataSubjectRequests_subject_received`  | `{subject.userId:1, receivedAt:-1}` |
| `dataSubjectRequests_status_sla_open`   | `{status:1, slaDueAt:1}` (partial)  |
| `dataSubjectRequests_regulation_status` | `{regulation:1, status:1}`          |

None of them has `subject.attendeeSessionId` as a prefix, and none supplies the
`receivedAt:-1` order for an attendee-scoped filter. The read is therefore a
collection scan plus a blocking in-memory sort — the same class of gap the
user branch was given an index for in
[ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §6 / `0902`.

`dataSubjectRequests` is **not** in `TENANT_SCOPED_COLLECTIONS`
(`indexes.ts:62`–`72`): the collection is platform-scoped, so the U1
tenant-prefix lint has no `tenantId` lead to govern here
([ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md) §4).

The behaviour shipped by PR #786 is correct; only its index coverage is missing.
This card adds no production code — it adds the pin and this record.

## 2. Decision — the exact index (settled by the orchestrator)

- **collection:** `COLLECTIONS.dataSubjectRequests`
- **name:** `dataSubjectRequests_attendee_received`
- **keys:** `[["subject.attendeeSessionId", 1], ["receivedAt", -1]]`
- **partial:** `partialFilterExpression: { "subject.kind": "anonymous" }`

Rationale:

- the equality prefix `subject.attendeeSessionId` feeds the route's filter, so
  the planner seeks to the session's rows instead of scanning the collection;
- the trailing `receivedAt:-1` supplies the route's `sort({receivedAt:-1,_id:-1})`,
  so the sort stops being a blocking in-memory stage (`_id` is the tie-break
  after an equal `receivedAt`, and the index order still satisfies the prefix of
  the sort key);
- the partial keeps `subject.kind:"user"` rows — which carry no
  `subject.attendeeSessionId` at all — out of the index entirely, so it stays
  the size of the attendee population;
- the route's attendee filter **always** carries
  `"subject.kind": "anonymous"`, so the partial filter is a legal equality
  match: MongoDB may use a partial index only when the query implies its
  predicate, and this query does, unconditionally.

The three shipped indexes are **never** renamed, re-keyed or re-partialled. A
rename of the new declaration keeps the pin green; a drop, a re-key, a
de-partialling or a move to another collection turns it red.

## 3. The pin — one appended case in the registry's own spec

`apps/web/src/server/db/indexes.test.ts`, last `describe` (`index spec pins —
OP-138 §20.3 data subject requests (ADR-0901)`), one appended `it` (`+24/−0`;
the three shipped cases, both local helpers `requestSpecs()`/`specLeading()` and
every import byte-identical, so the file runs **19** cases):

> backs the anonymous attendee list with
> `{"subject.attendeeSessionId":1, receivedAt:-1}`

It finds the spec with `specLeading("subject.attendeeSessionId")` — by
**keys/options, never by `name`**, exactly as its siblings do — and asserts:

1. the spec is defined, with a message that names §20.3 and the read it backs
   (the attendee branch of `GET /me/data-requests`, filtered on
   `subject.kind` + `subject.attendeeSessionId` and sorted
   `{receivedAt:-1, _id:-1}`, a collection scan with a blocking sort without
   it);
2. `spec?.collection` is `COLLECTIONS.dataSubjectRequests`;
3. `spec?.keys` equals `[["subject.attendeeSessionId", 1], ["receivedAt", -1]]`;
4. `spec?.partialFilterExpression` equals `{ "subject.kind": "anonymous" }`.

The four assertions are the describe's stated contract: a rename stays green, a
drop, a re-key, an un-partial or a move goes red.

## 4. Measured evidence

Focused command on this head with the case appended:

```
pnpm vitest run --project unit apps/web/src/server/db/indexes.test.ts
→ Test Files  1 failed (1)
  Tests  1 failed | 18 passed (19)
```

The single red is the new case, at assertion level, with its own message and no
harness or import error:

```
AssertionError: missing the §20.3 {subject.attendeeSessionId:1, receivedAt:-1}
index on dataSubjectRequests: the attendee branch of GET /me/data-requests
filters on subject.kind + subject.attendeeSessionId and sorts
{receivedAt:-1, _id:-1}, so the read is a collection scan with a blocking sort
without it: expected undefined to be defined
```

`specLeading` finds no `dataSubjectRequests` spec whose first key is
`subject.attendeeSessionId`, which is precisely the gap.

**Load-bearing, not vacuous** — measured, not reasoned. With the decided spec
inserted into `indexes.ts` in a throwaway probe:

```
pnpm vitest run --project unit apps/web/src/server/db/indexes.test.ts -t attendee
→ Tests  1 passed | 18 skipped (19)
```

and with the same spec inserted **without** the partial filter:

```
→ Tests  1 failed | 18 skipped (19)
  AssertionError: the {subject.attendeeSessionId:1, receivedAt:-1} index must be
  partial on subject.kind:"anonymous": expected undefined to deeply equal
  { 'subject.kind': 'anonymous' }
```

So assertion 4 discriminates on its own, and the pass is not an artefact of the
sibling assertions. Production was restored byte-identically after both probes
(`sha256 e269e8064a603c6d97ba409fbf042483c01f7b9fbbf8aafec00ce99d5987e2e8`
before and after) and `git status --short` showed only the spec.

Checks on this head: `tsc` **0** on `apps/web` and `packages/contracts`,
`eslint` **0** on the spec, `prettier --check` clean, full `pnpm test:unit`
green apart from this single intentional red, the seven `adr-*` guards green.

### 4.1 CI on this head, and why the pin lands ahead of the GREEN

The PR is **RED by design**, so three gating jobs report the intentional red and
nothing else: `unit_test` (`Test Files 1 failed | 190 passed (191)`,
`Tests 1 failed | 3209 passed | 3 skipped (3213)`), `ci` (`Unit tests` step,
`1 failed | 3209 passed`) and `test_coverage` (`Test Files 1 failed | 343 passed
(344)`), each failing on this case's `AssertionError` at
`indexes.test.ts:349`. Every other gating job — `lint`, `audit`, `audit-dev`,
`secret-scan`, `env-changes`, `validate-branch-name`, `validate-pr-title`, the
CI-Evidence guard — is `SUCCESS`.

The card's landing mandate is explicit: the pin lands first and the GREEN
`t_146bfc4e` is chained behind it, so the §9.1 merge is an admin squash with
that G2 exception recorded in the PR (the one non-success entry is the pin this
record exists for, not an unexplained failure). A future reader who finds a red
`unit_test` on this PR's head should read it as the RED half of the lane, not as
a regression: `git show <this squash> -- apps/web/src/server/db/indexes.ts` is
empty.

## 5. Alternatives rejected

- **No index (the shipped state).** A collection scan plus a blocking sort on
  the hottest anonymous read of a compliance endpoint, on a collection that has
  no TTL and grows for the statutory retention window.
- **A non-partial `{subject.attendeeSessionId:1, receivedAt:-1}`.** The keys are
  the same, but the index would also carry the `subject.kind:"user"` rows, which
  never have a session key and can never match: pure size and write cost on the
  user population's filings, which dominate the collection.
- **Re-keying `dataSubjectRequests_subject_received`.** One index cannot serve
  two different equality prefixes; re-keying it would trade the user list read
  (already fixed by ADR-0901/`0902`) for the attendee read.
- **Leading with `subject.kind`.** `{"subject.kind":1, "subject.attendeeSessionId":1,
receivedAt:-1}` spends a key column on a value the partial predicate already
  encodes, and would need a second partial-free variant to serve the user
  filter.
- **Changing the route's sort or pagination instead.** The cursor page adds an
  `$or` on `receivedAt` (`route.ts:365`–`372`); that is route behaviour, already
  shipped and correct, and out of this card's scope.
- **A TTL or a retention change.** Unrelated: the row must outlive every
  credential (ADR-0905 §1).

## 6. Number allocation

The OP-138 lane holds `0898`–`0917` and its `Next free` cell read **`0906`** on
this base. This record takes **`0906`** — the number reserved for the card — and
advances the cell to **`0907`**, the higher of the trunk cell and
`max(consumed) + 1`. No cell is lowered and no range is re-cut.

The re-sweep the allocator ran before reserving `0906`, restated for the record:
live worktrees' `docs/adr/` hold `0900`–`0905` (with `0904` an _untracked_ hold
in `t_48e4b3a2` for a blocked card) and `0918` (OP-139, out of block);
`git rev-list --objects --all -- docs/adr` resolves `0900`, `0901`, `0902`,
`0903`, `0905`, `0918` and `0938`; the open PR heads (`#783` `d48199f3` stops at
`0902`, `#780` `4662ca93` carries `0918` only, `#755` `c90ea3ba`, `#743`, `#272`)
carry no in-block number; and no non-`done` card reserves an in-block number.
Highest in-block in-flight was `0905` → `0906` is free.

The GREEN `t_146bfc4e` consumes **`0907`** and will advance the cell to `0908`.

## 7. Out of scope and residuals

- This card declares **no** index, edits no route, no schema document and no
  contract: the diff is the one appended case, this record and the ledger
  bookkeeping.
- The cursor-page planner behaviour (the `$or` arm) is not separately measured
  here; the GREEN's ADR owns that note.
- `dataSubjectRequests` stays out of `TENANT_SCOPED_COLLECTIONS` — it is
  platform-scoped, and nothing in this change makes it tenant-scoped.
