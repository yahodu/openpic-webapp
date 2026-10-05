# ADR-0046 — OP-89 follow-up RED pins: the identity-lifecycle index/TTL shapes and the bounded new-device read

- **Status:** Accepted (RED pins) · **Date:** 2026-10-06
- **Card:** OP-89 `t_13bcd988` (phase 1-Identity, epic Authentication, RED follow-up) · **Amends:** ADR-0043, ADR-0044 (adds the missing pins; does not supersede them)
- **Contract:** schema §13.2 (`userProfiles`), §13.5 (device sightings), §21 (index invariants), §22 (retention/TTL); ADR-0040 §2, ADR-0041 §2/§4, ADR-0043 §2–§4
- **Branch / PR:** `OP-89-task-identity-indexes-red` (draft) — append-only extension of `apps/web/src/server/db/indexes.test.ts` and `apps/web/src/test/integration/identity-hooks.test.ts`.

## Context

The OP-89 identity-lifecycle index/TTL follow-up (PR #162, ADR-0043) declared the
five `INDEX_SPECS` entries the app-owned identity collections need and bounded the
new-device read. Its review (ADR-0044) merged it and routed two **coverage gaps**:

1. **Low — the new declarations are unpinned.** `indexes.test.ts` only lints the
   _shape of whatever specs exist_ (U1/U2), and `index-bootstrap.test.ts` I1
   compares the created set to `INDEX_SPECS` **against itself**. So a regression
   that deletes the `sessionDevices` TTL or `{userId, createdAt}` index, the
   `contactChangeFanouts` TTL, or the `userProfiles` unique `{userId:1}` index
   fails nothing.
2. **Low — the 100-sighting read cap can drop an in-window prior sighting.** A
   user with >100 sightings in 24 h whose _matching_ device is not among the 100
   newest is mis-classified as a new device, so `handleSessionCreated` re-emits
   `auth.signin.new_device`. The per-device 24 h-bucket `dedupeKey`
   (`auth.signin.new_device:${userId}:${deviceHash}:${bucket}`) is the outbox
   backstop, but the hook still _decides_ wrongly.

This ADR records the pins and the **chosen semantics** for finding 2.

## Decision

### 1. Pin the specific index shapes (finding 1)

A new `describe("index spec pins — OP-89 identity lifecycle (ADR-0046)")` block
in `apps/web/src/server/db/indexes.test.ts` names each index and asserts its
exact shape, rather than re-deriving the generic lint (which stays green even
when the entry is deleted):

| Spec name                              | Collection             | Asserted shape                                                     |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `session_devices_user_created`         | `sessionDevices`       | `[[userId,1],[createdAt,-1]]`                                      |
| `session_devices_expire_at_ttl`        | `sessionDevices`       | `[[expireAt,1]]`, `expireAfterSeconds === 0`                       |
| `contact_change_fanouts_expire_at_ttl` | `contactChangeFanouts` | `[[expireAt,1]]`, `expireAfterSeconds === 0`                       |
| `user_profiles_user_id_unique`         | `userProfiles`         | `[[userId,1]]`, `unique === true`                                  |
| `user_profiles_deletion_pending`       | `userProfiles`         | `[[status,1],[deletionScheduledAt,1]]`, partial `deletion_pending` |

These five specs are **green against the delivered `main`** (the declarations
exist) and are **red-capable**: verified by deleting/renaming one declaration,
which turns exactly its spec red (e.g. `missing index declaration
'user_profiles_user_id_unique': expected undefined to be defined`). They exist
so that a future regression cannot be silent, not because the behaviour is
missing.

### 2. The new-device read must not drop an in-window matching sighting, and stays bounded (finding 2)

**Chosen semantics:** a device the user has already used **within the 24-hour
window** is **not** new, regardless of how many other sightings the user has;
and the read must **never return more than the 100-sighting cap**. The cap may
not be a reason to miss an in-window match, and the match may not be found by
removing the bound (an unbounded read on the sign-in path).

Three append-only specs in `apps/web/src/test/integration/identity-hooks.test.ts`
pin this:

- **R1** (RED today) — seed 149 newer sightings of other devices plus the
  matching device's in-window sighting as the oldest row; `handleSessionCreated`
  must **not** attempt `auth.signin.new_device`. The delivered code reads the
  newest 100 rows, drops the match, and emits — R1 fails with
  `expected [ 'auth.signin.new_device' ] to not include 'auth.signin.new_device'`.
- **R2** (green today) — with 150 in-window sightings and a genuinely new device,
  the read must run once and return **≤ 100** rows. A read wrapper measures the
  terminal `toArray()` length. Removing the `.limit(100)` makes R1 pass but R2
  fail (`expected 150 to be less than or equal to 100`), so the pair forces a
  fix that keys the read on the device fingerprint (bounded) instead of widening
  the slice.
- **R3** (green today, added by follow-up card `t_a6da1734`) — with 150 in-window
  sightings that are **all the incoming device** (same `fingerprintHash` seen 150
  times), `handleSessionCreated` must still suppress `auth.signin.new_device`
  **and** the read must run once and return **≤ 100** rows. R2 alone is vacuous
  under the recommended device-keyed fix (its 150 _distinct-device_ rows match no
  `fingerprintHash`, so the read returns 0 and `≤ 100` holds trivially even with
  the `.limit(100)` removed). R3 restores the guard: under a device-keyed read
  with the cap dropped, all 150 matching rows are returned and R3 fails with
  `expected 150 to be less than or equal to 100` — verified by temporarily
  applying exactly that read shape locally (production file reverted, no
  production change shipped). R3 passes both against the delivered code and
  against a device-keyed bounded fix, and is red only against the dropped cap.

A conforming GREEN implementation reads the user's in-window sightings **for the
incoming device's hash** (e.g. add `fingerprintHash` to the find filter, still
`createdAt > now − window` and `limit ≤ 100`), so the decision is correct and
the read stays bounded.

## Consequences

- `indexes.test.ts` gains 5 specs (all green; red-capable), the integration
  `identity-hooks` suite gains 3 (R1 RED; R2/R3 green). The intended RED state is
  exactly one failing spec: `R1`.
- A follow-on GREEN card is required to satisfy R1 without breaking R2; the RED
  branch is a draft PR and is not merged (RED pins ship in the gated GREEN PR).
- The `auth.signin.new_device` emit/payload/dedupeKey contract is unchanged; the
  fix is confined to the read predicate in `handleSessionCreated`.

## Alternatives considered

- **Pin only the outbox-level observable (`eventsByKey` length).** Rejected: the
  per-device `dedupeKey` collapses a duplicate emit to one row, so the outbox
  count is 1 whether or not the hook decides wrongly; only an injected emit seam
  observes the decision. R1 records `eventKey`s through the existing `emit`
  dependency, adding no production code.
- **Accept the cap and pin "a duplicate may emit".** Rejected: it would encode a
  false "new device" alert as intended behaviour; the security-correct semantics
  is that an in-window sighting always suppresses the event. R2 keeps the read
  bounded, so the fix cannot simply drop the cap.
- **Test the bound by asserting the literal `.limit(100)` argument.** Rejected:
  that couples the spec to the query builder; measuring the returned row count is
  an observable resource bound and survives a read restructuring.

## Numbering

ADR-0043 is the indexes/TTLs implementation and ADR-0044 its review sign-off.
**ADR-0045 is reserved** for the sibling OP-89 RED-pins follow-up
(`t_7ce3d03c`, renumbered by its GREEN card `t_42a91a52`). This ADR therefore
takes **0046** to avoid that collision.
