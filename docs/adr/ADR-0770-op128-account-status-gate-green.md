# ADR-0770 — OP-128 follow-up GREEN: the account-status gate on the media signer

- **Status:** Accepted — the pins of [ADR-0768](ADR-0768-op128-account-status-gate-pins.md) are green
- **Date:** 2026-11-12
- **Ticket:** OP-128 — _batch signed media URL refresh_, phase 4 (Uploads & Media), epic Media
- **Card:** `t_658f8a67` (GREEN follow-up of round-1 finding **F1**, High), worktree
  `/root/openpic/openpic-webapp/.worktrees/t_133a4093`, branch
  `OP-128-bug-account-status-gate-green`, cut from the pins branch
  `OP-128-task-account-status-gate-pins` at `29a4c8c`
- **Consumes:** contract §5.6, §0.3, §0.4, §0.15; ADR-0025 (the auth guard table), ADR-0764
  (the endpoint's assumptions), ADR-0766/ADR-0767 (the endpoint's contract and implementation),
  ADR-0768 (F1's contract and pins)
- **Supersedes:** nothing; **amends** ADR-0767's route by adding the `user` label's account-status
  rule to the handler

## Context

ADR-0768 pinned the hole and prescribed the fix; this record is the implementation. The route
`apps/web/src/app/api/v1/media/signed-urls/route.ts` is `public`-labelled (ADR-0766 D3) and calls
`resolvePrincipal` in its handler, so the `user` label's `evaluateAuth` table never ran. Measured on
the pins branch: a **suspended** event organizer received `200` with a signed thumbnail **and** a
signed original, while every other authenticated endpoint refuses that principal.

## Decision

### D1 — the gate is the `user` label's own table, applied once per request

After `resolvePrincipal`, the handler asks `evaluateAuth("user", { principal, now: systemClock.now() })`
and, on a denial, throws `appError("forbidden")` before any scope, image or asset read. One table means
a rule added for every authenticated endpoint lands here too; no inline status list is copied. The
clock is the runtime port (`@/server/runtime/clock`) as in `requireAuth`, so a ban boundary is exact.

| Principal fact (`resolvePrincipal`)                           | `evaluateAuth("user", …)`                                     | Wire answer                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| no credential                                                 | not asked — the gate is on `principal.kind === "user"`        | `200` with `denied[] authentication_required` (I6, unedited) |
| `userProfiles.status = "suspended"`                           | `account_suspended`                                           | `403 { error: { code: "forbidden" } }`                       |
| `userProfiles.status = "deletion_pending"` / `"deleted"`      | `forbidden`                                                   | `403 { error: { code: "forbidden" } }`                       |
| Better Auth `user.banned` with an unexpired `banExpires`      | `account_banned`                                              | `403 { error: { code: "forbidden" } }`                       |
| expired ban, or `status = "active"`, `platformRole` any value | allowed (the `user` label adds no completion or role rule)    | the per-item answer, unchanged                               |
| `attendee` principal (OP-129)                                 | not asked — an attendee session has no account status to read | unchanged (ADR-0768 O2)                                      |

The guard's own codes (`account_suspended`, `account_banned`, `forbidden`) are **not** on the §5.6
wire vocabulary, so the route maps every denial to the §5.6 `forbidden` (ADR-0768 D1). The detail
(`supportUrl`, `banReason`, `banExpires`) stays on `GET /me` (§0.3).

### D2 — the refusal is the whole request, at the route boundary

An account-level refusal denies every item, so `signedUrlBatchStatus` would collapse the all-denied
batch to the same `403` (ADR-0768 D2). Refusing at the boundary emits that wire answer without
computing decisions, and is the smaller change. The per-item table is untouched and stays the only
place that judges an item.

### D3 — no read is added

The status and the ban fields are already projected by `resolvePrincipal`, so the gate costs no
query. I5's `reads(200) === reads(2)` holds (measured below).

## Evidence

Gates, all on branch head `OP-128-bug-account-status-gate-green` over `29a4c8c`:

- **RED before the fix:** focused integration `media-signed-urls.test.ts` → `4 failed | 17 passed
(21)`, each failure `AssertionError: expected 200 to be 403 // Object.is equality` (suspended,
  deletion_pending, banned, suspended matched attendee).
- **GREEN after the fix:** the same file → `21 passed (21)`; focused unit
  `media-signed-urls-authorization.test.ts` → `24 passed (24)`, unedited.
- **Query budget:** I5 (inside the 21) still passes, so the gate spent no read.
- **Full suites:** unit `157 files / 2526 passed | 3 skipped`; integration `104 files` green — the
  counts ADR-0767 recorded, with the six I7 cases added.
- **Static:** `tsc -p apps/web/tsconfig.json --noEmit` exit `0`; ESLint 0 errors and
  `prettier --check` clean on the touched file; the `adr-numbering` guard green.
- **Diff:** `route.ts` only (`+14/−1`: two imports, the gate, one docblock sentence), this record and
  the ledger. Route `sha256` moves from `985f2d95…` (ADR-0768) to `ae0fa71f…`. **No test, mock,
  fixture or factory is edited.**

## Consequences

- **O1 — one behaviour, one table.** If a future account state must be exempt (as `GET /me` and the
  deletion-cancel route are), it belongs in `GuardFacts`, not in this route.
- **O2 — the wire still cannot say "suspended"** (ADR-0768 O1): clients learn `forbidden` for every
  account-state refusal.
- **O3 — the `media.sign` rate class, malformed-scope fallbacks and stale `ADR-0764`/`ADR-0765` doc
  comments** are other cards' (`t_8b3f316e`, `t_f7437615`).
