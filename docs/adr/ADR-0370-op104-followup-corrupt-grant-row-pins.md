# ADR-0370 — OP-104 follow-up TEST: both arms of the bounded grant read's corruption delta are pinned

- **Status:** Accepted (TEST; both pins are **characterization** — green on arrival at `origin/main` `200eaf97`, no GREEN sibling opened)
- **Date:** 2026-11-19
- **Card:** OP-104 TEST follow-up (`t_8f1dac13`) · **Branch:** `OP-104-task-corrupt-grant-pins` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_8f1dac13`
- **Relates to:** [ADR-0366](ADR-0366-op104-followup-bound-entitlement-grants-read.md) (the bounded grant read these pins characterize), [ADR-0367](ADR-0367-op104-followup-corrupt-counter-row-pins.md) (the counter-row twins and the posture these pins copy), [ADR-0365](ADR-0365-op104-followup-bounded-counters-and-usage-sort-index.md) (the counter bound), [ADR-0361](ADR-0361-op104-entitlements-usage-endpoints-green.md) (the entitlements view), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation)
- **Contract:** §3.5 (entitlements & usage), §0.7 (status codes) · **Schema:** §14.2
- **Consumers:** `apps/web/src/test/integration/entitlements-endpoints.test.ts`

## Context

ADR-0366 (PR #708, squash `200eaf97`) bounded the `entitlementGrants` read in
`readEntitlementsView` (`apps/web/src/server/services/entitlements/view.ts`) to
the predicate `effectiveLimit` and the served `grants[]` already select on:

```ts
.find({ validFrom: { $lte: now }, $or: [{ validUntil: null }, { validUntil: { $gt: now } }] })
```

The record states one behaviour change and **deliberately leaves it unpinned**:
a malformed grant row whose window excludes `now` is no longer fetched, so it is
no longer parsed, so it no longer answers `500`. The parent review
(`t_6fdc277b`) measured both arms A/B in probe worktrees — same seed, a direct
`readEntitlementsView(db, tenantId, now)` call, `now = 2026-09-15T12:00:00.000Z`:

| Arm                                                  | Base `84378fa0` (unbounded `find()`) | Head `5b46aa31` (bounded)                 |
| ---------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| one well-formed grant (`delta: 4`, open window)      | served `effectiveLimit = 104`        | served `effectiveLimit = 104`             |
| malformed `delta: "not-a-number"`, **closed** window | **threw `ZodError`** → route `500`   | **served `effectiveLimit = 104`** → `200` |
| malformed `delta: "not-a-number"`, **open** window   | threw `ZodError` → `500`             | threw `ZodError` → `500`                  |

So the delta is exactly one behaviour: **a corrupt grant row outside the active
window is no longer refused.** The row is never fetched, so it is never parsed.
Nothing about the row's own failure mode changed — the read simply no longer
sees it. Corruption detection **inside** the window is unchanged.

Both arms pass on the shipped trunk, so this is a **pin** card in the sense of
[ADR-0364](ADR-0364-op104-followup-usage-cursor-edges-pins.md) and
[ADR-0367](ADR-0367-op104-followup-corrupt-counter-row-pins.md): the job is to
make the shipped answers regression-visible, not to request a behaviour change.
**No GREEN sibling is opened.** A red on either case means the shipped behaviour
moved.

## Decision

Two cases are appended to the existing
`describe("GET /api/v1/tenants/{tenantId}/entitlements")` block in
`apps/web/src/test/integration/entitlements-endpoints.test.ts`, reusing that
file's helpers unchanged (`seedWorkspace`, `seedPlan`, `seedSubscription`,
`seedGrant`, `seedCounter`, `entitlementsRequest`, `entitlementRowFrom`,
`errorEnvelope`, the frozen `FROZEN_NOW` clock and the `beforeEach` collection
wipe). The file goes from **33** to **35** cases; no pre-existing case, L7 and L8
included, is touched. A doc block at the head of the file declares the
characterization status in the same words as this record.

Both cases use one workspace shape: a `starter` plan whose `storage.bytes` spec
is `tenant`-scoped, `lifetime`, `limit: 100`, `enforcement: hard`; an `active`
`starter` subscription; one **well-formed** grant (`delta: 4`, `validFrom`
`2026-01-01`, `validUntil: null`, so its window covers `now`); and a **corrupt**
grant row (`delta: "not-a-number"`) inserted raw through
`app.db.collection(COLLECTIONS.entitlementGrants).insertOne`, because the file's
`seedGrant` types `delta` as `number`. `entitlementGrants` carries no unique
index over `(tenantId, entitlementKey)` (its only `INDEX_SPECS` entry is the
non-unique `entitlement_grants_tenant_key_valid_from`), so the second row for the
same key is legal — unlike the `usageCounters` case, L7/L8 needed a different
period to dodge a unique index.

### L9 — a malformed grant row in a **closed** window is ignored, and the view still answers `200`

The corrupt row's window is `validFrom 2025-01-01` → `validUntil 2025-02-01`,
closed well before `FROZEN_NOW`, so the bounded read never fetches it. A counter
row at the key's `lifetime` period with `value: 7` makes the served `used` and
`remaining` observable rather than zero.

Assertions: `status === 200`; the body still satisfies the file's
`entitlementsBodySchema` (§3.5 types `grants[].delta` as an integer, so a corrupt
delta that reached `grants[]` would fail the parse rather than ship silently);
and the `storage.bytes` row matches `{ key, limit: 100, effectiveLimit: 104,
used: 7, remaining: 97, periodKey: "lifetime", unlimited: false }`. `grants[]` is
asserted with `toEqual` against exactly `[{ delta: 4, source: "purchase",
validUntil: null }]` — an exact array, so the closed-window row provably adds
neither a delta to `effectiveLimit` nor an entry to `grants[]`.

`effectiveLimit: 104` is `100` (plan) `+ 4` (the one open-window grant), which is
the parent review's measured head value for this seed.

**Load-bearing:** under the pre-ADR-0366 read (`find()`) the same seed throws and
the case fails as `expected 500 to be 200`. That is the mutation recorded in
§Evidence.

### L10 — a malformed grant row in the **served** window is still refused with `500 internal_error`

Same workspace, same corruption, but the window covers `now` (`validFrom
2026-01-01`, `validUntil: null`) — the arm the bounded filter keeps. The
well-formed grant beside it makes the seed otherwise servable, so the `500` is
the corrupt row's parse and not a broken workspace.

Assertions: `status === 500` and `(await errorEnvelope(response)).code ===
"internal_error"` — the dialect the file's L3 and L8 cases already use.

**This case is green on both heads by design.** The unbounded read fetched the
served-window row too, so no delta exists here: the narrowing is only ever
_outside_ the served window. The card forbids mutating the served-window path to
"prove" L10, and this record says plainly that it was not done. L10 is a
**contract** anchor — a red means a malformed served-window grant row can now
reach a served `effectiveLimit` or `grants[]`.

### What is deliberately unchanged

No production file, existing assertion, fixture, mock or helper. `view.ts`, the
`entitlements` route and the grant schema are untouched; the new cases use only
helpers and imports the file already had (`ObjectId` and `COLLECTIONS` were
already imported). No test title embeds a source line number.

## Evidence

Measured in this worktree on `origin/main` `200eaf97`, real command output.

- **Focused integration spec**
  (`CI=true TMPDIR=/root/tmp-mongo npx vitest run --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **35 passed
  (35)** — the 33 carried cases plus L9 and L10, both green on arrival as
  declared. The spec at `HEAD` holds **33** `it(` blocks and the worked tree
  **35**, so no carried case was removed or rewritten.
