# ADR-0911 — OP-140 GREEN: `acknowledgeConsent` lands, and the acknowledge route becomes a thin delegate

- **Status:** Accepted
- **Date:** 2026-11-23
- **Card:** OP-140 precondition GREEN `t_13c46dd1` — the production half of the
  TEST card `t_7ec513e9`; the pins are [ADR-0910](ADR-0910-op140-consent-acknowledgement-service.md).
- **Branch:** `OP-140-task-precondition-consent-acknowledge-green`; **worktree:**
  `/root/openpic/openpic-webapp/.worktrees/op140-precondition-consent-acknowledge-green`;
  **base:** the TEST branch head `54ca4fdb` (`git worktree add … 54ca4fdb`, not
  `origin/main` — the spec and this record's parent live only on that commit).
- **Pins:** contract §8.2 (`docs/API Contract.md`), schema §15.4
  (`docs/Notification and Database Design.md`), and the nine inherited cases
  `S1`–`S7` / `R1`–`R2` of
  `apps/web/src/test/integration/consent-acknowledgement-service.test.ts` —
  **not one byte of that file is in this diff**.
- **Consumes:** [ADR-0910](ADR-0910-op140-consent-acknowledgement-service.md) §2
  (the service's contract and its two amended input fields), §3 (the two
  blockers recorded as decisions owed), [ADR-0899](ADR-0899-op138-data-subject-requests-green.md)
  (the route and the current-policy list this change moves behind a service),
  [ADR-0901](ADR-0901-op138-dsr-contract-pins.md) §5 (`I25`, the append-only
  characterization pin) and [ADR-0942](ADR-0942-op140-notification-action-endpoint-red.md)
  §2/§4 (the deferred `policy × acknowledge` row this service is the
  precondition for).
- **Consumers:** `apps/web/src/app/api/v1/me/consents/acknowledge/route.ts` (the
  thin delegate that calls the service and answers its receipt) and the OP-140
  `policy × acknowledge` delegate card (not this one), which calls
  `acknowledgeConsent` instead of re-entering this route or copying its insert.

## 1. Context

ADR-0910 measured that `POST /api/v1/me/consents/acknowledge` owned the
acknowledgement write end to end: the 115-line route resolved the served
document, refused a retired version, derived the §15.4 evidence from the request
headers and inserted the `consents` row. Its pins fixed the contract of a
callable service with the same behaviour, so that the OP-140 `policy ×
acknowledge` notification action can record an acknowledgement without a second
copy of that write.

## 2. Decision

**One module at the pinned path, and a route that only transports.**

- **`apps/web/src/server/compliance/consents.ts`** exports
  `acknowledgeConsent({db, userId, purpose, policyVersion, now, evidence})` and
  the two input/receipt types `AcknowledgeConsentInput`,
  `ConsentEvidenceFacts` and `ConsentAcknowledgement`, exactly as ADR-0910 §2
  fixes them.
- **Behaviour is the route's, moved verbatim.** It resolves the document for
  `purpose` from `currentPolicies(await getPlatformSettings({db}))`; refuses a
  purpose the list does not serve with `validation_failed` (`422`,
  `details: {fields: []}`); refuses any `policyVersion` that is not that
  purpose's served version with `policy_version_stale` (`422`,
  `details: {currentPolicyVersion, policyUrl}`) and writes nothing; otherwise
  inserts one `consents` document with the same key set and values the route
  wrote — `_id`, `eventId: null`, `subject: {kind: "user", userId: ObjectId}`,
  `purpose`, `policyVersion`, `policyDocumentHash`, `policyUrl`, `method:
"in_app_action"`, `evidence` from the shipped `buildConsentEvidence`, `grantedAt:
now`, `withdrawnAt: null`, `createdAt: now` — and answers the six-key receipt
  with `grantedAt === now.toISOString()`.
- **Not idempotent, on purpose.** A repeat inserts a second row and answers a
  new id. That is the route's shipped behaviour (`I25`) and the pin `S7`
  protects it; a dedupe would have changed the wire behaviour the moment the
  delegate landed.
- **The route keeps its transport surface.** `defineRoute`, the zod body and
  answer schemas, the `user` auth guard and the `201` status are untouched; the
  handler resolves the client IP, `user-agent` and `accept-language`, takes
  `systemClock.now()` and the deployment salt exactly as before, calls
  `acknowledgeConsent` and returns its receipt as the `201` body. The service's
  throw reaches the shipped error mapping unchanged, so the refusal is still
  `422 policy_version_stale` with the same details (`R2`). The handler shrank
  from 115 to 71 lines (`+25/−69`), and there is no second insert.
- **No other consumer moves.** The write is reached only through
  `platformRepo(db).collection(COLLECTIONS.consents)`, the same door the route
  used, and `currentPolicies`, the document shape and every route's wire answer
  are untouched.

## 3. What stays out of scope

ADR-0910 §3 is the authority, and this card adds nothing to it. The row stays
undeliverable until (i) a policy-version **publish** path exists to emit
`legal.terms.updated` and (ii) the contract gives a `policy` target a 24-hex id.
No admin policy endpoint, no `policies` collection, no `platformSettings`
setter and no synthetic id was minted here, and the four notification files
named as a scope wall in the card are not in the diff.

## 4. Evidence

Measured on this branch, with the spec byte-identical to `54ca4fdb`:

```
$ pnpm exec vitest run --project integration apps/web/src/test/integration/consent-acknowledgement-service.test.ts
 Test Files  1 passed (1)
      Tests  9 passed (9)

$ pnpm exec vitest run --project integration \
    apps/web/src/test/integration/data-subject-requests.test.ts \
    apps/web/src/test/integration/biometric-consent.test.ts
 Test Files  2 passed (2)
      Tests  69 passed (69)

$ pnpm typecheck
$ tsc -p tsconfig.json --noEmit &&
  tsc -p packages/contracts/tsconfig.json --noEmit &&
  tsc -p apps/web/tsconfig.json --noEmit   # exit 0, no diagnostics

$ pnpm exec vitest run --project unit apps/web/src/test/unit/adr-
 Test Files  7 passed (7)
      Tests  248 passed (248)
```

`pnpm lint` and `pnpm format:check` are clean on the two delivered files and
this record. The parent's single `TS2307` (`Cannot find module
'@/server/compliance/consents'`) is gone because the module now exists.
