# AGENTS.md — OpenPic Agent Operating Rules

This file is the single source of truth for autonomous agent behavior in the
OpenPic repository. Every agent — whether spawned via Kanban, running as a CI
job, or invoked ad-hoc — MUST read this file before taking any action.

## 1. Task Lifecycle

### 1.1 How agents pick up work

- **Kanban tasks** are the primary dispatch mechanism. The orchestrator
  decomposes high-level goals into concrete cards on the shared Kanban board
  (`~/.hermes/kanban.db`).
- Each card is assigned to exactly one agent profile. The dispatcher picks up
  `ready` cards and spawns the assigned worker.
- Workers MUST call `kanban_show()` on entry to orient on the card body, prior
  runs (if retrying), and the parent handoff summary.
- The workspace is `$HERMES_KANBAN_WORKSPACE`. `cd` there before any file ops.
- Workers run headless. Do NOT call `clarify` — use `kanban_comment` for
  context and `kanban_block` for blockers.

### 1.2 Task completion states

| State | When | How |
|---|---|---|
| **Done** | Task is terminal — no review needed (e.g. docs, research, config) | `kanban_complete(summary=..., metadata=...)` |
| **Review** | Implementation finished — needs human or reviewer profile eyes | `kanban_request_review(summary=...)` |
| **Blocked** | External decision needed | `kanban_comment(body=...)` + `kanban_block(reason=...)` |
| **Changes requested** | Reviewer found issues | `kanban_request_changes(reason=...)` — re-queues implementer |

### 1.3 Decomposition

Orchestrator agents decompose work into Kanban cards. Rules:
- Do NOT execute work yourself — route it.
- One card per independent workstream. Do NOT bundle unrelated work.
- Link dependencies via `parents=[...]` on `kanban_create`. Do not use prose.
- Run independent lanes in parallel (no parent links).
- Every assignee must be a real profile — the dispatcher silently drops
  unknown assignees.
- After fan-out, call `kanban_complete` with the list of created card IDs.

## 2. Development Workflow

### 2.1 TDD (Test-Driven Development)

**All production code MUST follow RED-GREEN-REFACTOR:**

1. **RED** — Write a failing test for the behavior you want.
2. **Verify RED** — Run the test; confirm it fails for the right reason.
3. **GREEN** — Write minimal code to pass the test. Cheating allowed.
4. **Verify GREEN** — Run the test; confirm it passes. Run full suite.
5. **REFACTOR** — Clean up while keeping tests green.

Exceptions (ask the user): throwaway prototypes, generated code, config files.

Branch naming: `OP-XXX-(feature|bug|task)-description` (validated by CI).