- **Mutation probe (L9 is load-bearing), in a throwaway worktree** at
  `/root/.hermes/profiles/openpic-webapp-testcase-writer/cache/scratch/probe-t_8f1dac13`
  (a detached `git worktree` at `200eaf97`, never the lane worktree; the lane's
  spec copied in byte-identically). Baseline in the probe: `Test Files 1 passed
(1)` / `Tests 35 passed (35)`. The view's `.find({ validFrom: { $lte: now },
$or: […] })` was then replaced with `.find()` — restoring the unbounded read —
  through a scratch `python3 <script>` (the sandbox blocks `python3 -c`). Run:

  ```
  × L9 characterization: a malformed grant row in a closed window is ignored, and the view still answers 200
  FAIL  |integration| … > GET /api/v1/tenants/{tenantId}/entitlements > L9 characterization: …
  AssertionError: expected 500 to be 200 // Object.is equality
  Test Files  1 failed (1)
        Tests  1 failed | 34 passed (35)
  ```

  **L10 is among the 34 passed under that same mutation** — confirmed
  additionally by `-t "L10"` on the mutated tree: `Tests 1 passed | 34 skipped
(35)`. No served-window mutation was made, as the card requires.

- **Restore.** `git checkout -- apps/web/src/server/services/entitlements/view.ts`
  in the probe returned `view.ts` to sha256
  `92e83ccd585f6aae0c2096fd2e2ce618f46b7b90ab998965e64eff580ea867cb` (the lane's
  value, and the probe's pre-mutation value), `git status --short` showed only the
  spec, and the same command answered `Tests 35 passed (35)`.
- **`pnpm typecheck`** exit 0 on all three projects; **`eslint`** 0 errors on the
  touched spec; **`prettier --check`** clean on the spec and both docs.
- **ADR guards** (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-consumers`, `adr-source-references`, `adr-inline-code-spans`) green with
  this record and its ledger row in place.
