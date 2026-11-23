# ADR-0901 — OP-138 TEST: the DSR/consent contract pins the round-1 review left unenforced

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_df46c867` (OP-138 TEST, Medium — the seven findings of the round-1
  review of the OP-138 GREEN `t_ab90931d`, PR [#776](https://github.com/yahodu/openpic-webapp/pull/776),
  squash `91644603`)
- **Branch:** `OP-138-task-dsr-contract-pins`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_df46c867`
- **Base:** `origin/main` `dcb80d31` (the `1.70.0` release chore on the GREEN
  squash `91644603`)
- **Pins:** schema §20.3 (`docs/Notification and Database Design.md:2041`) and
  §15.4 (`:1254`); contract §8.1 (`docs/API Contract.md:2840`) and §8.2 (`:2913`);
  [ADR-0898](ADR-0898-op138-data-subject-requests-red.md) §4/§6 and
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §3.
- **Number allocation:** the OP-138 lane holds `0898`–`0917` and its `Next free`
  cell reads `0900`. `0900` is **taken**: the sibling TEST card `t_5f600bb4`
  (the round-2 execution-lens review's F2, the terms-document pin) has committed
  and pushed `ADR-0900-op138-terms-document-pin.md` on
  `OP-138-task-dsr-terms-pin` (head `760b4f7d`), and that branch's own ledger
  already reads `Next free = 0901`. So this record takes **`0901`**, the next
  free number in the block, and advances the lane cell to **`0902`**; no cell is
  lowered and no range is re-cut. The sweep read `origin/main` `dcb80d31`
  (highest record `ADR-0899`), every `.worktrees/*/docs/adr` tree (only
  `t_a99f5cce` holds a `09xx`: the sibling's `0900`), every open PR head
  (#755 `40df0afd`, #743 `c90ae3ba`, #272 `d5be9af4`) and
  `git rev-list --objects --all -- docs/adr`, which resolves `ADR-0900` only and
  no `ADR-0901` object on any ref.

## 1. Context

The OP-138 GREEN satisfied every acceptance criterion the RED pinned, and its
review approved it. Seven findings sat **beyond** that pin set, so nothing in the
suite could see them: three Medium and four Low, measured on the delivered tree.
Each is a contract sentence the shipped code does not honour, and each would
otherwise be rediscovered later as a production defect rather than a red test.

This card is the measurement, not the repair. Its pack is **RED by design** on
five of the seven groups; its PR is a **draft** that must not be merged, and the
gated GREEN `t_0eab7a02` carries these files into its own PR unchanged. Two
groups are characterization pins (green on arrival) so a future change cannot
silently make the first idempotent or start emitting an event for the second.

Delivered: two appended spec blocks (three unit cases, eleven integration
cases), two append-only **contract declarations** (`COMPLIANCE_ERROR_CODES`'
second member and its transport row — not behaviour), this record and its ledger
rows. No existing case, helper or fixture is edited: `git diff --numstat` is
`+75/−0` in `indexes.test.ts` and `+333/−0` in
`data-subject-requests.test.ts`, so `I1`–`I15`, `U1`–`U3` and the two
`rate-limit/classes.test.ts` lane rows are byte-identical.

## 2. Decision — `invalid_verified_email` is a new append-only compliance code

Contract §8.1's request example carries `verifiedEmail`, schema §20.3's subject
is `{ kind, userId?, attendeeSessionId?, verifiedEmail }`, and the RED's brief
requires "verifiedEmail must match the caller's verified email when present".
The route's `createBodySchema` strips the field, so the delivered tree accepts a
mismatched address with `202` and stores nothing.

- **The code.** `COMPLIANCE_ERROR_CODES` becomes
  `["invalid_scope", "invalid_verified_email"]` (append-only, second member), with
  its own `COMPLIANCE_ERROR_TRANSPORT` row — `422`, non-retryable, safe message —
  and **not** an `ERROR_CATALOG` member, which `catalog.test.ts` pins to exactly
  the base Appendix A copy. The transport row is added by the pin pack because
  `TRANSPORT` is typed `Record<AppErrorCode, ErrorCatalogEntry>`: the enum member
  and its row are one compile-time unit, and adding only one would red `tsc` in
  every tree.
- **`details` shape.** `{ field: "verifiedEmail" }` — the repo's singular
  one-field refusal shape (`confirmation_mismatch` → `{ field: "confirmName" }`,
  `unknown_timezone` → `{ field: "timeZone" }`), not the plural `fields` array
  the Zod-driven `validation_failed` uses.
- **The three arms the pins measure.** A body whose `verifiedEmail` equals the
  caller's verified address → `202` **and** `subject.verifiedEmail` stored; a body
  whose address differs → `422 invalid_verified_email`, **no row and no outbox
  event**; an **omitted** field → today's behaviour, no check and nothing stored.
- **An anonymous session can never match.** An attendee has no verified email,
  so a body carrying one from an attendee session is a mismatch too — pinned, so
  the check cannot be implemented as "user only".

## 3. Decision — the three §20.3 `dataSubjectRequests` indexes

Schema §20.3 requires `{"subject.userId":1, receivedAt:-1}`, `{status:1,
slaDueAt:1}` partial on the open statuses and `{regulation:1, status:1}`. The
registry declares none of them, so the bootstrap creates none: `GET
/me/data-requests` — `sort({receivedAt:-1,_id:-1})` behind a `subject.userId`
filter — is a collection scan with a blocking sort, and OP-139's
`admin.dsr.sla_risk` sweep has no `{status, slaDueAt}` path.

- **The pins name the path, not the label.** Each case finds the declaration by
  **collection + keys** (and, for the SLA index, its partial filter) and asserts
  the exact key list, so a rename stays green while dropping, re-keying,
  moving or de-partialling a declaration turns the suite red. The alternative —
  pinning three literal index names — would have made the GREEN's naming choice
  a test-visible contract, which no reader of §20.3 can derive.
- **The partial filter is encoded literally** as
  `{ status: { $in: ["received", "verifying", "in_progress"] } }` — §20.3's open
  statuses, in the schema's own order. This is the one detail the document leaves
  as prose, so the pin fixes the encoding rather than leaving the GREEN to guess.
- **`dataSubjectRequests` stays platform-scope.** It is not (and must not become)
  a `TENANT_SCOPED_COLLECTIONS` member, so the U1 tenant-prefix lint has no lead
  to violate: a DSR names its tenants in `scope.tenantIds` and is read by its
  subject, not by a tenant.

**Satisfiability probe (reverted).** Adding the three specs to
`INDEX_SPECS` by hand turned the block green — `Tests 18 passed (18)` from `3
failed | 15 passed` — with no other case moving; the file was then restored with
`git checkout -- apps/web/src/server/db/indexes.ts` and `git status` shows only
the four delivered paths. That measure is the reason the partial-filter encoding
is stated literally: it is the one shape a GREEN could otherwise satisfy
differently.

## 4. Decision — the acknowledgement records §15.4 evidence, and §8.2's read is served

Schema §15.4 requires `evidence: { ipHash, uaHash, method, locale }` — "who, what
for, which version, when, and **how**" — and contract §8.2 spells the history as
`[{ id, purpose, policyVersion, policyUrl, grantedAt, withdrawnAt, eventId,
method }]`. The delivered acknowledgement stores none of it and the read answers
six keys.

- **`method` is `"in_app_action"`.** §15.4's union is `"checkbox" |
"in_app_action"`; the attendee surface already writes `"checkbox"`, and this
  acknowledgement is the action target of the `legal.terms.updated` in-app
  notification, so its method is the in-app one. Pinned on the **stored row**, not
  on a response body: the evidence is the record.
- **`ipHash` / `uaHash` are 64-hex salted digests.** The repo already ships the
  builder for the first two (`buildConsentEvidence`, §0.15's "never store or log
  a raw IP or user agent"), so the pin asserts the shape and the negative — the
  digest is not the raw forwarded address, the digest is not the raw
  `user-agent`. No re-derivation of the digest in the test, because the salt is a
  deployment value the spec does not own.
- **`locale` is a served tag.** The probe sends `accept-language: fr-FR,fr;q=0.9`
  and requires `"en-IN"` — today's only served tag — so a row storing the raw
  header verbatim reds, which is what "a stored tag is always one the product
  serves" means (§13.2's resolver).
- **`eventId: null` for this row.** The in-app acknowledgement is platform-scope:
  it names no event, and the pin says so rather than leaving `undefined`.
- **The read carries nine keys.** §8.2's eight plus the `policyDocumentHash` its
  prose keeps ("included so the record is verifiable years later"). The pin
  asserts the exact sorted key set, so the read cannot silently drop the hash it
  already serves while adding the three it lacks. `policyUrl` is pinned to the
  URL of the current document for that purpose (read from
  `GET /legal/policies/current`, the source §8.2 itself names), and `method` to
  the stored `"in_app_action"`.

## 5. Decision — a repeated acknowledgement appends history (characterization)

`POST /me/consents/acknowledge` has no idempotency stage, so two POSTs with the
current version write two rows. The pin fixes the **chosen** behaviour: the
second POST answers `201`, the two `id`s differ, both rows carry the same
`policyVersion`, and the history lists two rows. Consent records are evidence of
what was acknowledged when — an append-only log, not a mutable current state —
and the attendance surface already answered a repeated grant with a second row.
Green on arrival, kept green deliberately: a later "improvement" that quietly
made this idempotent (changing what the record proves) or started de-duplicating
(destroying an earlier acknowledgement) now reds a named case.

## 6. Decision — the attendee reads back the request its own receipt named

`POST /me/data-requests` answers an anonymous attendee `202` with
`pollUrl: /api/v1/me/data-requests/{id}`, but both read routes enforce
`requireAuth("user", …)` and filter `"subject.kind": "user"`, so the same
credential gets `401 authentication_required` from the URL the receipt handed it.

- **Ownership is the stored subject, not the credential class.** The pin requires
  the filing session to read its own row: `200`, `id` equal to the receipt's,
  and the stored `subject.kind === "anonymous"` with
  `subject.attendeeSessionId` equal to the session it filed from. The
  `executionLog` counts are visible to it — "we deleted 7 matches" is the point of
  the endpoint, and an attendee's erasure is no less theirs.
- **A different attendee session gets `404 not_found`, never `403.**` The test
  asserts the status exactly, because `403` would confirm the row exists and turn
  the endpoint into an existence oracle for an id another attendee's session was
  handed.
- **Residual, recorded rather than pinned:** the **list** route
  (`GET /me/data-requests`) stays user-only in this pack. The card's pin sentence
  covers reading back the row the receipt named, and the list's attendee shape
  (which rows a session may enumerate, and under which envelope) is a contract
  question §8.1 does not answer. A GREEN that widens the list as well is not
  reddened by these cases, and that is deliberate: the pin must not invent a
  list contract.

## 7. Decision — a tenantless filing emits no event (characterization)

Contract §8.1 says the create "emits `privacy.dsr.received`". `emitDomainEvent`
requires a `tenantId`, and a platform-wide filing by a user with no scope
resolves none, so the delivered route writes no `domain_events` row.
ADR-0899 §3 item 3 recorded that skip; this pin makes it measured: an unscoped
`portability` filing still answers `202`, stores the row with empty `tenantIds`
and `eventIds`, and writes **no** `domain_events` row. Green on arrival, kept
green.

**Contract debt:** §8.1's emission sentence is **conditional on a resolvable
tenant**. The contract edit stays out of scope here (routed, not made); until it
lands, this record is the decision of record: the skip is a measured decision,
not an accident.

## 8. Decision — `scope.tenantIds` and `scope.eventIds` are the same type

The create route stores `tenantIds` as hex **strings**
(`[...new Set(events.map((event) => String(event.tenantId)))]`) and `eventIds` as
**ObjectIds** (`eventObjectIds(eventIds)`). Integration case `I9` hides the
mismatch behind its own `asId` coercion. The pin asserts both arrays' elements
are `ObjectId`s while keeping the value assertions the shipped case already
makes, so a reader never has to coerce one array and not the other, and a second
writer cannot reintroduce the asymmetry without a red case. The hex form stays
where a string is needed (`emitDomainEvent`'s `tenantId`, the outbox payload);
only the stored column is pinned.

## 9. Evidence — measured on `origin/main` `dcb80d31`

`origin/main` is the GREEN squash `91644603` plus the `1.70.0` release chore
(`CHANGELOG.md`, `package.json` only), so the pins are measured against exactly
the tree the review approved.

| Group | What it pins                                                 | Where                                 | Result                                                          |
| ----- | ------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------- |
| 1     | §20.3's three `dataSubjectRequests` indexes                  | `indexes.test.ts` (+3 cases, 15 → 18) | **3 red** / 15 green                                            |
| 2     | `scope.tenantIds` typed like `scope.eventIds`                | `I16`                                 | **red** (`expected false to be true`)                           |
| 3     | §15.4 `evidence` on the acknowledgement row                  | `I17`                                 | **red** (`expected undefined to be 'in_app_action'`)            |
| 3     | §8.2's `policyUrl` / `eventId` / `method` on the history row | `I18`                                 | **red** (6 of 9 keys; 5 of §8.2's eight + `policyDocumentHash`) |
| 4     | a repeated acknowledgement appends history                   | `I25`                                 | **green** (characterization)                                    |
| 5     | a matching `verifiedEmail` is stored                         | `I19`                                 | **red** (`expected undefined to be 'i19-…@example.com'`)        |
| 5     | a differing `verifiedEmail` → `422 invalid_verified_email`   | `I20`                                 | **red** (`expected 202 to be 422`)                              |
| 5     | an omitted `verifiedEmail` is not checked                    | `I21`                                 | **green** (characterization of today's behaviour)               |
| 5     | an attendee carrying `verifiedEmail` → `422`                 | `I22`                                 | **red** (`expected 202 to be 422`)                              |
| 6     | the filing session reads its own row and log                 | `I23`                                 | **red** (`expected 200 … received 401 authentication_required`) |
| 6     | a different attendee session → `404`, never `403`            | `I24`                                 | **red** (`expected 401 to be 404`)                              |
| 7     | a tenantless filing writes no `domain_events` row            | `I26`                                 | **green** (characterization)                                    |

Integration totals on the delivered tree: **`8 failed | 28 passed (36)`** — the
shipped 25 cases (`I1`–`I15`, `I8` being a ten-row `it.each`) all pass, the three
characterization arms pass, and the eight reds are exactly groups 2, 3, 5 and 6.
Unit totals on the same tree: `3 failed | 15 passed (18)` in `indexes.test.ts`,
and the whole `unit` project carries no other red (`adr-*` guards included).

Every red is an **assertion-level** failure with its own message — no `Cannot
find module`, no harness error — and the three green arms are the harness
control: the same file's auth, idempotency, rate-limit and Mongo setup carry the
green cases, so nothing in the reds can be a broken fixture. No near-fix probe
was run for groups 2, 3, 5 and 6: each arm is a production behaviour the gated
GREEN's card states verbatim, and re-implementing it to prove the pins go green
would have meant writing the GREEN's code in the pin branch.

Verification on the delivery head: `tsc -p apps/web/tsconfig.json --noEmit` exit
`0`, `tsc -p packages/contracts/tsconfig.json --noEmit` exit `0`, `eslint` 0
errors on the four touched paths (one pre-existing
`security/detect-object-injection` warning in `catalog.ts`, unchanged), `prettier
--check` clean, and the seven `adr-*` guards green.

## 10. Assumptions and open questions

- **`details: { field: "verifiedEmail" }`** is this record's choice among the
  repo's two field-error shapes (singular `field` for a hand-raised refusal,
  plural `fields` for a Zod refusal). The GREEN must emit exactly that shape; the
  next code that raises `invalid_verified_email` inherits it.
- **`locale` is pinned to `"en-IN"`** because it is the only tag the product
  serves today. If a second locale is served, this pin needs a widening decision,
  not a silent edit.
- **The SLA partial filter's `$in` encoding** is pinned literally; §20.3 says
  "partial on open statuses", and a future status union must be added in both
  places.
- **Index names are deliberately unpinned** (see §3); the indexes' _paths_ are
  the contract.
- **No contract text is edited** by this card, and none should be: §8.1's
  emission sentence, Appendix A's missing `invalid_verified_email` row and §8.1's
  list-envelope sentence are routed debt (§7, §2).
- **The ledger and one spec file are the lane's hotspot.**
  `apps/web/src/test/integration/data-subject-requests.test.ts` is appended to by
  two parallel OP-138 pin cards at once (this one and `t_5f600bb4`'s terms pin),
  and `docs/adr/README.md` carries both lanes' rows; both merge as a union
  keeping the higher cell.
- **Out of scope:** the `consents` collection's own §15.4 index trio (no entry
  today, not this pack's obligation), DSR execution and the admin queue (OP-150),
  the `admin.dsr.sla_risk` cron (OP-139), withdrawal's evidence, and any
  e2e/journey change.

## 11. Consequences

The gated GREEN `t_0eab7a02` makes eight of the eleven new cases green by
implementing five things — the three index declarations, the `ObjectId` scope
column, the evidence write plus §8.2's read keys, the `verifiedEmail` match (with
its new code already declared), and the owner-matched attendee read — and leaves
the three characterization arms untouched. A refactor that preserves those
behaviours breaks none of these cases; a regression in any one of them breaks
exactly the case that names it, with a message that says which sentence of §8.1,
§8.2, §15.4 or §20.3 came back.
