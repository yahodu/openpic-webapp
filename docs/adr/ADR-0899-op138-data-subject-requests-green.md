# ADR-0899 — OP-138 GREEN: data subject requests, consent history and policy acknowledgement

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_ab90931d` (OP-138 GREEN, phase 6-M2M — Jobs & Compliance, epic
  Compliance)
- **Branch:** `OP-138-task-dsr-consent-policy-green`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_a99f5cce`
- **Base:** the RED pin head `a7d848b6` (ADR-0898), itself based on `origin/main`
  `2b9579c7`.
- **Number allocation:** the lane block is `0898`–`0917` and its `Next free` cell
  read `0899` on the pin head. Re-swept immediately before committing: every
  `.worktrees/*/docs/adr` tree and `origin/main` `8e906318` carry no `ADR-0899`
  (the highest record anywhere is this lane's `0898`), and the open PR heads are
  #775 (this lane's sibling, still `0898`), #769 (this branch), #755, #743 and
  #272, all at or below `0898`. This record consumes `0899`; the lane's
  `Next free` cell advances to `0900`. No cell is lowered and no range is
  re-cut.

## 1. Context

ADR-0898 fixed the contract as executable tests and named six things the GREEN
must add: the pure rules module, the five route modules, the `compliance.slaDays`
and `legal` settings keys, the `dataSubjectRequests` collection registration,
the `invalid_scope` code with its transport, and the `compliance.dsr` rate class.
This card implements exactly that and edits no test, fixture or helper. The
pinned files from `a7d848b6` are carried unchanged: the unit spec (19 cases), the
integration spec (25 cases), the e2e spec (`E1`) and the two lane rows in
`rate-limit/classes.test.ts`.

## 2. Decision — what the GREEN adds

- `apps/web/src/server/compliance/data-request.ts` — `DSR_REGULATIONS`,
  `DSR_REQUEST_TYPES` (ten), `resolveRegulation`, `computeSlaDueAt`,
  `resolveAttendeeScope`, exactly as ADR-0898 §2 spells them.
- `apps/web/src/server/compliance/policies.ts` — the current document list
  (`terms_of_service`, `biometric_processing`) and the `sha256:` digest, read by
  both the public route and the acknowledgement route so a consent row and the
  published document can never name different versions.
- `apps/web/src/server/compliance/serialize.ts` — the ISO rendering of a stored
  instant, shared by the three reads so a list and a detail view cannot disagree.
- Five route modules: `me/data-requests` (`GET` + `POST`),
  `me/data-requests/[id]` (`GET`), `me/consents` (`GET`),
  `me/consents/acknowledge` (`POST`) and `legal/policies/current` (`GET`).
- `platformSettings.compliance.slaDays {gdpr, dpdpa}` (section-defaulted
  `{30, 30}`) and `legal.termsPolicyVersion` / `termsPolicyUrl` /
  `effectiveFrom` (field-defaulted, so a singleton seeded before these keys still
  parses).
- `COLLECTIONS.dataSubjectRequests`, `COMPLIANCE_ERROR_CODES = ["invalid_scope"]`
  with `COMPLIANCE_ERROR_TRANSPORT` (`422`, non-retryable) spread into the
  catalogue dispatch.
- `RateLimitClass` gains `compliance.dsr` in the union and
  `{scope: "user", limit: 5, windowSeconds: 86_400}` in the table; it is
  **not** in `FAIL_CLOSED_CLASSES` (ADR-0898 §4).

## 3. Decisions the pins leave open

1. **The filing route resolves its own principal.** `POST /me/data-requests`
   admits a user **or** an attendee, and §0.3 gives no single label both. A local
   auth stage resolves the principal, answers `401 unauthenticated` when there is
   none, runs the `user` rules with `allowBanned: true` for an account, and
   publishes the user id on `ctx.principal` so the 5/day budget keys on the
   principal rather than the IP (I5 sends a fresh IP per call).
2. **A user's scope is the events they created or still organize.** The negative
   user case is unpinned (ADR-0898 §6); the implementation reads
   `events.createdByUserId` and active `eventOrganizers` rows and refuses any
   other id as `422 invalid_scope` naming the offenders. An omitted or empty
   scope means "all of my data" and is stored as an empty scope.
3. **A request that resolves no tenant emits no outbox row.** `emitDomainEvent`
   requires a `tenantId`, and the platform-scoped filing (`E1`) has none. That
   case is pinned only for `202` and poll, so the route skips the emission rather
   than inventing a synthetic tenant (ADR-0898 §6's open question stays open).
4. **An attendee's subject is `{kind: "anonymous", attendeeSessionId}`**, the
   representation the `consents` rows already use; a user's is
   `{kind: "user", userId}`. `verifiedEmail` is neither recorded nor checked: the
   card's must-match rule is explicitly unpinned (ADR-0898 §6).
5. **`export` is `null` until OP-150.** Execution and export delivery are OP-150's,
   and the pinned cases only cover the null. This is marked in the route as a
   shortcut with its upgrade path.
6. **Consent rows are platform-scope.** An acknowledgement carries no event and no
   tenant, so it is written through `platformRepo` to `consents` with
   `subject.kind: "user"`, matching the collection the read returns.
7. **The caller country is read from the CDN headers** (`x-vercel-ip-country`,
   then `cf-ipcountry`). U1 pins the ladder, not the transport (ADR-0898 §6).

## 4. Evidence at this head

- `data-request.test.ts` **19 passed**; `rate-limit/classes.test.ts` **42 passed**.
- `data-subject-requests.test.ts` **25 passed** on a real `MongoMemoryReplSet`.
- Whole `unit` project: **191 files passed, 3206 passed | 3 skipped**, including
  the seven `adr-*` guards.
- Whole `integration` project: **153 files, 1618 passed**.
- `E1` **1 passed** against `node e2e/start-server.mjs` over a fresh
  `next build` (standalone output), with a real Better Auth session.
- `tsc -p apps/web/tsconfig.json --noEmit` and
  `tsc -p packages/contracts/tsconfig.json --noEmit` exit `0`; `eslint` 0 errors
  on the changed paths; `prettier --check` clean.

## 5. Corrections carried

ADR-0898 §5 gave the integration case count as **24** (`(24 cases from 15 it()
declarations)` and the inventory line `= 24`) while the same bullet's parts sum to
25 (13 singles + `I7`'s two + `I8`'s ten rows). The record and the README lane
note are corrected to **25** in this delivery; that closes the review's finding
F1. The review's F2 (the terms document's own version/URL/effective date are not
cross-checked against `platformSettings.legal`) stays with the follow-up card
`t_5f600bb4`, which this completion releases.

## 6. Consequences

ADR-0898 §6's contract debt is unchanged: contract §0.11 owes the
`compliance.dsr` row (with the `fail-open` policy this lane decides), Appendix A
owes `invalid_scope`, schema §20.4 owes `compliance.slaDays` and the three `legal`
keys, §8.1's list endpoint owes an envelope sentence, and §8.1 plus schema §20.3
owe the wider request-type union. Execution, the `admin.dsr.sla_risk` cron,
`privacy.export.ready` / `privacy.erasure.completed` delivery and page cursors
beyond the first page remain out of scope (OP-150 and later).
