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

Document map: `AGENTS.md` (agent entry point) · `docs/CONVENTIONS.md` (this file)
· `docs/adr/` (decisions) · `.github/pull_request_template.md` (PR + DoD).
