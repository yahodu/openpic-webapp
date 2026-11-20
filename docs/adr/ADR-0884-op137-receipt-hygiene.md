# ADR-0884 — OP-137 TEST: the receipt path's suppression idempotency, log hygiene and blank-secret refusal

- **Status:** Accepted (characterization pins — green on arrival against the
  landed OP-137 GREEN ADR-0882, so the PR is non-draft and merges). Delivered as
  PR [#754](https://github.com/yahodu/openpic-webapp/pull/754), spec commit
  `6ac2773e` + this record, base `origin/main` `c96c2d18`.
- **Card:** OP-137 TEST `t_a587c8bd` (Medium). Branch
  `OP-137-task-receipt-hygiene-pins`, worktree
  `/root/openpic/openpic-webapp/.worktrees/t_a587c8bd`, cut from `origin/main`
  `c96c2d18` (a descendant of the OP-137 squash `c92ca81f`, so the route and the
  projection are on the base).
- **Implements:** nothing. This record changes **no** production file, fixture or
  helper: it closes four coverage gaps, and every behaviour it pins is already
  on the trunk.
- **Consumes:** [ADR-0875](ADR-0875-op137-delivery-receipts-red.md) §Number
  allocation and the I-list that leaves these arms open,
  [ADR-0882](ADR-0882-op137-delivery-receipts-green.md) (the GREEN whose
  `$setOnInsert` upsert, `webhook_secret_not_configured` refusal and
  `warnRejectedSignature` call this record pins), contract §10.1.3
  (`processResult` semantics; "an unmatched receipt is `ignored`, never an
  error"), `docs/CONVENTIONS.md` §5.3 (the redaction list: webhook signing
  secrets and signatures, and "log a stable hash" where correlation is needed),
  [ADR-0883](ADR-0883-op136-discovery-abort-pin.md) §4 (the house shape of a
  characterization pin: green on arrival, load-bearing by mutation) and
  [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) §11 (numbering).
- **Consumers:** `apps/web/src/test/integration/webhook-novu-receipts.test.ts`.
- **Findings:** **F3** (Medium) of the landing review of `t_73b9cd9b` — the raw
  contact is storable in a suppression row, unpinned — plus items 1–3 of the
  reviewer's scope comment on this card (suppression idempotency, log hygiene,
  blank secret).
