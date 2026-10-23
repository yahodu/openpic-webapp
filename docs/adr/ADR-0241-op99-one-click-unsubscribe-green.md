# ADR-0241 — OP-99 GREEN: the one-click unsubscribe surface, suppressions and the disputed settings assertion

- **Status:** Accepted · **Date:** 2026-10-23
- **Card:** OP-99 GREEN — _One-click unsubscribe and first-party suppressions_ (`t_3bb9a1a3`) · **RED predecessor:** `t_28ab0e00` ([ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md)) · **Scope reconciled by:** `t_b8ee4846`
- **Epic:** `1-Notifications / Unsubscribe` · **Phase:** 1 · **Depends on:** OP-98 (notification preferences, merged `25292ae`)
- **Branch:** `OP-99-task-one-click-unsubscribe` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_28ab0e00` · **PR:** [#253](https://github.com/yahodu/openpic-webapp/pull/253) (opened by the RED review; the GREEN lands on this branch — every RED pin is green except the one disputed assertion recorded below)
- **ADR number:** `0241` — the OP-99 lane holds the reserved range `0240`–`0259` ([ADR-0300](ADR-0300-adr-number-range-allocation-policy.md); `docs/adr/README.md` § "Reserved ranges"). `0240` was consumed by [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md), so the lane-local counter is `0241`; the README `Next free` cell advances to `0242` in this commit. Drawn from the lane's own range, never from `origin/main`'s high-water mark or the index tail.
- **Touches:** `apps/web/src/server/notifications/unsubscribe.ts` (new), `apps/web/src/app/api/v1/notifications/unsubscribe/[token]/route.ts` (new), `apps/web/src/server/notifications/preferences.ts` (+`toStoredPreferences`), `apps/web/src/app/api/v1/me/notification-preferences/route.ts` (uses the extracted reader), `apps/web/src/server/db/collections.ts` (+`notificationSuppressions`), `apps/web/src/server/db/indexes.ts` (+2 specs), `docs/adr/README.md` and this record. **No test, mock, fixture or factory is modified** — the two RED vitest specs, the Playwright spec, the e2e token fixture and [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) itself are byte-unchanged.

## Context

[ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) pinned the public unsubscribe
surface as an executable specification: the pure module
(`signUnsubscribeToken` / `verifyUnsubscribeToken` / `applyUnsubscribeScope` plus
`UNSUBSCRIBE_TOKEN_TTL_DAYS` and the shared types), the `GET`/`POST
/api/v1/notifications/unsubscribe/{token}` pair, the exact token wire format and the
first-party `notificationSuppressions` row (contract §7.5; design §19.6).

The reconciliation card `t_b8ee4846` settled the two open questions before this GREEN
started, and this record implements that settled scope exactly:

1. **F1 — the rejection codes are the RED's own.** invalid / tampered / absent →
   `400 bad_request`; expired → `410 gone`. No new Appendix A code is introduced.
2. **F3 — three unpinned items are out of scope** (each deferred by ADR-0240 and
   pinned by no RED test): `buildUnsubscribeLink()` and the `List-Unsubscribe` /
   `List-Unsubscribe-Post` header emission (the transport story; contract §7.5 assigns
   the headers to the transport adapter and ADR-0074 pinned them at
   `payload.headers`), the `suppressionService` resolver lookup and the `resolveChannel`
   consumer changes (the resolver / fan-out story), and a `20/min/IP` rate limit
   (contract §0.11 has no class for this surface — adding one is a §0.11 change outside
   OP-99). Under TDD this GREEN ships none of them.

## Decision

### The module (`apps/web/src/server/notifications/unsubscribe.ts`)

Exactly the exports ADR-0240 pins — `signUnsubscribeToken`, `verifyUnsubscribeToken`,
`applyUnsubscribeScope`, `UNSUBSCRIBE_TOKEN_TTL_DAYS` (`90`) and the four shared types
— and nothing else.

- **Wire format.** `base64url(payloadJson) + "." + lowercase hex HMAC-SHA256(
base64url(payloadJson))` with `payload = { userId, scope, typeKey?, exp }` and
  `exp = floor(now/1000) + 90*24*3600`. The HMAC is recomputed over the token's own
  payload segment and compared with `timingSafeEqual` (mirroring
  `internal-hmac.ts`), so a tampered token is rejected in constant time — an
  acceptance criterion, and why the signature is checked **before** the payload is
  parsed.
- **Verdicts.** `{ valid: true, payload }` carries the signed payload **exactly**,
  `exp` stripped and `typeKey` omitted when absent, so `toEqual` distinguishes a
  `"marketing"` token from a `"type"` one; `{ valid: false, reason }` is `"invalid"`
  for a malformed, truncated or tampered token and `"expired"` for a correctly signed
  token at or past `exp`. The function never throws.
- **The reducer.** `"all"` mutes the `email` group of every _muteable_ type;
  `"type"` mutes exactly one; `"marketing"` writes no `byType` at all. A type is
  muteable only when it is enabled, **not** transactional, and its **enabled** `email`
  group carries `optOutAllowed: true` (ADR-0240 assumption #2) — so `scope: "all"`
  can never mute an OTP or a payment failure structurally, and the disabled-group
  fixture (`email: { enabled: false, optOutAllowed: true }`) is correctly excluded.
  The document is copied, never mutated, and every scope the unsubscribe does not own
  is copied through untouched.
- **`stillReceiving`** is the sorted labels (`type.label ?? humaniseKey(typeKey)`) of
  the enabled transactional types whose email group is enabled — how the `200` body
  says explicitly that critical notices are unaffected without inventing copy the seed
  does not store.

### The route (`app/api/v1/notifications/unsubscribe/[token]/route.ts`)

Both verbs are **public** — no `auth` stage on `defineRoute`; the token is the
credential. The secret is `getConfig().transport.unsubscribeSigningSecret`, read
inside the handler (module-level `getConfig()` would validate the environment at
import time, before a spec's `beforeAll`).

Order of operations, for both verbs: verify the token → read the enabled catalogue →
read the stored preferences → reduce → validate a `scope: "type"` token → **only then**
write. Every rejection therefore precedes every write:

| Condition                                                                | Status | Code                  | `details`                                    |
| ------------------------------------------------------------------------ | ------ | --------------------- | -------------------------------------------- |
| malformed / tampered / absent token, or a userId that is not an ObjectId | `400`  | `bad_request`         | —                                            |
| expired token                                                            | `410`  | `gone`                | —                                            |
| `scope: "type"` names a `typeKey` absent from the catalogue              | `422`  | `unknown_type_key`    | `{ typeKey }`                                |
| `scope: "type"` names a type the surface may not mute                    | `422`  | `opt_out_not_allowed` | `{ typeKey, channelGroup: "email", reason }` |

**The two `422`s share one source of truth.** `opt_out_not_allowed` is raised when the
reducer's `mutedTypeKeys` comes back empty for a known `typeKey`, so the route never
re-derives "may this type be muted?" — the same predicate answers the preview and the
apply, and a future change to the reducer cannot desynchronise the check. The `reason`
follows the OP-98 precedent (`optOutReason`): `"transactional"` for a transactional
type, `"not_opt_outable"` for any other locked one. That distinction is what the
downstream TEST card `t_af207345` (review finding F2) will pin; ADR-0240's single
`reason: "transactional"` row is only correct for the transactional half.

**Idempotency.** `GET` writes nothing. A repeat `POST` of `scope: "type"`/`"all"` is
byte-identical because the reducer is deterministic and the upsert `$set`s the same
document; a repeat `POST` of `scope: "marketing"` keeps exactly one suppression,
because the row is keyed `{ channel: "email", contactHash }` and `createdAt` is set
with `$setOnInsert`. `scope: "all"` writes **no** suppression — a `scope: "all"`
suppression is the permanent "never contact" list (design §19.6), exactly what an
unsubscribe must not create.

**Logging.** One structured line on apply
(`notification.unsubscribe.applied`, `{ userId, scope }`). The raw token and the
recipient's contact are never logged (security requirement), and the email is read
in-process only to compute the contact hash.

**The `marketing` write reads the email first.** The suppression is keyed by
`sha256:` + the trimmed, lowercased address from the Better Auth `user` document, so
the address is resolved **before** either write: a missing address is a data-integrity
failure (`500 internal_error`) rather than a half-applied unsubscribe that cleared
`marketingOptIn` but wrote no suppression.

### Persistence registry (design §19.6)

`notificationSuppressions` is registered in `COLLECTIONS` (it is app-owned, unlike
Better Auth's literal `user` collection) and carries the two indexes the design
document names: `{ channel: 1, contactHash: 1 }` unique and `{ createdAt: -1 }`. The
unique key is what makes the suppression upsert idempotent under concurrency, and the
bootstrap lint (`indexes.test.ts`) consumes the new specs unchanged.

### One extracted reader, so both surfaces read a stored document identically

The unsubscribe reducer needs the caller's stored `notificationPreferences` document
and must write it back with every scope it does not own preserved. That mapping
(untested driver row → `StoredPreferences`) already existed, private, in the OP-98
route. It is now the pure, exported `toStoredPreferences(row)` in
`preferences.ts`, and **the OP-98 route was refactored to consume it** — a
behaviour-preserving extraction, verified by OP-98's own integration suite, rather
than a second copy in the new route. Two rows-to-document readers would have been a
latent divergence: a scope sanitised in one and not the other is a phantom override.

## The disputed assertion (Dispute Protocol)

One RED assertion is **left red, unedited**, because no honest implementation can
satisfy it without breaking a shipped contract:

```
apps/web/src/test/integration/notification-unsubscribe.test.ts:307
  "POST apply (§7.5)" › "I1: the applied mute is what the settings screen resolves as source type"

  expect(resolvedEmail(body, typeKey)).toEqual({ effective: "off", source: "type" });
  → AssertionError: expected { effective: 'off', …(2) } to deeply equal { effective: 'off', source: 'type' }
    + "optOutAllowed": true
