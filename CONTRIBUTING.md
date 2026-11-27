# Contributing to OpenPic

Thank you for wanting to improve OpenPic. This guide covers how to propose a
change, how the code is written, how it is reviewed, and the terms your
contribution is accepted under. It is written for both people and autonomous
agents — the rules are the same for both, and where an agent differs, the
difference is stated.

Read these first:

1. [`LICENSE`](LICENSE) — the project is proprietary; your contribution terms are
   in section 6.
2. [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — the **authoritative** engineering
   standard. If this guide and the conventions disagree, the conventions win.
3. [`AGENTS.md`](AGENTS.md) — operating rules for autonomous agents.
4. [`docs/adr/`](docs/adr/README.md) — why the expensive-to-reverse decisions are
   what they are.

---

## 1. Who can contribute

Contributions are accepted from **contributors the owner has added to the
repository**. If you are not one yet, open an issue that describes the change you
want to make and the problem it solves, and the owner will decide whether to add
you.

Unsolicited pull requests from outside contributors may be closed without a
review. This is not hostility — it is what keeps the contribution terms and the
licensing of the project coherent.

## 2. Before you write code

1. **Find the requirement.** Every change traces to a ticket (`OP-<number>`), an
   issue, or an explicit instruction. No ticket, no branch.
2. **Read the owned document.** A billing change reads
   [`docs/Subscription flow.md`](docs/Subscription%20flow.md) and the API
   contract's billing part; a notification change reads
   [`docs/Notification and Database Design.md`](docs/Notification%20and%20Database%20Design.md).
   The API contract is normative: if the code and the contract disagree, stop and
   ask which one is wrong.
3. **Search the ADRs** for the area. A decision that looks odd usually has a record
   explaining the alternative that was rejected.
4. **Check the board for a duplicate.** Someone may already be fixing it.

## 3. Local setup

Follow [README → Getting started](README.md#getting-started): it starts the
MongoDB replica set the transactions need, copies `.env.example` to `.env`,
creates the indexes and boots the API. Every environment variable is documented
in [docs/Configuration.md](docs/Configuration.md).

Run the checks you will be judged on before you push:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:unit
pnpm test:int          # needs the in-memory Mongo binary on first run
```

## 4. Branch, commit and pull request

| Thing        | Rule                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| Branch       | `OP-<number>-<feature\|bug\|task>-<lowercase-slug>`, cut from `main`    |
| Commit       | Conventional Commits: `type(scope): OP-123 short description`           |
| Types        | `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `perf`        |
| Pull request | Title `type(scope): OP-123 description`, filled in from the PR template |
| Merge        | Squash merge into `main`; the branch is deleted on merge                |

Work on **one logical change per pull request**. A pull request that mixes a fix,
a refactor and a formatting sweep cannot be reviewed, and will be returned.

The PR template asks for the RED and GREEN test output, the DoD checklist, the
contract section you implemented, deployment notes and any environment-variable
change. Fill it in honestly — the merge gate checks the head you actually tested.

## 5. Test-driven development is mandatory

No production code without a failing test that demands it.

1. **RED** — write the test, run it, and confirm it fails **for the right reason**.
2. **GREEN** — write the smallest code that passes it.
3. **REFACTOR** — clean up while the suite stays green.
4. Paste both outputs into the pull request. A pull request without them is not
   reviewable.

Rules that are not negotiable:

- **Never edit, skip, weaken or delete a test to make the suite pass.** A green
  suite achieved by rewriting the test is a failed delivery. If a test looks wrong,
  stop and raise a dispute with evidence; the Test Author owns the test.
- **No test-environment branches.** `if (NODE_ENV === "test")` in production code
  is a rejection. Tests substitute doubles (MSW, in-memory Mongo) instead.
- **No fixture-specific special cases.** The code must work for the general
  behaviour the test exemplifies.

### Test pyramid

| Layer       | Tool                                                 | Use for                                         |
| ----------- | ---------------------------------------------------- | ----------------------------------------------- |
| Unit        | Vitest                                               | Pure logic, validators, mappers, guards         |
| Integration | Vitest + `mongodb-memory-server` (replica set) + MSW | Route handlers, DB access, third-party adapters |
| E2E (API)   | Playwright                                           | Journeys that span several routes only          |

- Integration runs against a **replica set**, because multi-document transactions
  must behave as they do in production.
- Every outbound HTTP call goes through MSW with `onUnhandledRequest: "error"`.
- Fixtures are built with `buildX(overrides)` factories that `schema.parse` their
  own output — never a hand-written object literal.
- Coverage thresholds: 80% overall, 90% for `server/domain` and `server/services`.
  A shortfall is fixed with tests, never by lowering the threshold.

## 6. Coding conventions

`docs/CONVENTIONS.md` is normative. The rules that come up in almost every review:

| Topic               | Rule                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Types               | TypeScript `strict`; no `any`, no `@ts-ignore`, no suppression instead of a fix                                |
| Contracts           | Every request body, query, param and response has a Zod schema in `packages/contracts`                         |
| Validation          | Parse at the boundary; treat upstream payloads as untrusted                                                    |
| Tenancy             | Every tenant-scoped filter includes `tenantId` through the repository wrapper; a missing one blocks the review |
| Secrets             | Never logged; compared with constant-time helpers, never `===`                                                 |
| Never-return fields | Project responses through the contract schema so internal fields cannot leak                                   |
| Logging             | Through the `Logger` port only — never `console.*` in application code                                         |
| TSDoc               | Every exported function, class, type and route handler; cite the contract section                              |
| Config              | Environment for deploy config, `platformSettings` for runtime tunables — never a hard-coded knob               |
| Files and names     | Verb–noun functions (`projectInvoice`); no vendor names in domain vocabulary                                   |
| Mutation            | Immutable updates; `Promise.all` for independent I/O                                                           |

Local ESLint rules enforce two of these mechanically: no direct collection access
outside the repository layer, and no direct vendor-SDK import outside its adapter.

## 7. Architecture decisions

Any decision that is expensive to reverse needs an ADR in `docs/adr/`:

- One file per decision, named `ADR-NNNN-<slug>.md`, sections **Context ·
  Decision · Consequences · Alternatives**.
- Numbers are reserved in advance from per-lane ranges; never derive a number from
  the ledger yourself. Ask the owner (or the orchestrator, on a board) for the
  `Consumes` value before you mint a record.
- The record and its row in [`docs/adr/README.md`](docs/adr/README.md) land **in the
  same pull request**. A record without a row, or a row without a record, fails the
  Definition of Done.
- Never edit an accepted ADR. Supersede it with a new one and mark the old
  `Superseded by ADR-NNNN`.
- The `adr-*` unit guards are the backstop: run `pnpm test:unit` before you push.

## 8. Review and merge gates

A pull request is mergeable only when all of these hold:

1. Branch name and PR title match the patterns in section 4.
2. CI is green on the **head commit**: typecheck, lint, unit, integration,
   coverage, build, E2E, dependency audit, secret scan.
3. The PR body carries the RED and GREEN evidence and every DoD box is honest.
4. Review has approved the change.
5. The merge gate (conventions §9.1) printed PASS on the exact head SHA, and that
   output is in the PR.
6. After the squash lands, the head is archived to `refs/prhead/<n>` and the local
   branch released (conventions §9.2).

Do not force-push over a review, do not merge with a red or pending check, and do
not re-run a failed check to make it green — fix the cause.

## 9. Working as an agent

Autonomous agents follow the same rules plus these:

1. **Orient before acting.** Read `AGENTS.md`, the card or ticket, and the tests
   that define the work. The tests are the specification; prose is commentary.
2. **Stay in your workspace.** Work in the worktree or branch you were given; never
   touch the main checkout or another card's branch.
3. **Never modify tests, fixtures, mocks, MSW handlers or test utilities.** If the
   specification is wrong or self-contradictory, implement everything unambiguous,
   leave that test red, and hand back a written dispute with evidence.
4. **No test-environment branches, no hard-coded fixture values, no stubs** that
   fake the behaviour a test asserts.
5. **Commit in small logical chunks** with Conventional Commit messages, push, and
   open the pull request against `main` — never commit directly to `main`.
6. **Do not block on questions you can answer.** When a decision truly needs a
   human, record the context and surface it; do not silently guess.
7. **Report what you measured.** Test counts, check runs on the head SHA and the
   merge gate output are evidence; "should pass" is not.
8. **Record decisions in ADRs** (section 7) exactly as a human would.

Agents that write code do not write the tests for it and do not approve their own
work: the author, the reviewer and the merger are separate roles on the board.

## 10. Contribution terms

By submitting a contribution you accept the terms in [`LICENSE`](LICENSE) §6. In
short:

- You keep the copyright in your contribution.
- You grant the owner a perpetual, irrevocable, worldwide, royalty-free licence to
  use, modify, distribute **and relicense** your contribution under any terms,
  including a future different licence for the project.
- You confirm the contribution is yours to submit and does not knowingly infringe
  anyone else's rights.
- The contribution is provided as-is, without warranty, and the owner is not
  obliged to use it.

Without that grant the project could not change its licence later, which is why it
is a condition of contributing rather than a formality.

## 11. Security

Do not open a public issue for a vulnerability. Use
[GitHub security advisories](https://github.com/yahodu/openpic-webapp/security/advisories/new)
with the affected route, a reproduction and the impact. Never commit a real
secret: `.env.example` carries placeholders only, and a secret scan runs on every
pull request.

## 12. Questions

Open an issue with the `question` label, or ask in the pull request. For licensing
or commercial use, contact the owner through <https://openpic.in>.