Commit messages: Conventional Commits format —
```
type(scope): OP-XXX short description

Longer explanation if needed.
```
Types: `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `perf`.

### 2.2 Pre-commit verification

Before `git commit` or `git push`, run the verification pipeline:

1. **Static security scan** — grep for hardcoded secrets, shell injection,
   SQL injection, eval/exec, unsafe deserialization in added lines.
2. **Baseline comparison** — stash changes, run tests + linter, pop. Only new
   failures count as regressions.
3. **Self-review** — no debug prints, commented code, or hardcoded secrets.
4. **Independent reviewer subagent** — delegate_task gets ONLY the diff.
   Returns JSON verdict. Fail-closed: unparseable → fail.
5. **Auto-fix loop** — max 2 cycles of fix-and-reverify.
6. **Commit** — only after all checks pass.

### 2.3 Pull Requests

- Auto-draft PR created on new branch push (see `.github/workflows/new_branch_flow.yml`).
- PR title format: `type(scope): OP-XXX description`.
- PR body must include Jira ticket, implementation summary, quality checklist,
  deployment notes, and env var changes (see `.github/pull_request_template.md`).
- CI runs: branch name validation, PR title validation, tests, linting.
- Merge via squash (`gh pr merge --squash --delete-branch`).
- Only merge when all CI checks pass and review is approved.

## 3. Agent Roles

### 3.1 Orchestrator

- Decomposes goals → Kanban cards. Does NOT write code.
- Owns design decisions: naming, schemas, API shapes, file layout.
- Writes decisions into EVERY child card body — workers cannot see sibling cards.
- Reports decomposition back via `kanban_complete`.

### 3.2 Implementer

- Follows TDD strictly. No production code without a failing test first.
- Works inside `$HERMES_KANBAN_WORKSPACE`.
- Runs pre-commit verification before every commit.
- On completion: `kanban_request_review` with summary + metadata (changed
  files, test counts, decisions).

### 3.3 Reviewer

- Receives task via `kanban_request_review`.
- Reads the diff, static scan results, and implementer's handoff metadata.
- Approves with `kanban_complete(summary="LGTM — <verdict>")`.
- Requests changes with `kanban_request_changes(reason="<specific items>")`.
- Blocks only for genuine external blockers — not for review feedback.
- Reviews are non-blocking in the Kanban lifecycle: repeated review cycles
  do NOT trip unblock-loop detection.

## 4. Communication Protocols

### 4.1 Within Kanban

| Channel | Content |
|---|---|
| `kanban_complete(summary=...)` | Human-readable 1-3 sentence handoff |
| `kanban_complete(metadata=...)` | Structured facts (changed files, test counts, findings) |
| `kanban_comment(body=...)` | Durable context, reasoning, long-form notes |
| `kanban_block(reason=...)` | One-sentence blocker for human attention |

### 4.2 Escalation

| Situation | Action |
|---|---|
| Missing credential / capability wall | `kanban_block(kind="capability", reason=...)` |
| Need a human decision | `kanban_block(kind="needs_input", reason=...)` + `kanban_comment` with full context |
| Waiting on another task | `kanban_block(kind="dependency", reason=...)` — auto-resumes when parent completes |
| Flaky / transient failure | `kanban_block(kind="transient", reason=...)` |
| Repeated block/unblock cycle | Task auto-escalates to triage — no manual action needed |

### 4.3 External notifications

- **Slack**: PR merges, deployments, PR status summaries (see `.github/workflows/`)
- **Jira**: Every PR links to `OP-XXX` ticket in body. Branch naming ties back.
- **Vercel**: Production deploy monitor alerts on failure every 15 min.

## 5. Quality Gates (Definition of Done)

Before any task is complete:

- [ ] Code follows team style (linting passes)
- [ ] Unit tests exist and pass (min 80% coverage on touched code)
- [ ] Integration tests pass (if applicable)
- [ ] Feature tested locally in a clean environment
- [ ] Code comments added for complex logic
- [ ] No secrets/keys committed
- [ ] Input validation checked
- [ ] No obvious N+1 queries or memory leaks
- [ ] Database migrations handled (if applicable)
- [ ] Environment variables documented in `.env.example` (if changed)
- [ ] API docs / Swagger updated (if endpoints changed)

## 6. Project Context

- **Repository**: OpenPic web application
- **Stack**: Next.js (App Router), Vercel deployment
- **Package manager**: npm
- **CI/CD**: GitHub Actions (PR checks, semantic-release, Slack notifications)
- **Versioning**: semantic-release with conventional commits (`.releaserc.json`)
- **Issue tracking**: Jira — `https://yahodu.atlassian.net/browse/OP-XXX`
- **Branch strategy**: Feature branches from `main`, squash merge back

## 7. Agent-Specific Rules

- **An agent MUST NOT modify files outside its task workspace** unless the
  task body explicitly says to.
- **An agent MUST NOT call `clarify`** — it runs headless. Use `kanban_block`.
- **An agent MUST NOT delegate work to itself** — spawn a child card for the
  right profile.
- **An agent MUST read this file before any action** in this repository.
- **An agent MUST use Conventional Commits** for all commits.
- **An agent MUST NOT invent profile names** — verify with `hermes profile list`
  or ask the user before creating Kanban cards.
- **Orchestrators do not write code. Implementers do not decompose. Reviewers
  approve with LGTM or request changes — they do not rewrite.**

---

*This file is the entry point. If a document linked here is missing or stale,
the agent should update it or flag it via `kanban_comment`.*
