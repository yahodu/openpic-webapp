# Engineering Conventions — OpenPic Webapp

Authoritative engineering standard for this repository. Every story, every PR and
every autonomous agent is held to it. `AGENTS.md` is the agent entry point; this
file is the detail it links to.

If a convention creates friction, raise it via an ADR (`docs/adr/`) — never bypass
it silently. When two documents disagree, apply §10.

---

## 1. TDD iron law

- **Never write production code without a failing test.** Work in vertical tracer
  bullets: one failing test → minimal code to green → refactor.
- Order of operations: write the test (**RED**), confirm it fails for the right
  reason, write the minimum code (**GREEN**), run the single test, then the full
  suite, then **REFACTOR** while staying green.
- Run the single test first (fast feedback), then the entire suite before commit.
- **Paste the RED and GREEN command output in the PR description.** A PR without
  both is not reviewable.
- Tests are owned by the Test Author. Implementers and agents never edit, skip,
  weaken or delete a test to make the suite pass. A green suite built on a
  rewritten test is a failed delivery — raise a dispute instead.

## 2. Test pyramid

| Layer                  | Tool                                               | Use for                                                                           |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Unit                   | Vitest                                             | Pure logic, validators, mappers, formatters                                       |
| Integration / contract | Vitest + `mongodb-memory-server` **ReplSet** + MSW | Route handlers, DB access (transactions need a replica set), third-party adapters |
| E2E (API)              | Playwright                                         | Journeys spanning several routes only                                             |

- MongoDB integration tests MUST run against `mongodb-memory-server` started as a
  **replica set** so multi-document transactions work exactly as in production.
- ALL outbound HTTP in tests goes through MSW `setupServer` with
  `onUnhandledRequest: 'error'`. An unhandled request is a bug, not a warning.
- Playwright is reserved for multi-route API journeys; do not use it as a unit
  test runner.

## 3. Zod contracts and fixtures

- Every request **body, query and params** and every **response** has a Zod
  schema in `packages/contracts`. Routes parse before they handle.
- Every third-party request/response has a Zod schema in
  `src/server/adapters/<vendor>/schemas.ts`. Upstream payloads are parsed at the
  boundary and treated as untrusted.
- Fixtures are built **only** through `buildX(overrides)` factories that call
  `schema.parse(...)` on their own output, so a fixture can never drift from its
  schema. Never hand-write a fixture object literal.
- MSW handlers return those factory-built fixtures — never ad-hoc JSON.

## 4. TSDoc

- TSDoc on every exported function, class, type and route handler.
- Include: purpose, `@param`, `@returns`, `@throws` with the error code, and
  `@example` for utilities.
- Route handlers cite the contract section, e.g. `@see API contract §4.1`.
- Comment the **WHY**, not the WHAT. If the code needs a WHAT comment, rename it.

## 5. Logging

Log through the `Logger` port only (US-003). Never call `console.*` directly in
application code and never import a vendor logging SDK outside its adapter.

### 5.1 Level policy

| Level   | Use when                                                                                    |
| ------- | ------------------------------------------------------------------------------------------- |
| `fatal` | The process cannot continue                                                                 |
| `error` | 5xx, unhandled errors, upstream contract break, invariant violation                         |
| `warn`  | Security-relevant denials (bad signature, CSRF, rate limit, lease lost), degraded fallbacks |
| `info`  | One access line per request, state transitions, cron summaries, domain events emitted       |
| `debug` | Internals useful while developing                                                           |
| `trace` | Verbose internals; **off in production**                                                    |

### 5.2 Field dictionary

| Field        | Required | Type   | Meaning                                              |
| ------------ | -------- | ------ | ---------------------------------------------------- |
| `event`      | yes      | string | Dotted event name, e.g. `billing.webhook.projected`  |
| `requestId`  | yes      | string | Correlation id for the originating request           |
| `tenantId`   | no       | string | Tenant scope, when the event is tenant-bound         |
| `userId`     | no       | string | Acting user, when authenticated                      |
| `durationMs` | no       | number | Elapsed time for the operation being logged          |
| `err`        | no       | Error  | Serialised error (message, code, stack for `error`+) |

