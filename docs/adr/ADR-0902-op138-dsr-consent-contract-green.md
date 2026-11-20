# ADR-0902 — OP-138 GREEN: the DSR/consent storage contract the pin pack demands

- **Status:** Accepted
- **Date:** 2026-11-20
- **Card:** `t_0eab7a02` (OP-138 GREEN, High — implements the pin pack of the
  TEST card `t_df46c867` / [ADR-0901](ADR-0901-op138-dsr-contract-pins.md))
- **Branch:** `OP-138-feature-dsr-consent-contract`
- **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_0eab7a02`
- **Base:** `origin/main` `ecf4eb71` (the sibling pin `t_5f600bb4` /
  [ADR-0900](ADR-0900-op138-terms-document-pin.md), squash of PR #777)
- **Carried unchanged from the pin branch:** `b56fb34c`
  (`OP-138-task-dsr-contract-pins`, draft PR #778, **never merged**): the three
  §20.3 unit cases, the eleven integration cases, `COMPLIANCE_ERROR_CODES`'
  second member with its transport row, [ADR-0901](ADR-0901-op138-dsr-contract-pins.md)
  and its ledger row. The two hotspot files are unions: `data-subject-requests.test.ts`
  keeps main's `I7b`/`I7c` **and** the pack's `I16`–`I26` (measured `+58/−0`
  against `b56fb34c`, so neither block is rewritten), and
  `docs/adr/README.md` keeps main's `0900` row and the pack's `0901` row.
- **Pins:** schema §20.3 (`docs/Notification and Database Design.md:2041`) and
  §15.4 (`:1254`); contract §8.1 (`docs/API Contract.md:2840`) and §8.2 (`:2913`);
  [ADR-0898](ADR-0898-op138-data-subject-requests-red.md) §4/§6,
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) §3 and
  [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §2–§8.
- **Number allocation:** the OP-138 lane holds `0898`–`0917` and its `Next free`
  cell reads `0902` after the pin pack. This record takes **`0902`** and advances
  the cell to **`0903`**; no cell is lowered and no range is re-cut. The re-sweep
  read `origin/main` `ecf4eb71` (highest record `ADR-0900`), every
  `.worktrees/*/docs/adr` tree (`t_df46c867` holds `0901`; `t_7da4009d` holds
  `ADR-0918`, a later lane's first cut and outside this block), every open PR head
  (#779 `9d424e15` stops at `0900`, #778 `b56fb34c` at `0901`, #755 `c90ae3ba`,
  #743 `40df0afd`, #272 `d5be9af4` carry no `09xx`) and
  `git rev-list --objects --all -- docs/adr`, which resolves `ADR-0900` and
  `ADR-0901` only.

## 1. Context

The pin pack [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) measured five
groups of contract sentences the shipped OP-138 GREEN
([ADR-0899](ADR-0899-op138-data-subject-requests-green.md), PR #776) did not
honour, and kept two more green as characterization arms. Its pack is red by
design and was never merged; this card carries its files and makes them green
without editing a test, a fixture or a helper.

Measured on the pin head `b56fb34c`: `unit` `3 failed | 3206 passed | 3 skipped`
(the three §20.3 index pins) and `integration` `8 failed | 28 passed (36)` — the
reds exactly `I16`–`I20` and `I22`–`I24`, with `I21`, `I25` and `I26` green. On
this head the same two commands are `18 passed (18)` and `38 passed (38)`, and
`I21`/`I25`/`I26` never move: they are the control that the repair is targeted,
not a rewrite of the arms they characterize.

## 2. Decision — the three §20.3 indexes are declared, and `consents` stays out of scope

Schema §20.3 requires `{"subject.userId":1, receivedAt:-1}`, `{status:1,
slaDueAt:1}` partial on the open statuses and `{regulation:1, status:1}`. All
three are declared in `INDEX_SPECS` under one commented block
(`dataSubjectRequests_subject_received`, `dataSubjectRequests_status_sla_open`,
`dataSubjectRequests_regulation_status`), so `ensureIndexes` creates them in every
environment and `GET /me/data-requests` stops being a collection scan with a
blocking sort behind a `subject.userId` filter.

- **The partial filter is encoded exactly as the pin states it** —
  `{ status: { $in: ["received", "verifying", "in_progress"] } }` — because §20.3
  leaves the encoding as prose and the pin fixes it.
- **`dataSubjectRequests` is platform-scope** and is not added to
  `TENANT_SCOPED_COLLECTIONS`: a request belongs to its data subject, names its
  tenants in `scope.tenantIds`, and is never read by a tenant. The U1
  tenant-prefix lint therefore has no lead to violate, which the block's comment
  states so a later reader does not "fix" a non-defect.
- **`consents` gains no index in this card.** That collection has no `INDEX_SPECS`
  entry at all (§15.4's trio is not declared) and no pin in this pack demands one,
  so declaring it would be untested speculative work; a follow-up lane that reads
  consent history at scale should pin the trio first.

## 3. Decision — `scope.tenantIds` is stored as `ObjectId[]`, like `scope.eventIds`

The row stored one array as `ObjectId`s and the other as hex strings, so every
reader had to coerce exactly one of the two. `tenantIds` is now built through the
same `eventObjectIds` helper `eventIds` uses, and the hex form survives only where
`emitDomainEvent` needs a string `tenantId` (`tenantId.toHexString()`). The
response shape is unchanged; `I16` compares both arrays and asserts the stored
representation. A side effect is honest: an event that carried no resolvable
`tenantId` no longer contributes the literal string `"undefined"` to the scope.

## 4. Decision — the acknowledgement stores §15.4's evidence and §8.2's row is served

The write path now stores, on the `consents` row:

- `evidence` from the shipped `buildConsentEvidence` — `{ ipHash, uaHash,
method, locale }`, where the address and agent are salted SHA-256 digests
  (§0.15: never a raw IP or user-agent) and `locale` is `parseLocale`'s served
  tag. The builder gained one optional `method` (`"checkbox" |
"in_app_action"`), defaulting to `"checkbox"`, so the attendee surface's
  contract (§6.2) and its unit spec are untouched and this path passes
  `"in_app_action"`.
- `eventId: null` — the in-app acknowledgement is platform-scope and names no
  event.
- `policyUrl` and `method`, **stored at write time**. A read-time derivation from
  the current-policy list would silently strip the URL from a row acknowledged
  before a `legal.terms.updated` rotation, which is exactly what such a record
  exists to refute; the follow-up pin `t_48e4b3a2` measures that rotation.

`GET /me/consents` answers §8.2's nine keys — the eight documented plus the
`policyDocumentHash` its prose keeps: `id`, `purpose`, `policyVersion`,
`policyDocumentHash`, `policyUrl`, `eventId`, `method`, `grantedAt`,
`withdrawnAt`. `policyUrl`, `eventId` and `method` are nullable in the schema and
read as `null` for a row written before the field existed (a biometric grant,
whose `eventId` is a real id), so the route never fails on its own history.

## 5. Decision — `verifiedEmail` must match the caller's verified address

`createBodySchema` accepts an optional `verifiedEmail` (§8.1's request example;
schema §20.3's subject). When it is present it must equal the caller's verified
address — read from the Better Auth `user` document with `emailVerified: true`,
through `platformRepo` — and the mismatch is `422 invalid_verified_email` with
`details { field: "verifiedEmail" }`, the repo's singular one-field refusal shape.
A refusal writes no row and emits no event.

An anonymous session has no verified email at all, so any `verifiedEmail` it
sends is a mismatch (`I22`). An **omitted** field is never checked and is never
written: the key is omitted from the subject rather than stored as `undefined`,
which the driver would serialize as `null` and which would red `I21`.

## 6. Decision — the data subject reads its own row, whatever credential filed it

`GET /me/data-requests/{id}` now shares the create route's principal stage
(`_lib/principal.ts`: `user` or `attendee`, `401 unauthenticated` for neither,
§0.3's ban exemption for a user) and resolves the owner from the credential: a
user's row is `{ "subject.kind": "user", "subject.userId" }`; an anonymous
session's row is `{ "subject.kind": "anonymous", "subject.attendeeSessionId" }`.
Every other credential — including a different attendee session — is
`404 not_found`, never `403`, so the endpoint is not an existence oracle. The
`pollUrl` a `202` named therefore works for the caller that received it, and the
counted `executionLog` is readable by that caller.

## 7. Decision — the two characterization arms are untouched

`I25` (a repeated acknowledgement answers `201` twice and appends a second history
row) and `I26` (a tenantless platform-wide filing answers `202` and writes no
`domain_events` row) were green on the pin head and are green here. Nothing in
this GREEN makes the first idempotent or emits an event for the second; both
remain the shape ADR-0899 §3 recorded.

## 8. Evidence — measured on this head

- **The pinned specs:** `indexes.test.ts` `18 passed (18)` from `3 failed | 15
passed`; `data-subject-requests.test.ts` `38 passed (38)` from `8 failed | 30
passed` — the eight reds gone, `I7b`/`I7c` and the three characterization arms
  green throughout.
- **The full suites:** `unit` `191` files, `3209 passed | 3 skipped` (the seven
  `adr-*` guards included); `integration` `153` files, `1631 passed`.
- **Gates:** `tsc -p apps/web` and `tsc -p packages/contracts` exit `0`;
  `eslint` reports 0 errors on every changed file (the two
  `security/detect-object-injection` warnings in `indexes.ts` are in
  `ensureIndexes`, outside this diff); `prettier --check` clean.
- **Honesty:** no test, fixture or helper is edited beyond carrying the pin files,
  and the carried files are byte-identical to `b56fb34c` (`+75/−0` in
  `indexes.test.ts`, `+333/−0` in `data-subject-requests.test.ts` against
  `dcb80d31`; the union adds only main's `I7b`/`I7c`). No skip/only, no
  environment conditional, no lint suppression.

## 9. Assumptions and residuals

- **The list route stays user-only.** The pins measure reading back a `pollUrl`,
  not an attendee list contract, so `GET /me/data-requests` still requires `user`.
- **`consents`' §15.4 index trio is out of scope** (§2), and recorded here so the
  omission is a decision rather than an oversight.
- **`verifiedEmail` is compared verbatim**, case included: the address is an
  identity a client repeats from its own profile, not a contact to canonicalize.
- **The acknowledgement's `201` receipt is unchanged** (six keys); §8.2's wider
  shape is served by the history read the contract documents.

## 10. Consequences

A DSR read is index-supported and its tenants are stored in one representation; a
consent record now carries the evidence §15.4 requires, the document URL it
acknowledged and the platform-scope `eventId`; a filing that names an address must
name the caller's own; and an anonymous attendee can read back the request its own
receipt pointed at. The three follow-ups the pins' review routed stay with their
own cards: `t_48e4b3a2` (the stale-version `policyUrl` pin), `t_e2a23faa` (the
ADR-0901 §9 count) and the OP-138 docs debt ADR-0898 recorded.

## Alternatives

- **Derive `policyUrl` at read time** from `currentPolicies` — passes the pinned
  case and loses the URL on every rotation. Rejected (§4).
- **Patch `scope.tenantIds` in the reader** instead of the writer — leaves the
  collection with two representations forever. Rejected (§3).
- **Answer `403` for another attendee's request** — turns the endpoint into an
  existence oracle. Rejected (§6).
- **Declare `consents`' §15.4 index trio too** — untested in this pack; recorded
  as a follow-up instead (§2).