```

**Why it cannot pass.** The assertion reads **OP-98's** settings route
(`GET /api/v1/me/notification-preferences`), whose resolved channel is
`{ effective, optOutAllowed, source }` — required by contract §7.4 and by OP-98's
response schema, and pinned by OP-98's own integration spec with `.toEqual`:

- `apps/web/src/test/integration/me-notification-preferences.test.ts:341,347` —
  `expect(resolvedChannel(…, OPT_OUTABLE_TYPE, "email")).toEqual({ effective: "off", optOutAllowed: true, source: "type" })`;
- `apps/web/e2e/notification-unsubscribe.spec.ts:145` — **this RED's own e2e spec** —
  `expect(appliedChannel).toEqual({ effective: "off", optOutAllowed: true, source: "type" })`.

The two OP-99 assertions therefore contradict each other, and the integration one
contradicts contract §7.4 and the OP-98 pin. Vitest's `toEqual` fails on an extra
present key, so the only ways to green it are to strip a contract-mandated field from
OP-98's response (breaking OP-98's own suite and the OP-99 e2e) or to edit the test —
both refused.

**Why the RED never caught it.** In the honest RED state the whole file fails
`module-not-found`, and ADR-0240's type-correctness probe ran against stubs that
answered `500`, so `expect(response.status).toBe(200)` failed first and masked the
comparison. The assertion has never been executed against a working route until now.

**Proposed correction (for the Test Author, not this card).** Either
`toMatchObject({ effective: "off", source: "type" })`, or include the third field and
widen `resolvedEmail`'s declared return type to
`{ effective: string; optOutAllowed: boolean; source: string }` — matching the e2e
spec and OP-98. Routed as a follow-up TEST card; this card writes no tests.

**Confirmed by the human (2026-10-23).** The decision recorded on card `t_3bb9a1a3` is
"decision 1: confirm the dispute" — the assertion is the defect, not the implementation,
and OP-98's §7.4 response shape stands. The one-line correction lands as the follow-up
TEST card `t_8676455d` (gated on `t_af207345` so the shared spec file is never edited
concurrently), which records the fix in this section. No production change follows from
it, and this card did not touch the test.

**Correction applied (2026-10-23, `t_8676455d`).** The follow-up TEST card took the
smallest option: the assertion is now
`expect(resolvedEmail(body, typeKey)).toMatchObject({ effective: "off", source: "type" })`.
Only the strictness changed — the opaque extra key `optOutAllowed: true` is tolerated
instead of stripping it from OP-98's contract-mandated response; the case and every other
assertion are untouched. OP-98's `.toEqual` pin and this lane's Playwright spec still
assert the full three-field shape byte-unchanged. No ADR number was consumed; this is a
test-only correction recorded in place.

Everything else in the suite is green, including the other 13 cases of this very file
(the sibling of the disputed case, which asserts the _stored_ `byType` document and
the `source` resolution, passes).

## Evidence

All commands run in `/root/openpic/openpic-webapp/.worktrees/t_28ab0e00` on
`OP-99-task-one-click-unsubscribe`.

```
vitest run --project unit apps/web/src/server/notifications/unsubscribe.test.ts
  Test Files  1 passed (1) · Tests  19 passed (19)          # U1 4 · U2 5 · U3 2 · U4 8