`event` and `requestId` are mandatory on every log line. Anything tenant- or
user-scoped that lacks `tenantId`/`userId` when they are known is a defect.

### 5.3 Redaction list (US-003)

These values MUST never appear in a log field, message or error serialisation:

- passwords, password hashes and reset tokens
- API keys, access/refresh tokens, session ids, CSRF tokens and cookies
- `Authorization`, `Cookie` and `Set-Cookie` header values (log the header _name_
  and a redacted placeholder only)
- webhook signing secrets and signatures
- private keys, certificates and connection strings
- full payment card numbers (PAN), CVV and bank account numbers
- national/government identifiers and health data

Where correlation is needed, log a stable hash or the last four digits only.

## 6. twelve-factor

- **Config** from environment only (US-002). No config files, no hard-coded
  tunables — runtime knobs are read from `platformSettings`.
- **Processes** are stateless: no in-memory session or job state that cannot be
  rebuilt. Scale-out must not change behaviour.
- **Logs** are an event stream to stdout by default; the aggregator is the only
  consumer that matters.
- **Backing services** (DB, cache, queue, email, storage) sit behind ports and
  adapters selected by env — swapping provider must not touch domain code.
- **Admin processes** (seed, index creation, backfills) are one-off scripts, not
  route handlers or boot-time side effects.
- **Dev/prod parity:** the same adapters run in every environment; tests
  substitute doubles (MSW, in-memory Mongo) rather than branching on `NODE_ENV`.

## 7. Code

- TypeScript strict. **No `any`** — model the type or narrow it.
- No mutation: use spread / immutable updates.
- KISS, DRY, YAGNI. Build only what a test demands.
- Verb–noun function names (`projectInvoice`, not `invoiceProjection`).
- Use `Promise.all` for independent I/O.
- No vendor names in domain fields or domain vocabulary.

## 8. Security

- Honour the **never-return rules** (contract §0.15) — see §8.1.
- Every tenant-scoped query filter includes `tenantId`. A filter without it is a
  review blocker.
- Secrets are never logged (§5.3).
- Compare secrets with constant-time comparison helpers, never `==`/`===`.
- Least privilege: request the narrowest scope/role the operation needs.

### 8.1 Never-return list (contract §0.15)

These fields MUST never be serialised into an API response (or any
client-visible projection):

- `passwordHash`, password reset/verification tokens
- API keys, provider tokens, signing/encryption secrets
- `refreshToken` and other credential material
- internal audit notes, moderation reasons and reviewer identities
- another tenant's records or ids, including in error bodies
- raw upstream provider payloads and provider-side ids not needed by the caller
- stack traces, internal file paths and SQL/Mongo query text

Project responses through the `packages/contracts` response schema so
never-return fields cannot leak: an unknown field is a schema violation.

## 9. Definition of Done

A story is complete only when **all** of the following hold:

- [ ] Tests were written first and are green (RED + GREEN output in the PR).
- [ ] Coverage is at or above the configured threshold.
- [ ] Typecheck, lint and dependency audit are clean.
- [ ] TSDoc is present on every exported symbol and route handler.
- [ ] Structured logs were added for the new behaviour (§5).
- [ ] Zod schemas and `buildX` fixtures exist and parse (§3).
- [ ] The relevant API contract section is referenced.
- [ ] No hard-coded tunables — runtime knobs are read from `platformSettings`.
- [ ] An ADR was added in `docs/adr/` for any new decision.
- [ ] The ADR number is the `Consumes` value reserved in the card body — never derived from `docs/adr/README.md` — and no same-lane ADR-minting sibling card is in flight.
- [ ] The ADR record carries its own `docs/adr/README.md` ledger row **in the same PR** — a record with no row or a row with no record is a DoD failure (**ADR-0319**).
- [ ] The merge gate printed PASS on the exact head SHA and its output is in the PR (§9.1).
- [ ] The merged PR's head is archived to `refs/prhead/<n>` and its local branch
      released in the merge step, with the assertions printed (§9.2, **ADR-0967**).

