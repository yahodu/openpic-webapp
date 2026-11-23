# ADR-0910 — OP-140 precondition: `acknowledgeConsent` becomes a service, and `legal.terms.updated` still has no producer

- **Status:** Accepted (RED by design; the pins were red on the branch point because the
  module did not exist, and the GREEN sibling — PR
  [#830](https://github.com/yahodu/openpic-webapp/pull/830), squash `620e4bb9` — carries
  them unchanged).
- **Date:** 2026-11-23
- **Card:** OP-140 precondition (Low) `t_7ec513e9`, routed by `t_37ecac39` (the
  routing card of `t_b1bebbc8` / PR [#821](https://github.com/yahodu/openpic-webapp/pull/821)).
- **Branch:** `OP-140-task-precondition-consent-acknowledge`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/op140-precondition-consent-acknowledge`;
  **base:** `origin/main` `61579449`, read with `git log --oneline -1 origin/main`
  immediately before the branch was cut (the routing card measured `da4e24cc`;
  the two commits between them are PR #824 and its parent, neither of which
  touches this lane).
- **Pins:** contract §8.2 (`docs/API Contract.md`, the acknowledgement and the
  `policy_version_stale` refusal), schema §15.4 (`docs/Notification and Database
Design.md`, the `consents` document and its `evidence` block) and
  [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2/§4 — the
  contract §7.3 row `policy × acknowledge`, recorded there as **deferred**.
- **Consumes:** [ADR-0898](ADR-0898-op138-data-subject-requests-red.md) and
  [ADR-0899](ADR-0899-op138-data-subject-requests-green.md) (the route and the
  policies list this card moves behind a service),
  [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §5 (`I25`, the append-only
  characterization pin the service must not break),
  [ADR-0908](ADR-0908-op138-consent-policy-url-rotation-pin.md) and
  [ADR-0909](ADR-0909-op138-rotation-pin-labels-and-hash.md) (`policyUrl` and
  `policyDocumentHash` are row facts, which the document-shape pin protects), and
  [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §2 (the deferred
  row and its `acknowledgeConsent({db, userId, policyVersion, now})` sketch).
- **Consumers:** `apps/web/src/test/integration/consent-acknowledgement-service.test.ts`
  (the `S1`–`S7` / `R1`–`R2` cases; its docblock cites this record's contract).

## 1. Context

The OP-140 `policy × acknowledge` arm needs a callable unit that records a policy
acknowledgement: the notification action delegates to it the way `pay_now` and
`complete_mandate` delegate to theirs. On the branch point there is no such unit.
`apps/web/src/app/api/v1/me/consents/acknowledge/route.ts` is 115 lines and owns
the write end to end — it resolves the served document, refuses a retired
version, derives the §15.4 evidence from the request headers and inserts the
`consents` row at `:77`–`:101` — so a notification action would have to re-enter
an HTTP route or copy that write.

Two facts about the row's **producer** were measured by the routing card and are
re-measured here, because they decide how far this card can go (§3).

## 2. Decision

**One domain service, one home, and a route that becomes a thin delegate.**

- **Home:** `apps/web/src/server/compliance/consents.ts` — not a new
  `server/consents/` directory. The current-policy list
  (`apps/web/src/server/compliance/policies.ts`, `currentPolicies` at `:49`) is
  the single source of truth for which version is live, the refusal is defined in
  terms of it, and consent is a §8.2 compliance surface next to the DSR write
  already homed there (`apps/web/src/server/compliance/data-request.ts`). A
  second directory would split one document contract across two homes.
- **Export:** `acknowledgeConsent(input): Promise<ConsentAcknowledgement>`, with
  `input = {db, userId, purpose, policyVersion, now, evidence}`.
  [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md) §4 sketched
  `{db, userId, policyVersion, now}`; that sketch is **amended** here by two
  required fields, and neither can be derived inside a module that sees no
  request:
  - `purpose` — the route's own body carries it (`z.enum(POLICY_PURPOSES)`), the
    current list holds **two** documents, and a version is only meaningful for
    its purpose (§5, `S5`). Resolving the document by version alone would let one
    purpose's version satisfy the other's.
  - `evidence` — the four raw request facts `{salt, ip, userAgent,
acceptLanguage}` §15.4 turns into salted digests. Passing the **raw** facts
    (not a built `ConsentEvidence`) keeps the in-app method an invariant of the
    service: a caller cannot write a `method: "checkbox"` row for an in-app
    acknowledgement.
- **It answers what the route answers:** `{id, purpose, policyVersion,
policyDocumentHash, grantedAt, withdrawnAt}`, `id` 24-hex, `grantedAt` the ISO
  form of the `now` it was handed, `withdrawnAt` `null` today.
- **It writes what the route writes:** one `consents` document with the same keys
  and values — `eventId: null`, `subject: {kind: "user", userId: <ObjectId>}`,
  `purpose`, `policyVersion`, `policyDocumentHash`, `policyUrl`, `method:
"in_app_action"`, `evidence` (from the shipped `buildConsentEvidence`),
  `grantedAt`, `withdrawnAt: null`, `createdAt`. Not redesigned.
- **Refusals are the route's refusals:** a `policyVersion` that is not the served
  document's version **for that purpose** throws `policy_version_stale` (`422`)
  with `details: {currentPolicyVersion, policyUrl}` and writes nothing; a
  `purpose` outside the current list throws `validation_failed` (`422`) and
  writes nothing. Same codes, same status, same details as `route.ts:65`–`:73`.
- **It is not idempotent.** A repeat for the same `{userId, policyVersion}`
  inserts a second row with a new id. That is today's route behaviour, pinned as
  a characterization arm by `I25` ([ADR-0901](ADR-0901-op138-dsr-contract-pins.md)
  §5); the service reproduces it. Making it idempotent would change the wire
  behaviour of the route the moment the delegate lands, which this card forbids.

**The route keeps its own zod body and answer schemas.** The service is a
delegate, not a replacement for transport validation; the route's wire bytes do
not move (`R1`/`R2` pin them before and after).

## 3. The two blockers — measured, not argued

Both were measured on this branch point (`61579449`) with the command shown.

### 3.1 There is no producer seam for `legal.terms.updated`

`legal.terms.updated` can only be emitted where the effective policy version
changes. No such write path exists:

| Measurement                                     | Command                                                                                              | Result                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the type key is catalogue-only, emitted nowhere | `grep -rn "legal.terms.updated" --include=*.ts apps packages`                                        | six hits across four files: `apps/web/src/server/notifications/notification-types.values.ts:885` (the catalogue row), `notification-matrix.test.ts:567`, `notification-types.test.ts:132` and three prose mentions in `data-subject-requests.test.ts` (`:1082`, `:1161`, `:1846`). No producer. |
| the settings module exposes no update path      | `grep -n "^export " apps/web/src/server/settings/platform-settings.ts`                               | `getPlatformSettings` (`:505`), `invalidatePlatformSettings` (`:534`), `seedPlatformSettings` (`:558`). No setter.                                                                                                                                                                              |
| even the seed cannot change a live version      | `sed -n '569,575p' apps/web/src/server/settings/platform-settings.ts`                                | `findOneAndUpdate({_id: SINGLETON_ID}, {$setOnInsert: defaults}, {upsert: true})` — create-only, so a rotation is impossible through it by construction.                                                                                                                                        |
| the versions are schema defaults, never written | `grep -rn "termsPolicyVersion" --include=*.ts apps/web/src \| grep -v src/test`                      | four hits, all reads/defaults: `policies.ts:54`, `policies.ts:57`, `platform-settings.ts:288` (zod default), `platform-settings.ts:354` (default value).                                                                                                                                        |
| no admin or settings route exists               | `git ls-tree -r --name-only HEAD -- apps/web/src/app/api \| grep -Ei "legal\|admin\|setting\|polic"` | one path: `apps/web/src/app/api/v1/legal/policies/current/route.ts`. The tree holds 134 `route.ts` files; none publishes a policy.                                                                                                                                                              |
| the documents are derived, not stored           | `sed -n '49,66p' apps/web/src/server/compliance/policies.ts`                                         | `currentPolicies(settings)` builds both entries from `platformSettings.legal` on every read; there is no `policies` collection.                                                                                                                                                                 |

**Decision owed (not lane work):** the OP-140 `policy × acknowledge` row needs a
policy-version **publish** path to emit `legal.terms.updated`. This card does not
invent one — an admin endpoint is a contract decision with its own
authorisation, audit and cache-invalidation surface, and inventing it here would
put an unratified route on the trunk.

### 3.2 A `policy` has no 24-hex target id

The notification action endpoint refuses a non-24-hex `actionTarget.id`
(`apps/web/src/app/api/v1/me/notifications/[id]/actions/[actionKey]/route.ts:119`:
`if (!ObjectId.isValid(target.id)) throw appError("validation_failed", {details:
{fields: [{path: "actionTarget.id", …, message: "must be a 24-hex ObjectId"}]}})`).
A policy document has no `_id` to point at: `PolicyDocument`
(`apps/web/src/server/compliance/policies.ts:20`–`:26`) is
`{purpose, version, url, effectiveFrom, documentHash}`, derived per read, and
`policyVersion` is a **string** (§3.1, last row). A synthetic ObjectId would name
a document that does not exist and would make the delegate's own lookup
impossible.

**Decision owed (not lane work):** the contract must give the `policy` target a
24-hex id — e.g. a stored policy-document row with an `_id`, which is also what a
publish path (§3.1) would write. Both decisions are one change; neither belongs
to this card.

**Both blockers are recorded, not guessed.** No admin route and no synthetic id
was minted; the production deliverable of this card is the service only.

## 4. Reversal condition

> The service is a precondition the OP-140 `policy × acknowledge` arm needs, but
> it is not sufficient: the row stays undeliverable until (i) a policy-version
> **publish** path exists to emit `legal.terms.updated` and (ii) the contract
> gives the `policy` target a 24-hex id. Both are contract decisions, not lane
> work; they are recorded here and routed, not guessed.

## 5. Evidence — the RED, the near-fix, and four mutations

**The RED, on the branch point with no production change.** `git status --short`
holds only the spec:

```
$ npx vitest run --project integration apps/web/src/test/integration/consent-acknowledgement-service.test.ts
 FAIL  |integration| apps/web/src/test/integration/consent-acknowledgement-service.test.ts
Error: Cannot find package '@/server/compliance/consents' imported from
  …/consent-acknowledgement-service.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

and the same import is the only type error the spec can raise:

```
$ npx tsc -p apps/web/tsconfig.json --noEmit
apps/web/src/test/integration/consent-acknowledgement-service.test.ts(7,36):
  error TS2307: Cannot find module '@/server/compliance/consents' …
```

**Type-correctness probe.** A throwaway faithful implementation at the intended
path made `tsc -p apps/web/tsconfig.json --noEmit` exit `0` and the file answer
`Tests 9 passed (9)` — so every case is satisfiable and fails at assertion level,
never at load. That stub was deleted before handoff (it is absent from `git
status`), so the deleted artefact can no longer be re-derived and no digest of it
is asserted here; what stands is the four-mutation measurement below. No
production file is in this diff.

**Four single-anchor mutations of that stub**, each restored byte-identically:

| Mutation                                             | Red set observed                                                                              | Failure line                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| delete the version check                             | `2 failed \| 7 passed (9)` — `S4`, `S5`                                                       | `promise resolved "{ id: '6b046f77…', …(5) }" instead of rejecting`                                                     |
| accept **any** served version, ignoring `purpose`    | `S5` alone                                                                                    | `promise resolved "{ id: '6b046f88…', …(5) }" instead of rejecting`                                                     |
| dedupe on `{subject.userId, purpose, policyVersion}` | `3 failed \| 6 passed (9)` — `S1`, `S2` (they compare against a row the route wrote) and `S7` | `expected '2026-11-23T16:53:48.354Z' to be '2026-11-23T09:00:00.000Z'` and `expected '6b046f9c…' not to be '6b046f9c…'` |
| drop `policyUrl` from the stored document            | `S2` alone                                                                                    | `expected [ '_id', 'createdAt', 'eventId', …(8) ] to deeply equal [ …(9) ]`                                             |

The first mutation is the card's required arm: a near-fix that skips the version
check reddens the refusal cases. The second is the arm `S5` exists for — a
`purpose`-blind resolution passes every other case.

**Neighbours, on this branch point with the spec in place:** `data-subject-requests.test.ts` + `biometric-consent.test.ts` → `Test Files 2
passed (2)`, `Tests 69 passed (69)`, and the seven ADR guards
(`pnpm vitest run --project unit apps/web/src/test/unit/adr-`) → `Test Files 7
passed (7)`, `Tests 248 passed (248)` with this record and its ledger row in
place. The spec, `eslint` (`No issues found`) and `prettier --check` (`All files
formatted correctly`, this record and the ledger included) are clean; `tsc`
reports exactly the one `TS2307` above, which
is this card's RED and the reason a RED PR is a draft (`ADR-0039`'s
RED-by-design rule: the pins land as a draft, the GREEN's PR is the one merged).

## 6. Assumptions and open items

- **`now` is an input, not a read.** The route uses `systemClock.now()`; the
  service takes the instant so the recorded `grantedAt`, the receipt and the row
  are one value the caller can assert. The route keeps calling `systemClock.now()`
  and passes it in — no wire change.
- **The route keeps deriving the evidence facts.** `resolveClientIp` /
  `getTrustedClientIpHeader` / the `getRateLimitConfig().salt` read stay on the
  transport side; the service is header-free by construction. This is what makes
  `S3` a service-level pin rather than a route re-run.
- **`S1`/`S2` drive the route first and the service second** for one principal
  and one version, then compare the two answers and the two stored documents. The
  comparison excludes `_id`, `grantedAt` and `createdAt` (the two writes are two
  grants, not one row) and keeps every other field, including the key set — a
  field the service drops is a schema change.
- **`validation_failed` on an unknown `purpose`** is the route's `route.ts:65`–`:67`
  branch, which its zod enum makes unreachable at the wire. The service keeps the
  guard for a caller that is not the route, and `S6` pins it directly.
- **Not pinned here:** that the service emits `legal.terms.updated` (it cannot —
  §3.1), and the `policy` target id (§3.2). Both are the deferred row's own gap.
  Pinning them would force the guess this card forbids.
- **Not pinned here:** cross-tenant behaviour — the platform-scope
  acknowledgement names no event and no tenant (`eventId: null`), which `S2`
  asserts, and there is no tenant filter to sweep.

## 7. Number allocation — `0910`

The OP-138 lane holds `0898`–`0917` and its `Next free` cell
(`docs/adr/README.md:77`) read **`0910`**. The re-sweep before writing:

- `git ls-tree --name-only origin/main docs/adr` — no `ADR-0910` / `ADR-0911`;
  the trunk's highest OP-138 record is `0909`;
- every `.worktrees/*/docs/adr` tree: no `ADR-0910` / `ADR-0911` file;
- `git rev-list --objects --all -- docs/adr | grep -E "ADR-09(10|11)"` — no blob;
- the five open PR heads (#827, #826, #755, #743, #272): none carries it;
- every non-`done` card on the board (`$HERMES_KANBAN_DB`, i.e.
  `~/.hermes/kanban/boards/openpic-kanban-board/kanban.db`; 7 cards:
  `t_61798b06`, `t_0c9f26df`, `t_9d80fb7f`, `t_7ec513e9`, `t_9df3b691`,
  `t_87c55393`, `t_b86c70b7`): only this card names `0910`/`0911`, and it is the
  card doing the reserving.

`0910` is this record; the lane cell advances to **`0912`**, because the GREEN
sibling holds `0911` and carries its own row
([ADR-0319](ADR-0319-every-adr-record-carries-a-ledger-row.md)), which makes that
row mandatory in the same change. No cell is lowered and no range is re-cut.

## 8. Consequences

- The route becomes a thin delegate without one wire byte moving: `R1`/`R2` pin
  its `201` key set and its `422 policy_version_stale` details, and they are green
  before the delegate lands.
- A future change that makes the acknowledgement idempotent reds `S7` alone, with
  a message naming the append-only history semantics — the mistake a "dedupe the
  repeat" refactor would make.
- A future change that resolves a version by a global search reds `S5` alone;
  `S2` catches a dropped or renamed stored field.
- The `policy × acknowledge` row stays **deferred**: this record removes the "no
  service" half and records the two remaining halves (a publish path and a
  24-hex target id) as contract decisions owed.

## Alternatives

- **Export the write as a helper from the route module.** Rejected: it would drag
  `defineRoute`, the auth guard and the Next request type into every delegate, and
  a delegate that can call a route is one refactor away from calling HTTP.
- **A new `apps/web/src/server/consents/` directory.** Rejected: the current-policy
  list and the refusal both live in `server/compliance`, and
  `server/compliance/data-request.ts` already homes the sibling §8.1 write. Two
  homes for one document contract is how a version check drifts.
- **Take a built `ConsentEvidence` instead of the raw facts.** Rejected: it moves
  the `method: "in_app_action"` invariant onto every caller, and the attendee
  checkbox path (`method: "checkbox"`) already shows how easily that is got wrong.
- **Make the service idempotent while extracting it.** Rejected: it changes the
  route's answer for a repeat from `201` + a second row to (at best) `200`, which
  this card forbids ("do not weaken the route"), and `I25` ships the opposite
  behaviour on purpose.
- **Invent an admin policy-publish endpoint, or mint a synthetic 24-hex policy
  id, so the row becomes deliverable.** Rejected by the card and by §3: both are
  contract decisions with their own authorisation, audit and storage questions.