TMPDIR=/root/tmp-mongo vitest run --project integration \
  apps/web/src/test/integration/notification-unsubscribe.test.ts
  Test Files  1 failed (1) · Tests  13 passed | 1 failed (14)   # the dispute above

vitest run --project unit
  Test Files  91 passed (91) · Tests  1624 passed (1624)     # includes the 19 new cases

TMPDIR=/root/tmp-mongo vitest run --project integration
  Test Files  1 failed | 63 passed (64) · Tests  1 failed | 443 passed (444)
  # the single failure is the disputed assertion; OP-98's me-notification-preferences
  # suite is green, proving the toStoredPreferences extraction is behaviour-preserving

TMPDIR=/root/tmp-mongo npx playwright test --config apps/web/playwright.config.ts \
  notification-unsubscribe --project api
  1 passed (E1: preview then apply a type-scoped unsubscribe through the API)

TMPDIR=/root/tmp-mongo npx playwright test --config apps/web/playwright.config.ts --project api
  17 passed (17)

tsc -p tsconfig.json --noEmit && tsc -p packages/contracts/tsconfig.json --noEmit   # exit 0
npx eslint <touched files>                          # 0 errors (security/detect-object-injection
                                                    #  warnings only — the repo's established class)
npx prettier --check .                              # clean
vitest run --project unit apps/web/src/test/unit/adr-numbering.test.ts   # 29 passed (29)
npx pnpm --filter @openpic/web build                # succeeds; /api/v1/notifications/unsubscribe/[token] compiled
```

The RED deliverable is byte-unchanged: the two vitest specs, the Playwright spec, the
e2e token fixture and ADR-0240 carry no edit from this card.

## Consequences

- A recipient's one-click unsubscribe is a single signed URL with no session, and no
  token can suppress a security or billing notice: the reducer writes `email` only
  where the group is enabled, opt-outable and non-transactional, and `scope: "all"`
  writes no suppression at all.
- A rejected unsubscribe cannot leave a phantom override — every rejection precedes
  the first write — and `createdAt` / the unique key make a repeat `POST` a no-op.
- The settings read and the unsubscribe write now interpret a stored document through
  one exported reader, so a sparse or partially-malformed row cannot be understood two
  ways.
- The suppression collection exists with its design-document indexes, ready for the
  bounce/complaint ingestion and the resolver's `skipReason: "suppressed"` (both later
  stories).

## Rejected alternatives

- **Reading the stored preferences with a second private mapper in the route** —
  duplicated sanitisation that can drift from OP-98's, so the same row could be
  preserved by one surface and dropped by the other. Extract once.
- **Raising `opt_out_not_allowed` from a route-local predicate** — two implementations
  of "may this type be muted?" (route and reducer) that must agree forever. The
  reducer's own `mutedTypeKeys` is the single answer.
- **`reason: "transactional"` for every locked type** (ADR-0240's table read
  literally) — wrong for the 23 non-transactional locked seed types and contrary to the
  OP-98 precedent; the downstream F2 pin would (correctly) report it as a defect.
- **Stripping `optOutAllowed` from OP-98's settings response** to satisfy the disputed
  assertion — breaks contract §7.4, OP-98's pinned suite and this RED's own e2e spec.
- **Adding the deferred F3 scope** (`buildUnsubscribeLink`, the `List-Unsubscribe`
  headers, a resolver suppression lookup, a `20/min/IP` rate limit) — unpinned by any
  RED test, deferred by ADR-0240, and in the rate limit's case outside the contract.
- **Editing the disputed assertion** — forbidden; a green suite bought by rewriting a
  test is a failed delivery.

## Out of scope

- The **follow-up TEST card** for the disputed assertion above, and `t_af207345`
  (review findings F2 — the locked non-transactional `422` and its `details.reason` —
  and F4 — the cookie-less public `POST` through the real middleware), both gated on
  this card.
- `buildUnsubscribeLink()` / `List-Unsubscribe` header emission (transport story),
  the resolver's suppression lookup and `skipReason`, admin suppression management
  (contract §7.5 tail), provider bounce/complaint ingestion and the `mobile` group —
  all deferred by [ADR-0240](ADR-0240-op99-one-click-unsubscribe-red.md) § "Out of scope".
- The `20/min/IP` rate limit — contract §0.11 has no class for this surface.
- **Contract §7.5 is not edited.** Its example `200` body predates ADR-0240 (it omits
  `mutedTypeKeys` and names no token error code); ADR-0240 is the executable contract
  and `mutedTypeKeys` is pinned by the RED. Aligning the contract prose with the
  shipped body and its rejection rows is a docs change outside this card, flagged for
  the human rather than made unilaterally.
- The RED review sign-off record, drawn from this lane's range by the DOCS card
  `t_36eb9c28`.
