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

## Review — round 1

Sign-off card `t_62d6ef86` records the round-1 (artifact lens) review of the GREEN `t_ab90931d` (PR [#776](https://github.com/yahodu/openpic-webapp/pull/776)). The reviewed head is `a6961a03` (the delivery head) plus the reviewer's refactor commit `bcaff2ed`, which is the PR head that merged; the squash is `91644603`. The suite figures are the review's own runs at `bcaff2ed`; the landing, blob and ledger facts are this sign-off's re-measurement at the base it lands on.

- **Verdict: `APPROVED WITH FINDINGS`**, landed. No blocker and no changes requested: all seven findings are routed, and every one of them is covered by the follow-up pin pack [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) — five as new behaviour and two (`F5`, `F6`) as characterization.
- **Independent verification at `bcaff2ed`.** Focused `data-request` **19 passed**, `data-subject-requests` **25 passed**, `rate-limit/classes` **42 passed**; whole `unit` **191 files, 3206 passed | 3 skipped**; whole `integration` **153 files, 1618 passed**; `tsc -p` exit `0` on `apps/web` and `packages/contracts`; `eslint` **0 errors** on the changed paths (the one `security/detect-object-injection` warning in `catalog.ts` is pre-existing); `prettier --check` clean; CI at that head green, `ci` **pass** including E2E.
- **No test, fixture or helper was edited by the delivery.** `git diff --name-only a7d848b6 bcaff2ed` lists no `*.test.ts`, `test/`, fixture or `e2e/` path.
- **Number and ledger at review time.** `ADR-0899` was unique across `origin/main`, every `.worktrees/*/docs/adr` tree and every open PR head, and the OP-138 lane cell read **`0900`** at both `bcaff2ed` and the squash `91644603`. On the base this section lands on (`origin/main` `49a8226a`) the cell reads **`0908`**, advanced by the follow-up records below; no cell was lowered here and this sign-off mints no number.
- **Refactor made by the review, carried in the squash (`bcaff2ed`).** The delivery added `policyDocumentHash` to `@/server/compliance/policies` but left a byte-identical private copy in `apps/web/src/app/api/v1/p/events/[slug]/consent/route.ts`; the route now imports the shared helper (`+1/−18`, no behaviour change — whole `unit` `3206 | 3` and whole `integration` `1618` re-run green before and after, `tsc`, `eslint` and `prettier` clean).

### Findings and routing

Seven findings beyond the pinned criteria, all routed on the review's completion to the TEST pin pack `t_df46c867` ([ADR-0901](ADR-0901-op138-dsr-contract-pins.md); PR #778, red by design and never merged) and its gated GREEN `t_0eab7a02` ([ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md); carried in PR #781, squash `50a5e56f`).

- **F1 — Medium — schema §20.3's three `dataSubjectRequests` indexes are undeclared.** The GREEN registered the collection and declared no index, so every read is a collection scan. Pinned by ADR-0901's three unit cases and declared in ADR-0902's `INDEX_SPECS`; the attendee's own list gained a fourth index in the later pair [ADR-0906](ADR-0906-op138-dsr-attendee-index-red.md) / [ADR-0907](ADR-0907-op138-dsr-attendee-index-green.md) (PR #789 / #790).
- **F2 — Medium — `verifiedEmail` is silently stripped and never matched**, against contract §8.1, schema §20.3 and the card's must-match rule. Pinned by ADR-0901's `I19`–`I22` and implemented in ADR-0902 (`422 invalid_verified_email`, omitted rather than stored as `undefined`); the case-variant comparison is pinned by [ADR-0903](ADR-0903-op138-verified-email-case-pin.md) (PR #784).
- **F3 — Medium — the acknowledgement records no §15.4 `evidence`, and `GET /me/consents` omits §8.2's `policyUrl`, `eventId` and `method`.** Pinned by ADR-0901's `I17`/`I18` and implemented in ADR-0902: salted `ipHash`/`uaHash`/`method`/`locale` evidence, plus `policyUrl` and `method` stored at write time so a policy rotation cannot strip them. The rotation itself stays with the blocked card `t_48e4b3a2` (number `0904` reserved, not minted).
- **F4 — Medium — an anonymous attendee's `pollUrl` answered `401`/`404` to the very session that filed it.** Decided and routed by `t_4fdff479` and delivered by the receipt lane `t_b8e9aa3d` / `t_84c1b83e` ([ADR-0905](ADR-0905-op138-dsr-attendee-receipt.md), PR #786 squash `8f45462b`), with ADR-0901's `I23`/`I24` pinning the read-back and the foreign-session `404`.
- **F5 — Low — a tenantless filing emits no `privacy.dsr.received`** (characterization of §3 item 3; it needs a pinned decision plus a contract qualification). Characterized by ADR-0901's `I26`; the route still skips the emission at `apps/web/src/app/api/v1/me/data-requests/route.ts:287`.
- **F6 — Low — a repeat acknowledgement writes a second row** (unpinned semantics). Characterized by ADR-0901's `I25` and unchanged by ADR-0902.
- **F7 — Low — `scope.tenantIds` is stored as hex strings beside `ObjectId` `eventIds`**, and `I9`'s `asId` hid it. Pinned by ADR-0901's `I16` and fixed by ADR-0902, which stores it as `ObjectId[]` through the same helper as `scope.eventIds`.

### Nothing retracted, and what followed

No decision of §1–§6 is retracted or amended. This section only appends and the reviewed bytes stand: this record's blob is `7f413943` at `bcaff2ed`, at the squash `91644603` and at the base it lands on (`origin/main` `49a8226a`), and `docs/adr/README.md` stays byte-identical to that base (blob `2d7d546`).

The follow-ups' own records document what followed: the pin pack [ADR-0901](ADR-0901-op138-dsr-contract-pins.md), the GREEN [ADR-0902](ADR-0902-op138-dsr-consent-contract-green.md), the case-variant pin [ADR-0903](ADR-0903-op138-verified-email-case-pin.md), the attendee receipt [ADR-0905](ADR-0905-op138-dsr-attendee-receipt.md) and the attendee index pair [ADR-0906](ADR-0906-op138-dsr-attendee-index-red.md) / [ADR-0907](ADR-0907-op138-dsr-attendee-index-green.md). Number `0904` stays reserved to the blocked rotation-pin card `t_48e4b3a2`, and no cell of `docs/adr/README.md` is edited here.