- **Full unit + integration with coverage** (`CI=true TMPDIR=/root/tmp-mongo pnpm
test:coverage`) **exit 0** at **332 files / 4685 passed (3 skipped)**, global
  **91.82 % statements / 80.76 % branches / 96.06 % functions / 91.94 % lines** —
  the same global figures as the parent card's head, so the two new cases add
  coverage without moving any gate. The suite's own `http.error` log for L10
  names the refusal: `ZodError … "path": ["delta"], "message": "Invalid input:
expected number, received string"` at `view.ts:265`, i.e. the `500` is
  `storedGrantSchema.parse` and not a broken workspace.

## Out of scope

- **No GREEN sibling.** Both cases pass on arrival; nothing is routed to an
  implementer. The card body says so explicitly, and it also says to stop and
  report if either pin failed — neither did.
- **The corrupt closed-window row is not deleted, repaired or logged.** Whether
  such a row should be quarantined or reported is a data-repair question for the
  reconciliation path, not for this read's contract. L9 records only what the
  endpoint answers today.
- **No assertion on the number of documents fetched.** The bound is a
  performance property; its measurement belongs to the sibling index card
  (`t_a3fcf2e2`, the `validUntil`-bearing index) and to an `explain` probe, not
  to a status/body pin that would break on a legitimate index change.
- **No mutation of the served-window path to "prove" L10**, as the card
  requires: L10 encodes a contract that already held before ADR-0366, so there
  is no delta to demonstrate.
- **`grants[]` ordering stays unpinned.** ADR-0366's handoff records that the
  served order is plan-dependent (natural vs index order). L9 has a single
  well-formed grant, so its `toEqual` is order-free by construction and no new
  ordering claim is introduced.

## Consequences

- A regression that widens the grant fetch back to `find()` — or to any set that
  includes closed windows — now fails as `expected 500 to be 200` on L9, instead
  of turning a corrupt expired grant into an outage nobody asserted.
- A regression that loosens or drops `storedGrantSchema.parse` on the fetched
  rows now fails on L10 instead of serving a non-numeric `delta` into
  `effectiveLimit` or `grants[]`.
- The pair also pins the _reason_ the bound is safe: the narrowing is only ever
  outside the served window, so the corrupt-row tolerance is bounded, not
  blanket. A future card that wants to quarantine rather than ignore such a row
  must change L9 deliberately.
- ADR-0366's disclosure is now executable instead of prose: L9 is the sentence
  "a malformed grant row the window excludes is no longer parsed", and L10 is
  the sentence "corruption detection inside the window is unchanged".

