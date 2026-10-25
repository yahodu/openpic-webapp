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

This list is mirrored, copy-pasteably, in `.github/pull_request_template.md`.

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
lands a ledger row sets it to `max(consumed)+1`. A card with no reserved number
asks the allocator; it never invents one. Reserving at creation — rather than each
worker deriving a number at its branch cut from a shared snapshot — is what makes
a lane closed under concurrency. The authority for this rule, its rationale and
the rejected alternatives are
`docs/adr/ADR-0300-adr-number-range-allocation-policy.md` §8–§9. Numbers
allocated before the policy (`≤ 0145`) are frozen history and are never moved.

- **In-flight-aware allocation (ADR-0300 §9, rule B).** Before it hands a number
  to any card the allocator **enumerates the lane's in-flight reservations** and
  takes the next free number **above the highest in-flight one** — never the trunk
  `Next free` cell, never a snapshot of shared state. Enumerate all three sources:
  every live worktree's `docs/adr/` files, the lane's non-`done` cards' `Consumes`
  values, and the lane's open remote refs (`git ls-remote --heads origin "OP-<n>*"`,
  reading `docs/adr/` at each head where reachable). The rule binds **whoever mints
  a card**, not the orchestrator alone. No ADR-carrying PR may squash-merge until
  the duplicate check has run **on the merged tree** (merge the incoming head into
  a throwaway worktree off `origin/main`, then run
  `apps/web/src/test/unit/adr-numbering.test.ts` and `uniq -d` over the `ADR-NNNN`
  prefixes there): a lone `docs/adr/README.md` conflict resolves cleanly while
  hiding a duplicate **file**.
- **The ledger.** The live range table is `docs/adr/README.md` § "ADR number
  allocation" (ADR-0300) — the single source of truth. Do not copy or re-derive
  the ranges anywhere else, including here. **The `Next free` column is a
  reservation counter, not a landed-file count.** A number is _taken_ once it is
  landed on `main` **or** allocated to any in-flight card/ref of that lane (an
  open PR/branch, or a live card assigned the number). Lanes reserve at
  allocation time — the cell always names the number the next _new_ card in the
  lane will receive, so a card that consumes `0NNN` writes the next number above
  `0NNN`. Two concurrent cards in one lane therefore never compute the same
  "next free" (ADR-0300 §7).
- **The guard.** `pnpm test:unit` fails on a duplicate `ADR-NNNN` prefix or a
  malformed `ADR-*.md` name
  (`apps/web/src/test/unit/adr-numbering.test.ts`). It is the mechanical backstop
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