- **Number allocation:** `0884`. The card fixed this number before it ran, and
  the sweep at delivery (`git fetch origin --prune`, then every worktree's
  `docs/adr`, every local and remote branch, and every fetched PR head) confirms
  it is free on every live surface: no `ADR-0884` path exists in any of the 38
  worktrees, on any branch, or on the trunk; both `Next free` cells read `0888`
  at `c96c2d18`; the trunk's highest record is `0887`; `ADR-0888` is in flight on
  the OP-137 sibling `t_8290f915` (branch `OP-137-task-contact-digest-pins`, PR
  #752). `git rev-list --objects --all -- docs/adr` still resolves one
  `ADR-0884-op136-multi-row-containment-pins.md` blob from `refs/remotes/pr/749`,
  which is the **superseded draft** of the OP-136 record later minted as
  [ADR-0887](ADR-0887-op136-multi-row-containment-pins.md) (§Number allocation
  there says exactly that: "the record was drafted as `0884` and raised by the
  delivery sweep"), so it is a dead ref and not a live claim. This record is a
  gap below the cursor, so it consumes `0884` and **touches neither cell**: they
  stay at `0888`, which satisfies the card's "set both cells to
  max(observed, 0885); never lower a cell".

## Context — four arms that no pin measured

The OP-137 lane's nine unit cases and fourteen integration cases (`I1`–`I8`)
pin the §10.1.3 table row by row. Four properties of the shipped code were true
only by measurement out of band:

1. **A second hard bounce.** `notificationSuppressions` carries
   `notification_suppressions_channel_contact_unique` on `{channel, contactHash}`
   (`apps/web/src/server/db/indexes.ts`), so a naive `insertOne` for a contact
   that already has a row is a duplicate-key failure on a receipt that must
   apply. `projectDeliveryReceipt` upserts with `$setOnInsert` instead. `I2`
   bounces one contact once; nothing delivered a second receipt for the same
   contact.
2. **Log hygiene.** The receipt payload carries `to`, a raw address, and the
   request carries `webhook-signature`. `I6` asserts the _schema-rejection_
   error line (its `provider`), and no case looked at what the path logs when it
   accepts, or at what the rejected-signature warn carries.
3. **The blank secret.** ADR-0875 left the arm open and required the GREEN to
   fail closed. ADR-0882 shipped `webhook_secret_not_configured` →
   `invalid_signature` before any header is read, and `NOVU_WEBHOOK_SECRET`
   stayed **optional** in `server/config/env.ts` (`getNovuRuntimeConfig()`
   defaults it to `""`), because a required key would break every suite that
   boots through `startTestApp` → `makeEnv`. No case ran with the key absent or
   blank.
4. **The stored suppression row.** The card's sibling requirement — contacts are
   never stored raw, only their digest — was unpinned: the landing review
   measured that adding `contact: receipt.contact` to the `$setOnInsert`
   document leaves `webhook-novu-receipts.test.ts` at `14 passed (14)`, because
   `I2` and `I4` assert with `expect.objectContaining(...)` and a matcher that
   names a subset cannot see an added field.

## Decision

### 1. One appended block set in the existing spec; nothing existing is edited

`apps/web/src/test/integration/webhook-novu-receipts.test.ts` gains four new
`describe` blocks, six cases (four `it` plus one `it.each` with two arms) and two
block-scoped helpers. `git diff --numstat` against the base is `329 0` in that
one file: the fourteen delivered cases, every module-level helper, every
fixture, every constant and every import is byte-identical, and nothing is
deleted. No `.only`, no skip, no loosened matcher.

The file is the right home because every case needs its harness: `seedRecipient`
(the `user` + `userProfiles` + `notificationPreferences` trio), `insertEvent` +
`runFanOut` (the **real** fan-out, so the dispatch's `contactHash` and
`providerRef.messageId` are the production ones), `dispatchesFor`,
`suppressions`, `inboxRows`, `signedHeaders`, `drainDeferredProjections` (the
`after()` seam) and `makeNovuReceiptBody`. A second file would copy them.

### 2. `I9` — the suppression-idempotency arm

Two `auth.otp.email.requested` events are fanned out **before** any receipt
lands (a hard bounce suppresses the contact with `scope: "all"`, so a later
fan-out would be skipped, and the second dispatch would not exist), then two
signed hard-bounce receipts are delivered under two distinct `webhook-id`s and
two distinct payload `eventId`s, each naming its own dispatch's
`providerRef.messageId`.

The two fan-outs share **one** `memoryMessageTransport`. That is load-bearing:
the adapter mints `memory-<n>` per instance, so two fresh transports give both
dispatches `memory-1`, and the projection (which looks a dispatch up by
`providerRef.messageId` **alone**) cannot tell them apart. The first draft of
the case did exactly that and failed on
`expected 'memory-1' not to be 'memory-1'` — the guard is kept in the case as
`expect(messageIdOf(first)).not.toBe(messageIdOf(second))`.

Observables: both responses are `200 {"status":"received"}`; the inbox carries
**two** rows, both `processResult: "applied"` with `processError: null`
(sorted by `providerEventId`, so the assertion names the offender rather than
trusting natural order); exactly **one** suppression row exists, `channel:
"email"`, `contactHash` = `sha256:` + the ledger's own digest, `reason:
"hard_bounce"`, `scope: "all"` — unchanged by the second receipt; and both
email dispatches are `bounced`, so `applied` is not a vacuous acknowledgement
of a no-op.

**Scope boundary.** This case pins _duplicate_ idempotency only. Whether an
existing row must be **upgraded** (a marketing unsubscribe replaced by a later
hard bounce) or **re-armed** (an expired row) is a different decision, owned by
`t_df4e6eb3` (pins) + `t_b7bcc125` (GREEN). Nothing here asserts `source` or
`createdAt` of the surviving row, so that lane is free to change them.

### 3. `I10`/`I11` — the log-hygiene arm

Both cases install `setLogger(createLogger({ level: "trace", transports: [sink] }))`
with `sink = memoryTransport()`, **after** the fixture is built, so the sink
holds only the lines the receipt path itself writes. The config carries no
`service`/`env`/`version` and no `base`, so an entry holds exactly the
call-site fields plus `ts`, `level` and `msg` — that is what makes an exact
field-set assertion satisfiable. The file-level `afterEach` already restores
the ambient logger, so no spec leaks a memory sink.

`I10` drives the path both ways in one case: a deliverable hard bounce (whose
payload names the raw address) and a delivery signed with a key this
deployment does not hold (the arm that logs). It asserts the sink is **not
empty** (so the negatives are not vacuous) and that the whole serialised stream
contains neither the recipient's address, nor the rejected request's
`webhook-signature` value, nor `NOVU_WEBHOOK_SECRET`.

`I11` pins the warn itself: `401` with `{ error: { code: "invalid_signature" } }`
(a refusal, not a crash), exactly one `warn`, and

- the **exact** sorted field set
  `["event", "ipHash", "level", "msg", "provider", "reason", "ts"]`;
- `event: "webhook.signature_rejected"`, `provider: "novu"`,
  `reason: "signature_mismatch"`;
- `ipHash` matches `/^[0-9a-f]{16}$/`, and the record does not contain the raw
  caller address (`203.0.113.77`, sent in `x-forwarded-for`);
- no `to`, no `headers`, no `signature` property.

The card's wording — "the invalid-signature warn carries `provider` plus a
reason only" — is read as _the provider, why, and a correlation hash, never the
request_: the shipped call already carries `event` and `ipHash`, and §5.3's own
rule ("where correlation is needed, log a stable hash") makes the hashed IP a
requirement rather than a leak. Pinning that exact set is the stronger form of
the card's intent: a field **added** to that call reds the case, which is
precisely the leak class.

**What this arm cannot catch, stated plainly.** `redactEntry`
(`server/logging/redaction.ts`, pinned by `redaction.test.ts`) masks
email-shaped values in **any** string field and redacts sensitive keys, so a
mutation that leaks the raw address as a value stays green — the port is the
active control there and the address assertion is a defence-in-depth backstop.
The biteable negatives are the signature value (a `v1,<base64>` run matches no
value pattern unless it is stored under a key named `sig`/`signature`) and the
raw caller IP (which matches none). §Evidence measures both.

### 4. `I12` — the blank-secret arm

`it.each` over the two arms the card names — `NOVU_WEBHOOK_SECRET` **absent**
and **blank** — via `vi.stubEnv`, with `vi.unstubAllEnvs()` in a
`describe`-local `afterEach`. `getNovuRuntimeConfig()` reads `process.env` on
every call, so no re-boot is needed.

The decisive detail: the request is signed with the **empty** key
(`makeNovuWebhookHeaders({ secret: "" })` → `HMAC-SHA256` under a zero-length
key). A receipt signed with the real secret would be rejected by the HMAC
comparison even without the guard, so it would not discriminate; a receipt
signed with the empty key is accepted the moment the guard is removed —
measured `expected 200 to be 401` in §Evidence. The case also asserts the named
code `invalid_signature`, that the inbox holds **zero** rows, and that no
projection was scheduled.

`NOVU_WEBHOOK_SECRET` therefore stays **optional** in
`server/config/env.ts`: the test fixture (`src/test/factories/env.ts`) is mine,
every other suite's is not, and a required key would break every suite that
boots through `startTestApp` → `makeEnv`.

### 5. `I13` — the stored-row arm

One hard bounce, then the stored row is read back and asserted by **key**:

- `Object.keys(row).sort()` equals
  `["_id", "channel", "contactHash", "createdAt", "expiresAt", "reason", "scope", "source"]`;
- `row` has no `contact` property, and its JSON contains no part of the raw
  address;
- `contactHash` is `sha256:` + the **ledger's** digest, with `reason:
"hard_bounce"` and `scope: "all"`.

A removed field reds as loudly as an added one, and the diff names the offender
(`expected [ '_id', 'channel', 'contact', …(6) ] to deeply equal [ '_id', 'channel', …(6) ]`,
§Evidence).

### 6. Characterization, not RED-by-design

All six cases are green on arrival: ADR-0882 shipped every behaviour they
assert, so the PR is non-draft. The pin's value is that each one is
**load-bearing** — six mutations of the two production files each red the
intended case and nothing else, §Evidence. There is no defect to drive here, so
no GREEN sibling is created.

### 7. Deliberately not done

- **No production change, no fixture or helper change.** Both production files
  are byte-identical to `c96c2d18` after every probe
  (`receipt-projection.ts` `sha256 fe6cebe8…f4fe`, `route.ts` `sha256 5f6dce9f…2822`).
- **The upgrade/downgrade semantics of an existing suppression row** —
  `t_df4e6eb3` + `t_b7bcc125`.
- **The `duplicate_ignored` replay arm, the `stale_signature` arm, the rotation
  arm and the unmatched-receipt arm** — `I5`, `I7`, `I8` own them.
- **The receipt's `env` label and `expireAt` retention** — unpinned since
  ADR-0875, and §10.1.3 says nothing about them for this provider.
- **The `webhook-projection-sweep` re-projection** — a different path with its
  own card.
- **The projection's own success-path log lines.** There are none at
  `level: "trace"`, which is why `I10` drives the warn arm to make its negatives
  non-vacuous.

## Consequences

- A naive `insertOne` for the suppression (or a `$setOnInsert` replaced by
  `$set`) reds `I9` at the inbox assertion with the second receipt recorded as
  `error` — the exact regression the unique index makes easy to write.
- A field added to `warnRejectedSignature`, a raw caller address in place of its
  hash, or the signature header logged under any key that is not literally
  `sig`/`signature` reds `I10`/`I11` — the leak is local and its diff names the
  key.
- Removing the blank-secret guard reds both `I12` arms and nothing else, so a
  fail-open deployment cannot ship quietly.
- Adding any field to the suppression document reds `I13` — including one that
  stores the raw contact, which the two `objectContaining` cases cannot see.
- The spec grows from 14 to 20 cases (`+329/−0` in one file). The
  `docs/adr/README.md` ledger row for `0884` is the only shared-file edit; the
  two cells stay at `0888`.

## Alternatives

1. **A separate spec file.** Rejected: the six cases need six of this file's
   helpers, and copying them creates two fixtures that drift (the OP-137 GREEN
   already depends on the fan-out producing the digest the projection matches).
2. **Assert the warn by `toMatchObject`.** Rejected: that is the exact blindness
   F3 measured on `I2`/`I4`. The exact field set is the pin.
3. **Sign the blank-secret request with the real secret.** Rejected: it is
   green under _any_ implementation that compares HMACs, so it would not
   discriminate; the empty-key signature is the arm that only a guard can
   refuse.
4. **Boot a second `TestApp` with the secret unset.** Rejected: it costs a
   second database and a second index build for a value the config module reads
   per call; `vi.stubEnv` is the seam that already exists.
5. **Pin `source`/`createdAt` as "unchanged" by the second receipt.** Rejected:
   that is the upgrade question, and `t_df4e6eb3` owns it. The card asks for
   `reason`/`scope` only.
6. **Assert the suppression row with `expect.objectContaining` plus a
   `not.toHaveProperty("contact")`.** Rejected: the named absence catches
   `contact` but not the next field; the exact key set catches both directions.

## Evidence

Base `origin/main` `c96c2d18`. All runs are the `integration` project in a
**throwaway** worktree detached at the delivered spec commit (`6ac2773e`), with
the lane's `node_modules` symlinked, so the lane's tree stayed clean throughout.

Baseline and delivered, same worktree:

```
base spec (14 cases, written out of origin/main):  Test Files  1 passed (1)   Tests  14 passed (14)
delivered (20 cases):                              Test Files  1 passed (1)   Tests  20 passed (20)
```

Green on arrival, so six mutations of the two production files were used to show
each case bites. Each was applied alone, the whole file was run, and the file was
then restored with `git checkout --`; both hashes returned to the baseline every
time and `git status --porcelain` was empty:

| Probe | Mutation                                                                                                                                                       | Result                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1    | `receipt-projection.ts`: the upsert replaced by a naive `insertOne`, with a `catch` that stamps the row `processResult: "error"` — the shape the card predicts | `1 failed \| 19 passed (20)` — **`I9` alone**; the recorded rows, surfaced verbatim by a throw in the probe copy, were `[["msg_op137_receipt_bounce_0001","applied",null],["msg_op137_receipt_bounce_0002","error","duplicate suppression"]]` |
| M2    | `route.ts`: one field added to the warn call (`userAgent`)                                                                                                     | `1 failed \| 19 passed (20)` — **`I11` alone**, `expected [ 'event', 'ipHash', 'level', …(5) ] to deeply equal [ 'event', 'ipHash', 'level', …(4) ]`                                                                                          |
| M3    | `route.ts`: `hashClientIp` returns the raw address instead of its 16-hex digest (key set unchanged)                                                            | `1 failed \| 19 passed (20)` — **`I11` alone**, `expected '203.0.113.77' to match /^[0-9a-f]{16}$/`                                                                                                                                           |
| M4    | `route.ts`: the blank-secret refusal deleted                                                                                                                   | `2 failed \| 18 passed (20)` — **both `I12` arms**, `expected 200 to be 401` (a receipt signed with the empty key is accepted)                                                                                                                |
| M5    | `receipt-projection.ts`: `contact: receipt.contact` added to the suppression `$setOnInsert`                                                                    | `1 failed \| 19 passed (20)` — **`I13` alone**, `expected [ '_id', 'channel', 'contact', …(6) ] to deeply equal [ '_id', 'channel', …(6) ]`; `I2`, `I4` and `I9` stay green, which reproduces the F3 measurement exactly                      |
| M6    | `route.ts`: the `webhook-signature` header added under a non-sensitive key (`sigHeader`)                                                                       | `2 failed \| 18 passed (20)` — **`I10`** (`expected '[{"event":"webhook.signature_rejected…' not to contain 'v1,IcYfatjpdjqBEZvKilwwCjWqJOxVWVkd9Z…'`) and **`I11`** (the field set)                                                          |

M2 and M3 are one mutation each on the two halves of `I11` — the field set and
the value — because a field-set pin that no value check backs would let a leak
through under an existing key, and a value pin with no field set would let a new
key through under a masked value. M6 shows the same pair for `I10`'s signature
assertion. A green address mutation is **not** claimed anywhere: the redaction
port masks it (§3).

Delivered-spec gates, all on the lane worktree at the delivered head:

- `./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit` → exit `0`
- `./node_modules/.bin/eslint <spec>` → exit `0`, no warnings
- `./node_modules/.bin/prettier --check <spec>` → `All matched files use Prettier code style!`
- the six `adr-*` guards
  (`adr-numbering`, `adr-lane-ranges`, `adr-record-links`,
  `adr-inline-code-spans`, `adr-source-references`, `adr-consumers`) →
  `6 passed (6)`, `236 passed (236)`. Before this record existed, the spec's two
  `ADR-0884` mentions were reported by `adr-source-references` as
  `dangling-reference` (two issues, lines 771 and 776) — the guard caught the
  unwritten record, which is why the record is part of this delivery.
- full `unit` → `189 files`, `3171 passed | 3 skipped (3174)` — identical to the
  trunk count in the GREEN's handoff, so no other unit spec moved.
- full `integration` → `149 files`, `1577 passed (1577)`; the OP-137 spec alone
  is `20 passed (20)` (14 delivered + 6 appended). No case is skipped.

## Review — round 1

**Changes requested, record only.** The reviewer independently reproduced the
delivery at `2a688e25`: the focused spec `20 passed (20)`, full `integration`
`1577 passed (1577)`, the six `adr-*` guards `236 passed (236)`, `tsc` `0`,
`eslint` `0`, `prettier --check` clean, the fourteen delivered cases
byte-identical and no production file in the diff; four of the six mutations
(M1, M3, M4, M5) were re-run and each landed alone, exactly as §Evidence says.
The six pins are **accepted as delivered** — no case, helper, fixture or
constant changed in this round.

Three defects in **this record** were measured and corrected:

| Defect | Was                                                                                                                   | Now                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | the ledger note linked a filename that never existed (the `-pins` suffix on this record's name)                       | it points at `ADR-0884-op137-receipt-hygiene.md`                                                                                                      |
| D2     | "five mutations" in §6, in the §Evidence intro and in the ledger index row, where §Evidence tabulates **six** (M1–M6) | "six" in all three places                                                                                                                             |
| D3     | §1 read "three new `describe` blocks, six cases (five `it` plus `it.each` with two arms)"                             | **four** `describe` blocks, six cases (**four** `it` — `I9`, `I10`, `I11`, `I13` — plus one `it.each` with two arms), which is what the spec measures |

D1 is why the review opened a follow-up: `checkAdrRecordLinks` scopes
`docs/adr/README.md` out by design — the exclusion exists for legitimate
pre-rename targets — so a never-existed filename in the ledger stayed invisible
to all six guards, which read `236 passed (236)` with the break present. Card
`t_0fb7e9b0` pins that discriminator in both directions. D2 and D3 are
prose-only miscounts: the mutations and cases they describe were correct, and
the counts now match the table.

The trunk moved while this card was in review (`f370cf5b`, PR #757, which brought
`ADR-0886` and `ADR-0890`), so the branch carries one merge of `origin/main`
(`21840194`) and `docs/adr/README.md` was resolved as a union: the shared `0887`
note kept once, in the trunk's exact bytes, then this record's `0884` note and the
trunk's `0890` note. `0884` is still free on the trunk — the highest record is
`0890` and no `ADR-0884` path exists there — so the number does not change. The
merge touches no file of this delivery: `git diff --numstat origin/main` is
`329 0` in the pin spec, `359 0` in this record and `3 0` in the ledger, and both
production hashes are unchanged from §7.
