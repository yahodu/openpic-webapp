# ADR-0089 — OP-93 U18 fixture-reconciliation review sign-off: escaping pin intact, no production change

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 fix RED fixture — U18 render-template body assertion (`t_f8edb6f8`), review round 1 (artifact + execution lens) · **Relates to:** [ADR-0088](ADR-0088-op93-channel-resolution-and-template-renderer-green.md) §3 (the dispute report the card resolves), [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) (the pinned renderer contract)

## Renumbered

Authored as **ADR-0082**; renumbered to **ADR-0089** when PR #187 integrated
`origin/main` on 2026-10-05 (append-only, no content change). `origin/main` had
already claimed `0078`/`0079`/`0081` (OP-91 follow-up payload lane, PR #183) and
`0082`–`0084` (OP-92 follow-up lane, PR #186), so the five OP-93 ADRs were
renumbered `0078`–`0082 → 0085`–`0089`; `0080` is left unused on `main`.

## Context

`render-template.test.ts` **U18** ("escapes interpolated values so an injected
script tag cannot execute") was internally inconsistent: it carried `<script>`
only in `eventName`, but its `bodyTemplate` interpolated only `displayName`, so
`expect(rendered.body).toContain("&lt;script&gt;")` was unsatisfiable. The defect
existed since the original RED commit and was surfaced — not worked around — by
the GREEN implementer, who stayed strictly in production code and routed the
reconciliation to a test-side card (`t_f8edb6f8`). The sibling **U26** uses the
same fixture and asserts on `rendered.subject`, which passes.

The reconciliation was required to be append-only: keep all three body
assertions and the escaping pin, change nothing else, touch no production file.

## Decision

**Approved — no findings requiring a change.** The fixture is reconciled
test-side exactly as scoped, without deleting or loosening any assertion.

Independent evidence (this review, worktree `t_beda070f`, head `4cfd44e`):

- Diff (`git diff 3d5034f..HEAD`) is precisely:
  - `render-template.test.ts`: one line — U18 `bodyTemplate`
    `"<p>Hi {{displayName}}, your gallery is ready.</p>"` →
    `"<p>Hi {{displayName}}, your photos from {{eventName}} are ready.</p>"`;
  - `ADR-0088` §3 updated from "dispute (left RED)" to "resolved test-side".
    No assertion added, removed, or weakened; **U26 unchanged**; `variables:
["eventName","displayName"]` stays consistent with the placeholders now used.
- `./node_modules/.bin/vitest run --project unit apps/web/src/server/notifications/render-template.test.ts`
  → **6/6 passed**.
- Both OP-93 specs (`render-template` + `resolve-channel`) → **27/27 passed**.
- Full unit project → **77 files, 1421 tests passed** (baseline was 1420 passed |
  1 failed — the previous U18 failure was the only red).
- `git diff --name-only origin/main...HEAD` shows no production file added by
  this card beyond the GREEN deliverable already on the branch; the two commits
  under review touch only the spec and the ADR.
- `prettier --check` and `eslint` clean on the changed files.

The escaping pin is genuinely exercised: `&lt;script&gt;` can now appear in the
rendered body only via escaped interpolation of the malicious `eventName`, and
the `"Rahul &amp; Priya"` assertion independently pins `displayName` escaping.

## Consequences

- U18 now passes for the right reason and still fails if the renderer stops
  escaping body interpolation; U26 continues to pin subject escaping on the same
  fixture.
- No production code and no observable behaviour changed — this is a test
  fixture correction plus an ADR note, so GREEN's obligations are untouched.
- The RED branch (draft PR #185) remains an unmerged draft by design; these pins
  ship inside the OP-93 GREEN PR.

## Alternatives considered

- **Delete the `&lt;script&gt;` body assertion.** Rejected: it would drop the
  body-escaping pin. Reinterpolating `eventName` keeps the assertion meaningful.
- **Change the renderer to inject `eventName` into `body`.** Rejected: subject
  and body are independent Handlebars templates (design §19.2, ADR-0085); that
  would be a behaviour change and a production-code edit outside the card's
  scope.
- **Open a PR for this branch to carry the review.** Rejected: the branch is the
  GREEN implementer's in-progress lane; its PR is opened by the GREEN task. This
  card is `local-only` and has no PR of its own to comment on.
