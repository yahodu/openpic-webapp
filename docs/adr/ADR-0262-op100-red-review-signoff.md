# ADR-0262 — OP-100 RED review sign-off: the tenancy contract verified RED; the suspension-coverage gap closed before the GREEN and the follow-up pins routed

- **Status:** Accepted · **Date:** 2026-10-23 · **Author:** `openpic-webapp-reviewer`
- **Card:** OP-100 RED (`t_a5def1f1`), round 1 · **Verdict:** **APPROVED WITH FINDINGS** (artifact lens) — Medium/Low/Info findings only, all routed; **zero reviewer edits to the deliverable**
- **Reviewed:** branch `OP-100-task-tenant-provisioning`, head `abfa0f0`; PR [#256](https://github.com/yahodu/openpic-webapp/pull/256) — a **draft, deliberately held open** at review time (see §5)
- **Reviewed by:** round 1, **artifact lens** (diff read cold; every handoff claim independently re-derived)
- **Number:** drawn from the OP-100 lane's reserved range `0260`–`0279` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md), `docs/adr/README.md` § "ADR number allocation"). `0260` is consumed by [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the RED contract) and `0261` by [ADR-0261](ADR-0261-op100-tenant-provisioning-green.md) (the GREEN implementation) — both count as taken under ADR-0300 §7 — so this sign-off takes `0262`; the lane's `Next free` cell in `docs/adr/README.md` read `0262` on a fresh `origin/main` immediately before this commit and advances to `0263`.
- **Relates to:** [ADR-0260](ADR-0260-op100-tenant-provisioning-red.md) (the RED contract of record), [ADR-0261](ADR-0261-op100-tenant-provisioning-green.md) (the GREEN the lane produced), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (the per-lane range policy), [ADR-0242](ADR-0242-op99-red-review-signoff.md) (the sibling RED sign-off posture), PR [#256](https://github.com/yahodu/openpic-webapp/pull/256) review comment [`#issuecomment-6357704959`](https://github.com/yahodu/openpic-webapp/pull/256#issuecomment-6357704959)
- **Touches:** `docs/adr/ADR-0262-op100-red-review-signoff.md` (this file) and the `docs/adr/README.md` ledger (the OP-100 lane row cell and one paragraph) — **docs only**

## Context

This ADR records only the **review** of the OP-100 RED. The contract the RED
pins is recorded in ADR-0260; nothing here restates or contradicts it. The
sections below are the delta a sign-off adds: what was independently reproduced,
what the verdict pins, and where each finding went.

The RED delivers **specification files only** — two unit specs (U1 slug
generator, U2 role permission map), one integration/contract spec (I1–I6 plus
the provisioning-on-first-write seam I7), one Playwright spec (E1), ADR-0260 and
the README ledger — with **no production code**. The four pinned production paths
do not exist yet, so the specs are red for the right reason. This review
therefore looked at a tree the handoff reported as honestly red, and re-derived
that claim from scratch at the reviewed head.

## Decision

### 1. Reviewed scope and evidence — reproduced, not taken from the handoff

Every number below was re-derived by the reviewer at the reviewed head
`abfa0f0`, in the lane worktree, not read off the handoff:

| Check (at `abfa0f0`)                                                                                               | Result                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git diff --stat b6b5301..abfa0f0`                                                                                 | **production code: none** — 4 test files + ADR-0260 + the README lane ledger (**1014 insertions, 1 deletion** = the ledger cell)                                            |
| `tsc -p apps/web/tsconfig.json`                                                                                    | **exactly 4 `TS2307`** missing-module errors, one per pinned module, **no other diagnostic**                                                                                |
| `vitest run --project unit`                                                                                        | **2 failed \| 86 passed (88) files · 1514 passed (1514)** — the only failing files are the 2 new OP-100 specs                                                               |
| `vitest run --project integration` (`TMPDIR=/root/tmp-mongo`)                                                      | **1 failed \| 57 passed (58) files · 361 passed (361)** — the only failing file is the new OP-100 integration spec                                                          |
| Independent stub probe (throwaway worktree at `abfa0f0`, minimal stubs at the four paths, reviewed tree untouched) | integration **15/15 fail at assertion level** (every failure an `AssertionError`, e.g. `expected 501 to be 404`); unit probe **12 failed / 11 passed**, all assertion-level |
| `prettier --check` on the 6 changed files                                                                          | clean                                                                                                                                                                       |
| `eslint` on the 4 test files                                                                                       | **0 errors**                                                                                                                                                                |
| ADR guard `adr-numbering`                                                                                          | **29 / 29 passed**                                                                                                                                                          |
| `gitleaks detect --config .gitleaks.toml --log-opts=origin/main..abfa0f0` (local)                                  | **1 commit scanned, no leaks found**                                                                                                                                        |
| Contract fidelity                                                                                                  | the §2.1 `GET`/`PATCH` DTO assertions map 1:1 to `docs/API Contract.md` §2.1; `not_found`/`forbidden`/`invalid_billing_contact` statuses match Appendix A.1/A.4             |
| ADR lane allocation                                                                                                | ADR-0260 sits inside the OP-100 reserved range `0260`–`0279`; README row + prose present; `Next free → 0261`                                                                |

The failure in each suite is `module-not-found` for the pinned module the RED
contracts — the honest RED:

- unit: `@/server/tenancy/slug` and `@/server/tenancy/permissions`;
- integration: `@/app/api/v1/tenants/[tenantId]/route`.

The stub probe is the load-bearing check: with production stubs at the four
paths, **every** integration assertion fails at assertion level (never a
harness/session/seed error), which proves the fixtures, session boot, OTP capture
and seeding are sound and the RED is red for the contract's reason rather than
because the harness is broken. No `.skip`, no test-environment conditional and no
fixture-shaped hardcoding was found in the delivered specs.

### 2. Verdict: round 1 APPROVED WITH FINDINGS

Round 1 (artifact lens) approved with findings — Medium/Low/Info only, none of
which blocks the contract. The contract is unambiguous, the RED reason
reproduces, and every finding is routed to the desk that owns it. **No reviewer
edit landed in the deliverable.**

Review record: the PR body comment
[`#issuecomment-6357704959`](https://github.com/yahodu/openpic-webapp/pull/256#issuecomment-6357704959)
(the sole `gh` identity, `getwithashish`, authored PR #256, so a formal GitHub
approval is not possible — the sign-off is recorded as a PR comment, matching the
posture of every prior OP-9x review in this board).

### 3. Decisions confirmed

The RED raised two assumptions explicitly rather than burying them; both are
**confirmed**:

- **A1 — the provisioning trigger (ADR-0260 D3).** The alias never provisions
  (`GET /tenants/current` → `404` for a caller with no workspace, I2/I4 — a read
  must never create a billable workspace); the **first tenant-scoped write** by
  such a caller provisions the workspace (caller = `owner`) and then applies the
  write (I7 handler-level, E1 end-to-end). This is coherent with contract §2.1
  (no public `POST /api/v1/tenants` in v1) and with OP-90's fresh-account
  `primaryTenant: null` / `canCreateEvent: false`.
- **A2 — `invalid_billing_contact` (`422`).** A doc-only code, absent from the
  TypeScript transport but named in prose by §2.1; appended to the request-shape
  transport following the `unknown_timezone` / `forbidden_field` precedent.
  Same class as those existing codes; no `ERROR_CATALOG` mutation.

### 4. Findings routed to follow-up cards

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                  | Routed to                                                                                                               |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| F1  | Medium   | The GREEN-scoped `423 tenant_suspended` write path was **unpinned**, and ADR-0260 A4 / "Deliberate non-assertions" justified the omission with a **false claim** — "no code in the contract catalogue"; `docs/API Contract.md:3484` carries the Appendix A.1 row `tenant_suspended \| 423 \| { reason, supportUrl }`, the same doc-only position as `invalid_billing_contact`, which this RED _did_ pin. | **`t_83118bad`** (TEST pin — **serialised before the GREEN**: wired as a parent of `t_2d03b293` so the pin lands first) |
| F2  | Low      | Dead `Identity.phone` in the integration spec (`tenant-provisioning-and-routes.test.ts:116/128`) — never read; the doc-comment claims "a unique email/phone/IP".                                                                                                                                                                                                                                         | **`t_83118bad`** (folded into the same card)                                                                            |
| F3  | Info     | The I1 concurrency pin (`Promise.all` of two `ensureTenantForUser` calls) can pass **without true interleaving** under the event loop, so a naive check-then-insert could pass by luck; repeating over ≥3 fresh users would harden it.                                                                                                                                                                   | optional hardening listed on `t_83118bad`; **no separate card**                                                         |
| F4  | Info     | A **draft** PR starts no `CI` / `PR Checks` run in this repo (only CodeQL), so the RED's evidence is **local** until the GREEN's first push; and the branch's only conflict with `origin/main` is the **index-only** `docs/adr/README.md` lane ledger.                                                                                                                                                   | **no card** (Info)                                                                                                      |

F1's disposition: the pin (I8 — suspended tenant `PATCH` → `423 tenant_suspended`,
stored name unchanged) and the in-place correction of ADR-0260 A4 (no new ADR
number consumed, following the OP-99 in-place-amendment precedent under
`t_28ab0e00`) were delivered by `t_83118bad`, which was wired as a **parent** of
the GREEN card `t_2d03b293` so the pin landed **before** the implementation (TDD:
no untested production code). F2 was closed by the same card. F3 was settled by
the GREEN's single-transaction claim (ADR-0261 D2); F4 closed on the GREEN's first
push, which triggered both the full PR Checks and the CI workflow on `acbdbe7`.

### 5. Posture and the lane's outcome — the RED PR was held open, then landed inside the GREEN PR

At sign-off the RED branch/PR **stayed open** (draft) for the GREEN
(`t_2d03b293`), which inherits the same branch: a RED-by-design PR cannot be
squash-merged, because the red specs (and `tsc`) would redden the trunk's
`typecheck`, `unit_test` and `test_coverage` jobs. This is the **one recorded
deviation** from the default "merge before complete": the pins ship inside the
gated GREEN PR, the established posture of the sibling RED lanes
([ADR-0242](ADR-0242-op99-red-review-signoff.md), [ADR-0091](ADR-0091-op94-fan-out-red-review-signoff.md)).

The lane then completed on that same branch, and this record is written after the
fact on the landed trunk:

- **F1/F2** closed by `t_83118bad`; the branch was turned green by `t_2d03b293`
  (commits `ee36606`, `260f759`, `328b648`, then the `origin/main` merge
  `acbdbe7`).
- The four delivered test files, ADR-0260 and its ledger row are **byte-unchanged**
  across the GREEN.
- PR [#256](https://github.com/yahodu/openpic-webapp/pull/256) was
  **squash-merged to `main` as `5fd133d`** at `2026-10-23T05:29:25Z` (release
  `1.26.0`, `3af8430`) with all required checks green on head `acbdbe7` — the
  draft was marked ready only after the suite went green.

## Consequences

- OP-100's RED is **accepted**: the tenancy contract (ADR-0260), its
  implementation (ADR-0261) and the follow-up pins are verified, landed and
  recorded. ADR-0260 stays authoritative for behaviour; this ADR records the
  acceptance of the RED.
- Number `0262` is consumed by this sign-off; the OP-100 lane's `Next free` cell
  in `docs/adr/README.md` advances to `0263`. No number outside the lane's
  `0260`–`0279` range is touched.
- This is a **docs-only** record: no production, test, fixture or configuration
  file is touched, so no suite's observable behaviour changes.
- The findings are routed, not buried: F1/F2 → `t_83118bad` (landed before the
  GREEN); F3 settled by ADR-0261 D2; F4 closed by the GREEN's CI run. No card was
  needed for the Info findings.
- The `docs/adr/README.md` edit is the OP-100 lane row cell (`0262` → `0263`)
  plus one inserted paragraph. That file is a cross-lane hotspot; the paragraph
  is appended in the established sign-off style and no other lane's cell is
  touched.

## Alternatives considered

- **Record this sign-off as a section inside ADR-0260.** Rejected: ADR-0260 is
  the _contract_ and shipped with the RED; the acceptance of the reviewed head is
  a distinct artifact, and every prior sign-off in this lane family (ADR-0091,
  0097, 0107, 0181, 0222, 0242) is recorded as its own file.
- **Merge PR #256 at sign-off.** Rejected: a RED-by-design PR carries a red suite
  and a red `tsc`; squash-merging it would redden `main`. The pins shipped inside
  the gated GREEN PR, which is what in fact happened.
- **Request changes on PR #256 for F1.** Rejected: F1 is a **coverage** gap on a
  GREEN-scoped behaviour plus a documentation-justification error, not a contract
  defect in the reviewed artifact; the reviewer's editing rule forbids touching
  the deliverable, and the pin belongs to the Test Author. It was routed to
  `t_83118bad`, serialised before the GREEN.
- **Leave the findings as PR comments only.** Rejected: the repo's operating
  rules require every review finding to be routed to a card; F1/F2 went to
  `t_83118bad`, and F3/F4 are Info with no action.