This list is mirrored, copy-pasteably, in `.github/pull_request_template.md`.

### 9.1 The merge gate (ADR-0318)

The ruleset requires no status check, and the identity that merges is an `always`
bypass actor on it, so the merge is decided by the agent that runs it. Before
`gh pr merge`, evaluate these seven conditions against the PR's **current head SHA**
and paste the output into the PR:

- **G1** `mergeable == "MERGEABLE"` and `mergeStateStatus` ∉ {`DIRTY`, `UNKNOWN`};
  re-poll up to 5 × 3 s when `UNKNOWN`.
- **G2** every entry in `statusCheckRollup` for the head is `status: COMPLETED`
  with `conclusion: SUCCESS` — no `FAILURE`, no `PENDING`, no `CANCELLED`, no
  `SKIPPED` on a gating name.
- **G3** the gating name set is present on the head: `ci`, `audit`, `audit-dev`,
  `secret-scan`, `lint`, `unit_test`, `test_coverage`, `env-changes`,
  `validate-branch-name`, `validate-pr-title`,
  `Assert CI evidence for the pushed head`.
- **G4 (audit freshness)** No commit on `origin/main` in
  `<merge-base>..origin/main` may touch the audit input surface —
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package.json`,
  `.github/workflows/ci.yml` — with a commit date later than the head's `audit`
  check `completedAt`. If one did, the green predates a change in what `audit`
  means: **STALE**.
- **G5** `git diff --quiet <merge-base> origin/main -- pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml` — if false, the merge would change the audited tree, so the head's evidence cannot cover the merge result.
- **G6** on any failure: **do not merge**, do not rebase, do not `gh run rerun`,
  do not `--admin`. Comment the failing condition on the PR and route —
  reconcile through the lane owner (merge `origin/main` in, push to re-trigger
  CI and get a fresh merge ref) or close as superseded.
- **G7 (ADR-carrying PRs only, ADR-0300 §11 item 28)** the ADR number the PR
  **adds** appears at **no other open PR head** — re-swept at the merge instant,
  because §12 item 23's allocation sweep is a snapshot. Command in the block
  below. A hit is a **failure** under G6: do not merge; the lander renumbers its
  own unmerged record, re-runs item 12's merged-tree check on the new head, then
  G1–G7 again on the fresh head.

```
N=<pr>; SHA=$(gh pr view "$N" --json headRefOid -q .headRefOid)
gh pr view "$N" --json mergeable,mergeStateStatus
gh pr view "$N" --json statusCheckRollup \
  -q '.statusCheckRollup[] | "\(.name)\t\(.status)\t\(.conclusion)\t\(.completedAt)"'
BASE=$(git merge-base "$SHA" origin/main)
git log --format='%cI %h %s' "$BASE"..origin/main -- \
  pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml
git diff --quiet "$BASE" origin/main -- \
  pnpm-lock.yaml pnpm-workspace.yaml package.json .github/workflows/ci.yml && echo G5-pass
# G7 (ADR-carrying PRs only): the number this PR adds must be absent from every other open head
N=<pr>; NUM=<NNNN>
for p in $(gh pr list --state open --json number -q '.[].number'); do
  [ "$p" = "$N" ] && continue
  sha=$(gh pr view "$p" --json headRefOid -q .headRefOid)
  gh api "repos/yahodu/openpic-webapp/contents/docs/adr?ref=$sha" --jq '.[].name' |
    grep -E "^ADR-${NUM}-" && echo "COLLISION: PR #$p holds ADR-${NUM}"
