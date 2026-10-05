# ADR-0067 — OP-91 RED: sessions & devices and the account-deletion cancel window

- **Status:** Accepted · **Date:** 2026-10-05 · **Author:** `openpic-webapp-testcase-writer`
- **Card:** `t_754b0fc5` (OP-91, phase 1-Identity) · **Stage:** RED (tests only; no production code)
- **Contract under test:** API contract §1.3 (Sessions & devices), §1.4 (Account deletion), §0.15 (never-return), Appendix A.2 · schema §13.1 (`session`), §13.2 (`userProfiles`), §20.4 (`platformSettings`) · CONVENTIONS §1 (TDD RED), §2 (pyramid), §6 (no hard-coded tunables)
- **Branch:** `OP-91-task-sessions-account-deletion`

## Context

OP-90 completed the `GET`/`PATCH /me` projection. OP-91 adds the two
security surfaces the card names:

1. **Sessions & devices** (§1.3): list the caller's sessions, revoke one by id,
   revoke-all with `keepCurrent`.
2. **Account deletion** (§1.4): an irrevocable request with a grace window, and
   a cancel inside that window.

The card fixes the RED test list (U1–U2, I1–I6, E1). Writing them surfaced four
contract parameters the card leaves implicit and that the implementation cannot
guess without pinning. This ADR records the choices so the GREEN agent inherits
them; per CONVENTIONS §10 the API contract and schema win where they speak, and
the `docs/adr/README.md` numbering may be re-allocated by the orchestrator.

## Decision

### 1. Module and route contract

| Surface | Path                                          | Expected export                                                                                     |
| ------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unit    | `@/server/me/sessions`                        | `mapUserAgentToDeviceLabel(userAgent: string \| null \| undefined): string`                         |
| Unit    | `@/server/me/deletion`                        | `computeDeletionScheduledAt(now: Date, settings: { account: { deletionGraceDays: number } }): Date` |
| Route   | `app/api/v1/me/sessions/route.ts`             | `GET` → `200 { data: SessionSummary[] }`                                                            |
| Route   | `app/api/v1/me/sessions/[sessionId]/route.ts` | `DELETE` → `204` \| `404 not_found`                                                                 |
| Route   | `app/api/v1/me/sessions:revoke-all/route.ts`  | `POST { keepCurrent: boolean }` → `204`                                                             |
| Route   | `app/api/v1/me/deletion/route.ts`             | `POST { reason?, confirmEmail }` → `202`; `DELETE` → `204` \| `409 deletion_already_executed`       |

All four routes are guarded with the `user` label. The colon segment
(`sessions:revoke-all`) is the contract's literal path; a colon in a module
specifier resolves under both the Vite `@/` alias and `tsc` (verified with a
throwaway probe before writing the spec).

`SessionSummary` = `{ id, current, deviceLabel, ipCountry, createdAt,
lastActiveAt, expiresAt }`. Raw `ipAddress`, `userAgent`, the session `token`
and the owning `userId` are never returned (§0.15).

### 2. `deviceLabel` detection table

The browser is detected **before** the operating system, because Edge and
iOS-Chrome agent strings also carry `Chrome`/`Safari` tokens. The pinned labels
(U1) are:

| Agent                         | Label                |
| ----------------------------- | -------------------- |
| Chrome / macOS                | `Chrome on macOS`    |
| Safari / macOS                | `Safari on macOS`    |
| Chrome / Windows              | `Chrome on Windows`  |
| Firefox / Windows             | `Firefox on Windows` |
| Edge / Windows                | `Edge on Windows`    |
| Chrome / Android              | `Chrome on Android`  |
| Safari / iOS                  | `Safari on iOS`      |
| Chrome / iOS (`CriOS`)        | `Chrome on iOS`      |
| unrecognised / empty / absent | `Unknown device`     |

`Unknown device` is the safe degradation: the raw agent is never echoed.

### 3. The deletion grace window is `platformSettings.account.deletionGraceDays`

§1.4 quotes "now + 14 days", but CONVENTIONS §6 forbids a hard-coded tunable and
§9.10 declares that every number in the contract is read from
`platformSettings`. ADR-0008 already names an additive `account.deletionGraceDays`
section. RED therefore pins that the schedule is computed from that setting:
integration I5 seeds a **non-default** value (7 days) and asserts the returned
`scheduledAt` is 7 days out, so a hard-coded 14-day offset fails. The implementer
adds `account: { deletionGraceDays: number }` to `platformSettingsSchema` and
`PLATFORM_SETTINGS_DEFAULTS` (default 14).

