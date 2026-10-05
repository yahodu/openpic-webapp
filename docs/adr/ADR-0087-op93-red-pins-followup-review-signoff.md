# ADR-0087 — OP-93 RED-pins follow-up review sign-off: U24–U26 verified RED

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-93 RED-pins follow-up (`t_2fc90876`), review round 1 (artifact + execution lens) · **Relates to:** [ADR-0085](ADR-0085-op93-channel-resolution-and-template-renderer-red.md) (the pinned contract), [ADR-0086](ADR-0086-op93-red-review-signoff.md) (the round-1 RED review that routed these three gaps)

## Renumbered

Authored as **ADR-0080**; renumbered to **ADR-0087** when PR #187 integrated
`origin/main` on 2026-10-05 (append-only, no content change). `origin/main` had
already claimed `0078`/`0079`/`0081` (OP-91 follow-up payload lane, PR #183) and
`0082`–`0084` (OP-92 follow-up lane, PR #186), so the five OP-93 ADRs were
renumbered `0078`–`0082 → 0085`–`0089`; `0080` is left unused on `main`.

## Context

ADR-0086 routed three coverage gaps to a follow-up RED-pins card (`t_2fc90876`):
`respectQuietHours: false` inside an enabled window, the `mobile` per-candidate
suppression fallback, and subject escaping. That card added U24–U26 to the two
OP-93 RED specs on the same branch (`OP-93-task-channel-resolution-and-template-renderer-red`,
draft PR #185) and updated ADR-0085 assumptions 2 and 5. This review verifies the
new pins independently before GREEN starts.

## Decision

**Approved — no findings requiring a code change.** The three new pins are
present and RED, are behaviour-shaped (decision unions / rendered strings, not
implementation details), use the shared `test/factories/notification` factories
and an injected `now`, and their claim in ADR-0085 matches the design sections
cited.

Independent evidence (this review, worktree `t_fe5e3429`, head `35b317d`,
parent `f561370`):

- Targeted: `./node_modules/.bin/vitest run --project unit apps/web/src/server/notifications`
  → `2 failed | 5 passed (7)` files, `378 passed`. Both spec files fail
  collection with `Cannot find package '@/server/notifications/resolve-channel'`
  and `...render-template'` — new-module RED, the intended reason.
- Full: `./node_modules/.bin/vitest run --project unit` → `2 failed | 75 passed (77)`
  files, `1394 passed` — identical to the pre-existing baseline; no regressions.
- `git diff --name-only f561370..35b317d` → exactly the two `*.test.ts` files and
  ADR-0085. No production code; no file under
  `apps/web/src/server/notifications/` touched other than the two specs.
- `prettier --check` and `eslint` clean on the changed files.

What the new pins hold:

1. **U24** — non-critical type with `respectQuietHours: false`, quiet hours
   enabled (`22:00–07:00` `Asia/Kolkata`), `now` = `2026-10-05T18:00:00.000Z`
   (23:30 IST, inside the crossing-midnight window) → `{kind:"send", channel:"email"}`.
   U15/U16 are intact, so the switch is pinned against a deferring control and a
   critical-bypass control.
2. **U25 / U25b** — `mobile` group, `whatsappCapable: true`, a `whatsapp`
   suppression falls through to `sms`; suppressing both candidates yields
   `{kind:"skip", reason:"suppressed"}` (design §5 lines 269–270; ADR-0085
   assumption 2 no longer unpinned). The card's two-case ask was split into two
   tests, one behaviour each; the U-ID set is U24–U26 as the card requires.
3. **U26** — an interpolated subject value containing `<script>`/`&` renders
   escaped (`not.toContain("<script>")`, `toContain("&lt;script&gt;")`,
   `toContain("&amp;")`), mirroring U18's body assertions (ADR-0085 assumption 5
   and the escaping bullet now cover subject + body).

The RED branch (PR #185) stays an **unmerged draft** by design: its CI is red
because the pinned modules do not exist yet, and the pins ship inside the GREEN
PR (the OP-92 pattern, PR #182). Merging RED would turn `main`'s unit CI red.

## Consequences

- GREEN cannot ship `respectQuietHours` handling, the mobile suppression
  fallback, or subject escaping untested.
- ADR-0085's assumption list is accurate: the previously-flagged gaps 2 and 5
  now point at real pins.
- No refactor was performed — there is no production code in this delivery.

## Alternatives considered

- **Merge PR #185 so GREEN branches cleanly.** Rejected: the pins fail
  collection, so a merge reddens `main`'s unit CI.
- **Request changes for the U26 `&amp;` assertion being less specific than
  U18's `"Rahul &amp; Priya"`.** Rejected as a blocking item: the escaping of
  `&` is still pinned; the difference is a stylistic weakening, not a gap, and
  it does not affect GREEN's obligation.