done
```

The decision, its measured context and the rejected alternatives are recorded in
`docs/adr/ADR-0318-agent-enforced-merge-gate.md`.

### 9.2 The post-merge step (ADR-0967)

A merged lane's tip is **archived** and its **local branch released by the merge step
itself** — after the squash lands, in the same run, before the merging card
completes. The repository sets `delete_branch_on_merge: true`, so the merge deletes
the _remote_ head and the local branch is the only survivor; a later
`git push --all` then re-creates a branch whose PR is already merged. The decision,
its measured context and the rejected alternatives are in
[ADR-0967](adr/ADR-0967-merged-lane-local-branch-deletion.md).

The step, in order:

1. **Read the reviewed tip from the pull ref, never from the branch** — the branch
   may have moved after review:
   `HEAD_SHA=$(git ls-remote origin "refs/pull/$N/head" | cut -f1)`
2. **Archive the tip first**, only when the ref is absent:
   `git update-ref "refs/prhead/$N" "$HEAD_SHA"`.
   The archive comes **before** the delete, so a failed archive leaves the branch in
   place; the archived ref keeps the tip reachable from a local ref, so no
   `git gc --prune=now` can drop it.
3. **Release the holder, then delete the ref.** A worktree that holds the branch
   moves off it first (`git -C <wt> switch --detach`), or is removed when the gates
   below allow. Delete with the compare-and-delete form — never `git branch -D`,
   which refuses while the branch is checked out and cannot express "only if the tip
   is still the reviewed SHA":
   `git update-ref -d "refs/heads/<head-branch>" "$HEAD_SHA"`
4. **Assert the result** — all four, quoted in the merge record:
   `git for-each-ref "refs/heads/<head-branch>"` prints nothing;
   `git for-each-ref "refs/prhead/$N"` prints one line; that line's SHA equals
   `HEAD_SHA`; `git worktree prune --dry-run` is empty.

The ref is released only when **all** of these gates hold, re-derived at the moment
of deletion:

- the PR is `MERGED` and the landed commit is on the trunk
  (`git merge-base --is-ancestor <squash-sha> origin/main`);
- the archived tip is served verbatim by `refs/pull/<n>/head`, or is already an
  ancestor of `origin/main` — a moved tip is **kept and reported**, and nothing is
  archived under that PR number;
- the branch is **local-only**: `git ls-remote --heads origin "refs/heads/<head-branch>"`
  is empty;
- no worktree is **on** it any more (a detached worktree parked at the squash commit
  does not block), and no **other** non-`done` board row names it in `branch_name` or
  holds it through `workspace_path` — the merging card's own row is the lander and is
  exempt;
- a lane worktree is removed only when it is the merging card's own, or when it is
  clean (`git status --porcelain` empty) and named by no live row. A **dirty** tree is
  never removed and its branch is never deleted; it is recorded as a skipped head.

**Liveness — "whose worker is still running" (`AGENTS.md` §2.3).** A board row is
**live**, and its branch is not released, when its `status` is not
`done`/`archived` **or** it has an unfinished run (`task_runs.status = 'running'`
with `ended_at` NULL). The second clause is not redundant: the dispatcher keeps a
worker process alive for up to 120 s after the handoff
(`TERMINAL_WORKER_REAP_GRACE_SECONDS`), so a card that has already moved to `review`
or `done` can still hold a live writer. The read-only check on the board DB:

```
SELECT t.id, t.status, COUNT(r.id) AS live_runs
  FROM tasks t
  LEFT JOIN task_runs r
    ON r.task_id = t.id AND r.status = 'running' AND r.ended_at IS NULL
 WHERE t.status NOT IN ('done','archived') OR r.id IS NOT NULL
 GROUP BY t.id;