### 4. "Purge has started" = a pending profile past its scheduled instant

I6 pins `409 deletion_already_executed` for a `userProfiles` row with
`status: "deletion_pending"` and `deletionScheduledAt` in the past — exactly the
predicate the `account-deletion-purge` cron acts on (§10.2,
`deletion_pending` and `deletionScheduledAt < now`). Because the guard denies
`deletion_pending`/`deleted` with `403` (`evaluateAuth`), the deletion-cancel
route must exempt that status (an `allowDeletionPending` flag mirroring
`GET /me`'s `allowBanned`) for the §1.4 cancel window to exist at all. This is
called out in the spec header and is the implementation's to wire.

### 5. New error codes

`confirmation_mismatch` (422, `details.field`, Appendix A.2) and
`deletion_already_executed` (409, §1.4) are named by the contract but are not
yet members of `API_ERROR_CODES` / `ERROR_CATALOG`. The implementer appends them
in their own append-only set + transport table, matching the `unknown_timezone`
/ `forbidden_field` precedent.

### 6. Review round 2 amendments (t_754b0fc5, 2026-10-05)

The round-1 reviewer reproduced the RED claims and required one spec fix plus
three follow-ups, all inside `me-sessions-and-deletion.test.ts`. They are pinned
here so the GREEN implementer inherits the final contract:

1. **Order-independent self-revoke (required).** I2 selected
   `(await sessionIds(revokeCookie))[0]`, but §1.3 fixes no list order, so an
   oldest-first result would pick _keepCookie_'s session and make the next
   `listSessions(keepCookie)` assertion fail for the wrong reason. The spec now
   selects `(await listSessions(revokeCookie)).find((s) => s.current)?.id` and
   additionally asserts the id is visible to `keepCookie` before deletion.
2. **`account.sessions.revoked` is pinned as an observable outcome.** The
   emission is OP-89's `handleSessionsRevoked` hook (ADR-0040 §4), reached
   through the injectable seam `createIdentityLifecycleSeams().sessionsRevoked`
   (ADR-0043 §3); the OP-91 route must not emit directly. I3 therefore asserts
   that a `domain_events` row with `eventKey: "account.sessions.revoked"` and
   `subjectRef.id` equal to the caller's user id exists after revoke-all — a
   route that deletes session documents itself, bypassing the seam, fails.
   Severity was downgraded to Low–Medium because the primary end-to-end pin
   lives in OP-89's RED-pins card (`t_eb12bb8a`); the assertion here is the
   cheapest way to keep the two lanes honest at the OP-91 boundary.
3. **`keepCurrent: false` is now covered.** A second I3 spec signs in twice,
   revokes all with `keepCurrent: false`, and asserts neither session can
   authenticate (401) — i.e. the caller's own session is revoked too.
4. **The dead phone fixture is gone.** `makeIdentity().phone` carried an
   invalid `+919****0000…` value and was read nowhere; the field was dropped.

## Consequences

- The RED suite is 2 unit files (`sessions.test.ts`, `deletion.test.ts`), 1
  integration file (`me-sessions-and-deletion.test.ts`, I0–I6) and 1 Playwright
  spec (`me-deletion.spec.ts`, E1). Every spec fails against `main` because the
  modules, routes and error codes do not exist — the intended red state.
- `ipCountry` is acceptable as `null`: there is no geo resolver in the codebase,
  and §1.3 only forbids returning the raw IP. The test asserts the key exists
  and is `null` or a string, never the raw `ipAddress`.
- 204 responses flow through `defineRoute`, whose `jsonResponse` cannot attach a
  body to a null-body status; the implementer needs a no-content path in the
  pipeline. The specs assert status only, so any correct mechanism is accepted.
- The integration spec signs in repeatedly for one identity (up to 3 times),
  staying under the `auth.otp` contact limit of 5/hour; each identity gets a
  distinct IP.

## Alternatives considered

- **Pin a hard-coded 14-day window** — rejected: contradicts CONVENTIONS §6 and
  leaves the setting unwired.
- **Read `dunning.gracePeriodDays` for the deletion window** — rejected: that is
  the billing dunning clock (schema §14.3), a different concept; ADR-0008 names
  `account.deletionGraceDays`.
- **Model "purge started" as `status: "deleted"`** — rejected: `deleted` is the
  state after the purge finishes, and the cron's own predicate is
  `deletionScheduledAt < now`. The past-scheduled pending state is the more
  faithful pin; the guard exemption is required either way.