## ADR number allocation

The OP-104 lane holds `0360`–`0379`. The lane's `Next free` cell read `0368` on
`origin/main` `200eaf97` immediately before committing, and the mandatory sweep —
`.worktrees/*/docs/adr/`, `git rev-list --objects --all -- docs/adr`, and every
open PR head (`#711`, `#690`, `#688`, `#685`, `#272`) — found the next two
numbers in flight:

- **`0368`** is taken by `docs/adr/ADR-0368-op104-followup-counter-parse-pin.md`,
  which the sibling card `t_d614b82a` carries in its own worktree with the lane
  cell at `0369`; that branch is open as PR `#711`.
- **`0369`** is reserved by the sibling index card `t_a3fcf2e2`, whose worktree
  has not written its record yet.

This record therefore takes **`0370`**, the number the card reserved, and the
lane cell advances from `0368` to **`0371`** so the `0369` reservation stays
claimable and the `0368` claim is never lowered. `0360`–`0367` are consumed and
are never renumbered. No number outside the lane range `0360`–`0379` is touched.

## Review and landing — PR #712 (squash 432366b0)

Reviewed head `0ad66564` on card `t_8f1dac13`; this sign-off is card
`t_760c4100`, which consumes **no ADR number**, adds no index row and changes no
cell. **Verdict: APPROVED WITH FINDINGS (one Low, one Info)** — no Critical, High
or Medium finding. PR [#712](https://github.com/yahodu/openpic-webapp/pull/712)
squash-merged as `432366b0` (`mergedAt 2026-11-19T07:16:02Z`) onto `origin/main`
`b120866c`, with `headRefOid 0ad66564`; the PR is `MERGED` and the repository
deleted the lane branch.

Nothing above is retracted. §Context, §Decision, §Evidence, §Out of scope and
§Consequences stand as written; the sign-off only adds what was measured after
the record landed. One figure in §Evidence was taken on an older tree and is
corrected below — it changes no decision and no L9/L10 claim.

### Landing proof

- **Squash.** `git log -1 --format='%H %P' 432366b0` prints exactly one parent,
  `b120866c` (the trunk at merge time), and `git rev-parse 432366b0^{tree}`
  answers `483a791f…`, equal to `git rev-parse b120866c^{tree}`: the squash
  produces the bytes the trunk then carried.
- **Whole-tree identity against the reviewed head does not hold, and the delta
  is the trunk's own.** `git diff --name-status 0ad66564 432366b0` lists one
  path, `docs/adr/ADR-0366-op104-followup-bound-entitlement-grants-read.md`
  (`+150 −0`) — the PR #713 sign-off commit `b120866c` that `main` landed before
  the merge and that the reviewed branch never carried.
- **Per-file identity holds for every reviewed path.** One blob per path at both
  revisions from `git rev-parse <rev>:<path>`: the spec `5a078e31…`, this record
  `cfe662da…`, `docs/adr/README.md` `4ae8a839…`. The runs below therefore
  describe the shipped bytes verbatim.
- **`origin/main` today** carries `432366b0` as an ancestor; it has advanced
  through `8d8f2c13` (PR #715), `461d83d4` (PR #716), `4cb72527` (PR #714) and
  the `1.66.6` release chore `62b855f5` since.

### Reviewer-run evidence

Measured for this sign-off on a probe worktree at `432366b0` (never the lane
tree), real command output:

- **Focused integration**
  (`CI=true TMPDIR=/root/tmp-mongo … --project integration
apps/web/src/test/integration/entitlements-endpoints.test.ts`): **35 passed
  (35)**, and the spec holds **35** `it(` blocks there.
- **Load-bearing, `.find()` mutation.** Replacing the view's bounded predicate
  with `.find()` in the probe answers `Test Files 1 failed (1)` /
  `Tests 1 failed | 34 passed (35)`, the failing case being L9 with
  `AssertionError: expected 500 to be 200`; L10 is among the 34 passed, and
  `-t "L10"` on the same mutated tree answers `1 passed | 34 skipped (35)`. No
  served-window mutation was made, as the card requires. The restore returns
  `view.ts` to sha256 `92e83ccd…867cb` and leaves `git status --short` empty.
- **ADR guards** (the six `apps/web/src/test/unit/adr-*.test.ts` files):
  **236 passed (236)**.
- **`eslint`** exit 0 on the touched spec and **`prettier --check`** clean on the
  spec, this record and the ledger, as the review reported at the head.
- **Full unit + integration with coverage** (`pnpm test:coverage`): **exit 0 at
  333 files / 4688 passed (3 skipped)**, this sign-off's own run.

### Correction — §Evidence's full-suite count was taken on the pre-#711 tree

§Evidence quotes **332 files / 4685 passed (3 skipped)** with global
**91.82 % / 80.76 % / 96.06 % / 91.94 %**. That run is truthful, but it measured
the tree **before** PR #711 (`9b604e44`) reached the branch mid-run.

The same command at the merged tree `432366b0` answers **333 files / 4688 passed
(3 skipped)** — the count this record should carry — with the coverage summary
this sign-off measured as **91.86 % statements / 80.83 % branches / 96.06 %
functions / 91.98 % lines**. The two runs' decimals are close but not
bit-identical, and the PR #716 review measured a third set
(`91.8 / 80.69 / 96.01 / 91.91`) on the same command, so this section records its
own run rather than restating any as current; every one of them clears the
configured gates by a wide margin.

The count delta is exactly PR #711's
`apps/web/src/test/unit/entitlements-counter-parse.test.ts` — one file holding
three `it(` cases, added by squash `9b604e44`, which is an ancestor of the
reviewed head `0ad66564` and **not** an ancestor of `200eaf97`, the base
§Evidence names.

Nothing in §Decision, §Consequences or the L9/L10 claims changes: only the
full-suite count was taken on an older tree.

### The two arms of the bound that L9 does not pin (F1, Low)

§Context and §Decision describe the bound as a whole. The review measured that
L9 pins only **one** of its two clauses, so this record must not be read as
covering both. The read is

```ts
.find({ validFrom: { $lte: now }, $or: [{ validUntil: null }, { validUntil: { $gt: now } }] })
```

L9's corrupt row (`validFrom 2025-01-01` → `validUntil 2025-02-01`) is excluded by
the `$or` clause alone. Mutating one clause at a time in a probe worktree at
`0ad66564` and running the delivered spec file:

| mutation                                    | delivered 35 cases | corrupt-row arm it would have caught    |
| ------------------------------------------- | ------------------ | --------------------------------------- |
| drop the validFrom conjunct, keep the `$or` | all 35 green       | future validFrom, validUntil null → 500 |
| relax the strict validUntil bound to `$gte` | all 35 green       | validUntil equal to now → 500           |

Both candidate arms are green on the trunk, so this is a characterization gap,
not a behaviour request. It is routed to TEST card `t_6d79f7d6` ("OP-104 TEST
(Low) — pin the bounded grant read's two unpinned clauses"), PR #716 — cited here
by card id and PR number, as the commissioning card requires, and deliberately
not by an ADR number.

### Post-review status

The routed TEST card has **landed**: PR #716 squash-merged as `461d83d4`
(`mergedAt 2026-11-19T08:11:56Z`). The spec at that trunk holds **37** `it(`
blocks — L9, L10 and the two new arms, **L11** (a corrupt row whose window has
not started is ignored; `limit 100`, `effectiveLimit 104`, `used 7`,
`remaining 97`) and **L12** (a corrupt row whose `validUntil` equals
`FROZEN_NOW` is ignored) — and the file answers **37 passed (37)** on today's
trunk. Each new arm was proved separately load-bearing on that card: dropping
the `validFrom` conjunct reddens L11 only, and relaxing `$gt` to `$gte` reddens
L12 only, each as `expected 500 to be 200`. The two arms this section reports as
unpinned are therefore pinned on `main` as of `461d83d4`; nothing in this record
needed to change for that.