```

Every row it returns, other than the merging card's own row, keeps its branch:
detach that worktree (`git -C <wt> switch --detach`) or leave the branch until both
the card and its run are finished.

**Exception.** Every unmerged PR is out of scope: a RED-by-design pin PR, a PR held
for a dependency and a PR closed as superseded keep their branch **and** their
worktree. The rule is authorised by a **merge**, never by a card completing. One
lane, one head: the merger acts only on the branch the merged PR names
(`gh pr view <n> --json headRefName`). The hygiene sweep stays the backstop for
pre-existing, foreign and dirty heads.

**Two classes, never conflated.** _Unheld_ — no worktree holds the ref — is drift.
_Unheld and absent from origin_ is the gc hazard that needs an archive or a delete.
A head origin still serves is not drift, and a rule keyed on "unheld" alone would
delete an origin-backed branch.

This step existed before this section as an ad-hoc note in a reviewer checklist, and
that was not enough: a pitfall is read when it bites, not at merge time.

### 9.3 Protected agent-instruction files — the headless protocol

`AGENTS.md`, `CLAUDE.md`, `SOUL.md` and `.cursorrules` are protected
agent-instruction files. Hermes blocks the `write_file` and `patch` tools for those
basenames and asks the user to approve each write. A Kanban worker runs headless
(`hermes -p <profile> chat -q`), so no user is at that prompt: the guard waits out
its approval timeout — 300 s, measured six times on this board — and then refuses,
and the refusal forbids the same edit through a terminal. The guard does not see
shell writes at all (`git apply`, `sed -i`, a redirect), so for a worker that has a
terminal the tool-level gate is advisory.

**Decision: option B — approve out of band, then apply the approved bytes.** The
durable fix is option A: deliver the approval, so the prompt is answerable and the
fail-closed behaviour is correct. The approval path has no Kanban surface today —
`_gateway_notify_cbs` holds no entry for a worker session, and the
`pre_approval_request` / `on_human_input_request` plugin hooks are observers that
cannot return a choice — so delivering it is a Hermes platform change, not a
repository one. Option C (refuse shell writes to these basenames) was rejected: a
shell-level pattern cannot see `git apply`, `git checkout`, a merge or a script that
writes the file, and it would refuse legitimate terminal work. Do not reopen this
decision in a repository PR; a platform change is what closes it properly.

**The protocol.** A worker that needs to change a protected instruction file:

1. **Stop at the first refusal.** Do not retry the tool, and do not apply the edit
   by any path yet.
2. **Publish the exact diff and its hash on the card** — the full patch text, not a
   summary, plus `sha256sum` of the patch file.
3. **Block the card** — `kanban_block(kind="needs_input", reason=…)` naming the file
   and the published hash. Do not sit in a retry loop: each retry costs the full
   approval timeout.
4. **Wait for an explicit board-owner instruction in the card thread.** The approval
   is a comment by the human owner that names the file and comes after the published
   diff. A peer agent's comment, the worker's own summary, and an earlier approval of
   a different diff are not consent.
5. **Apply the approved diff unchanged**, and prove the bytes: the applied patch's
   `sha256sum` equals the published hash, and the file's `git diff` equals the
   published diff. A changed diff needs a new approval.
6. **Record the approval in the handoff** — the owner comment ids, the patch hash and
   the landed commit.

This protocol **weakens the control**: the gate can refuse but never grant, so the
sanction moves from the tool to the card thread. Three bounds keep it honest: only a
published diff may be applied; the change is additive or clarificatory (a rule that
is removed or weakened is the owner's own commit, never a worker's); and the landing
reviewer re-derives the applied-vs-published diff and the hash, because the tool gate
cannot. The protocol never sanctions an unpublished diff, a second edit covered by an
earlier approval, or a silent shell write with no card record.

The cheap alternative is to write the wording in a document the guard does not match
(this file, `docs/adr/`) and let the protected file point at it — that is how this
section is reachable from `AGENTS.md` §5 today. Use it for any rule that fits in the
DoD or in an ADR rather than in the instruction file.

## 10. Authority order when documents conflict

1. **Schema and Notification design** (highest)
2. **API contract**
3. **Other docs** (including this file)

When two sources conflict, stop and ask — do not silently pick one. Record the
resolution as an ADR so the next reader inherits the decision.

## 11. ADR numbering

ADR numbers are allocated in **per-lane reserved ranges**, never from a shared
high-water mark. The orchestrator is the allocator: when it creates a lane's cards
it assigns the lane a disjoint block of numbers, and it reserves each ADR number
**at card-creation time**, writing `**Consumes: NNNN**` into that card's body
(`none` for a card that mints no number). The worker takes the reserved number as
given and **never** derives one from the ledger — not from the block counter, not
from the `Next free` cell, not from the shared high-water mark, not from the tail
of `docs/adr/README.md`. The `Next free` cell is **informational**: the card that
lands a ledger row sets it to the **higher** of the trunk's value and one more than
the highest number consumed in the lane — the cell never moves down (ADR-0300 §12,
items 24–25). A card with no reserved number
asks the allocator; it never invents one. Reserving at creation — rather than each
worker deriving a number at its branch cut from a shared snapshot — is what makes
a lane closed under concurrency. The authority for this rule, its rationale and
the rejected alternatives are
`docs/adr/ADR-0300-adr-number-range-allocation-policy.md` §8–§9 and §12. Numbers
allocated before the policy (`≤ 0145`) are frozen history and are never moved.

- **In-flight-aware allocation (ADR-0300 §9, rule B; §12 item 23).** Before it
  hands a number to any card the allocator **enumerates the lane's in-flight
  reservations** and takes the next free number **above the highest in-flight
  one** — never the trunk `Next free` cell, never a snapshot of shared state.
  Enumerate all **four** sources: (a) every live worktree's `docs/adr/` files;
  (b) `git rev-list --objects --all -- docs/adr` — a number committed in any
  reachable tree, pushed or not; (c) the lane's non-`done` cards' `Consumes`
  values; and (d) **every open PR head** — list the open PRs with
  `gh pr list --state open --json number,headRefName,headRefOid`, then
  `git fetch origin <headRefName>` before `git ls-tree <headOid> docs/adr/` at
  each head — `ls-tree` needs the object locally. A branch named outside the
  ticket prefix (`wt/<task-id>`, a lane worktree branch) is invisible to
  `git ls-remote --heads origin "OP-<n>*"`, and an unpushed commit is invisible to
  any remote listing, so the open-PR-head sweep is not optional. The rule binds
  **whoever mints a card**, not the orchestrator alone. No ADR-carrying PR may
  squash-merge until the duplicate check has run **on the merged tree** (merge the
  incoming head into
  a throwaway worktree off `origin/main`, then run
  `apps/web/src/test/unit/adr-*.test.ts` and `uniq -d` over the `ADR-NNNN`
  prefixes there): a lone `docs/adr/README.md` conflict resolves cleanly while
  hiding a duplicate **file**. No ADR-carrying PR may merge while the number the
  PR **adds** is present at any other open PR head (ADR-0300 §11 item 28): the
  allocation sweep is a snapshot, so the lander re-sweeps at the merge instant
  (§9.1 G7); a hit refuses the merge and the lander renumbers its own unmerged
  record.
- **Same-lane serialization by the task graph (ADR-0300 §9, rule C;
  `docs/adr/ADR-0312-same-lane-adr-card-serialization.md`).** Two ADR-minting cards of
  one lane's range are **never siblings**: the allocator chains them
  (`parents=[<the earlier card>]`), so the successor is not `ready` until the
  predecessor's ledger row has landed on `main` and reads its number off the merged
  trunk — not off any shared snapshot, and with no concurrent sibling to enumerate under
  rule B. Every card body carries `Consumes: NNNN` (or `none`) **and** a
  `Same-lane ADR gate: serialized behind <card-id> | none` line. A worker that finds
  `Consumes` missing or `TBD`, or a same-range sibling already minting its number,
  **comments and blocks** the card back to the allocator — it never invents or renumbers
  a value. A card body without `Consumes:` is a decomposition defect the reviewer returns
  rather than works around; the ADR file's number must equal the body's `Consumes` value,
  and the merged-tree duplicate check above is unchanged.
- **The ledger.** The live range table is `docs/adr/README.md` § "ADR number
  allocation" (ADR-0300) — the single source of truth. Do not copy or re-derive
  the ranges anywhere else, including here. **The `Next free` column is the lane's
  reservation counter (ADR-0300 §7) — a monotonic high-water mark, not a computed
  count and not a landed-file count — and it is never written lower or moved
  down.** A number is _taken_
  once it is landed on `main` **or** allocated to any in-flight card/ref of that
  lane (an open PR/branch, or a live card assigned the number). Lanes reserve at
  allocation time: a card that lands a ledger row writes the cell as the **higher**
  of the trunk's value and one more than the highest number consumed in the lane,
  and a merge keeps the higher of the two sides and discards the lower one without
  renumbering a record. A lower value is therefore never evidence that a number is
  free, and two concurrent cards in one lane never compute the same "next free"
  (ADR-0300 §7, §12 items 24–25).
- **A note mirrors the record, not its own history.** The ledger note for a
  record describes the record **as it now stands**: amending a record — an added
  condition, a corrected contract, a renumber — amends its note in the **same
  PR**. The ledger **row** (`| [NNNN](file) | … |`) is a one-line summary and
  carries the same obligation. A deliberately historical statement belongs
  **inside** the record and is dated there, never in the ledger note. Precedent:
  PR #888 amended `ADR-0318` for G7, then PR #889 moved the README count and
  PR #902 the enumeration.
- **The guard.** `pnpm test:unit` fails on a duplicate `ADR-NNNN` prefix or a
  malformed `ADR-*.md` name
  (`apps/web/src/test/unit/adr-*.test.ts` — the guard is one spec per invariant,
  see ADR-0302 (`## Decision`, the invariant table) and §10). It is the
  mechanical backstop
  for the rule above and a required pre-merge check; `docs/adr/README.md` and any
  other non-`ADR-*.md` file are ignored.
- **Out of scope of the guard, by decision.** The guard does not check that a new
  number sits inside its lane's reserved range, and it does not cross-check
  `origin/main`. The range ledger is prose (parsing it in CI is brittle), and a PR
  checkout does not guarantee a fetched `origin/main`. Both stay **review-time
  obligations for the reviewer**, recorded here rather than mechanised.
- **Index-only merge conflicts.** When a PR's only conflict is the ADR index
  (`docs/adr/README.md`, one row per lane), it resolves at merge time rather than
  bouncing the card back to the implementer for a further round. The resolution is
  a **union** — keep **both** sides' ledger rows in ascending numeric order and set
  the lane's `Next free` cell to `max(consumed)+1` across both; **never
  pick-a-side**, because a pick-a-side resolution silently drops a side's row, which
  is how the first OP-105 collision presented as an ordinary index conflict. After
  the union, `prettier --write` normalises the widened column padding. The
  reviewer/merger may perform that mechanical refresh; the lane's content, numbering
  and assertions are untouched by it.
- **Rejected alternatives** (letters follow ADR-0300, where (a) is the adopted rule
  stated above).
  - **(b) Merger-owned finalisation** — the merger assigns the number when the
    branch lands, the ADR carrying an `ADR-NNNN-…` placeholder until then.
    Rejected: it serializes renames at merge time instead of removing them (every
    merge rewrites a filename and every cross-reference) and moves authorship of a
    decision artifact into the mechanical `--squash --admin` merge step.
  - **(c) Positional append-only log** — one `docs/adr/` log where the number is
    the row index. Rejected: it renames history; ADRs are cited by number across
    code, tests, the `docs/` design docs and other ADRs, so positional numbers
    invalidate every existing citation on the next insert.
  - **(d) Lowest free number at commit time** — the status quo this replaces.
    Rejected: unenforceable (the answer is stale the moment it is computed — it
    cost four renumbers in one day and two `CONFLICTING` PRs) and it makes the
    shared ledger tail a serialization point for the whole board.

Document map: `AGENTS.md` (agent entry point) · `docs/CONVENTIONS.md` (this file)
· `docs/adr/` (decisions) · `.github/pull_request_template.md` (PR + DoD).
