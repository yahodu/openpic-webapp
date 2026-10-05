# ADR-0043 — OP-89 follow-up: declare the identity-lifecycle collections' indexes and TTLs

- **Status:** Accepted (implementation) · **Date:** 2026-10-06
- **Card:** OP-89 `t_5e541eaa` (phase 1-Identity, epic Authentication) — follow-up to the GREEN review findings 1–3 (ADR-0042) · **Amends:** ADR-0040 §2, ADR-0041 §2/§4 (backs their claims; does not supersede them)
- **Contract:** schema §13.2 (`userProfiles`), §13.5 (device sightings), §21 (index invariants), §22 (retention/TTL); ADR-0040 §2, ADR-0041 §2/§4
- **PR / branch:** `OP-89-task-identity-indexes`

## Context

The OP-89 GREEN implementation (PR #161, ADR-0041) introduced or relied on three
app-owned collections whose indexes and retention were never declared in
`INDEX_SPECS`. The suite was green because no test pins those collections'
indexes, but each is a production scaling or privacy defect (ADR-0042 findings
1–3):

1. **`sessionDevices`** is written on every sign-in (`session.create.after`) and
   read with an unbounded `find({ userId }).toArray()`. No index, no expiry →
   an ever-growing collection per user, and a linear scan on the sign-in path.
2. **`contactChangeFanouts`** carries raw previous/current contacts and an
   `expireAt` (7 d) but had no TTL index — so MongoDB never deletes the rows,
   and ADR-0040 §2's "short-lived / TTL-bound" PII justification did not hold.
3. **`userProfiles`** has no declared index at all, so ADR-0041 §4's claim that
   its `userId` is unique (and the `autoProvisioned` precedence therefore
   "inert") rested on an unenforced assumption.

## Decision

`INDEX_SPECS` in `apps/web/src/server/db/indexes.ts` remains the single source of
truth; this ADR only adds the missing declarations (and the one bounded read the
first one needs).

### 1. Register the app-owned identity collections in `COLLECTIONS`

`userProfiles`, `notificationPreferences`, `sessionDevices` and
`contactChangeFanouts` are now entries of `COLLECTIONS` (schema §12/§13.2/§19.3),
and their owning modules (`identity-hooks.ts`) reference the registry values
rather than private string literals. `IndexSpec.collection` is typed
`CollectionName`, so an unregistered collection cannot carry a declared index;
the previous "deliberately not in `COLLECTIONS`" status is what let the gaps
exist. This is the enabling change for the specs below — no behaviour changes.

### 2. `sessionDevices` — index, TTL and a bounded read (High)

- Index `session_devices_user_created` = `{ userId: 1, createdAt: -1 }`, which
  backs the new-device read (`userId`, `createdAt > now − 24 h`, newest-first).
- A new `expireAt` field is stamped on every insert (now + 7 d) and backed by the
  TTL index `session_devices_expire_at_ttl` (`{ expireAt: 1 }`,
  `expireAfterSeconds: 0`). The 7-day retention is comfortably longer than the
  24-hour `NEW_DEVICE_WINDOW_MS` so a sighting is never reaped while it can still
  suppress a duplicate `auth.signin.new_device`.
- `handleSessionCreated` now reads
  `find({ userId, createdAt: { $gt: now − windowMs } }).sort({ createdAt: -1 }).limit(100)`
  instead of loading the user's entire history. The window filter is exactly the
  predicate `isNewDevice` already applies, so the decision is unchanged; the
  limit (100 newest) is a guard, and the per-device 24-hour-bucket `dedupeKey`
  remains the backstop against a duplicate emit if a device falls outside the cap.

### 3. `contactChangeFanouts` — TTL index (High, privacy)

`contact_change_fanouts_expire_at_ttl` (`{ expireAt: 1 }`,
`expireAfterSeconds: 0`) makes the record actually short-lived, so the raw
previous/current contacts are deleted shortly after the fan-out reads them —
restoring ADR-0040 §2's justification for holding them outside the append-only
outbox.

### 4. `userProfiles` — the schema §13.2 indexes, including `{ userId: 1 }` unique (Medium)

Declared exactly as schema §13.2 specifies:

| Index                                   | Name                                 | Notes                         |
| --------------------------------------- | ------------------------------------ | ----------------------------- |
| `{ userId: 1 }`                         | `user_profiles_user_id_unique`       | **unique**                    |
| `{ platformRole: 1, status: 1 }`        | `user_profiles_platform_role_status` | admin fan-out                 |
| `{ status: 1, deletionScheduledAt: 1 }` | `user_profiles_deletion_pending`     | partial on `deletion_pending` |
| `{ primaryTenantId: 1 }`                | `user_profiles_primary_tenant`       | default-workspace lookup      |

**Chosen route: back ADR-0041 §4 with a real unique index** (not correct the
ADR). With `user_profiles_user_id_unique` declared and built by
`ensure-indexes`, `userProfiles.userId` is 1:1 in every environment, so the
`autoProvisioned` precedence in `guards.loadProfile` is a defensive tie-break
that never triggers in production — exactly what ADR-0041 §4 claims. ADR-0041 is
left unedited per the ADR policy (never edit an accepted ADR); this ADR records
that its assumption is now enforced.

The undocumented `autoProvisioned` field (set by `handleUserCreated`, read by
`guards.loadProfile`) is added to the schema §13.2 field table as well.

## Consequences

- `ensureIndexes` builds the seven new indexes in one idempotent pass; the
  `index-bootstrap` integration suite (I1) already asserts `created` equals the
  full declared set, so the new specs are exercised without a test edit.
- Full suite green after the change: unit 1319, integration 225; `tsc` (three
  projects), ESLint (0 errors) and Prettier clean.
- The OP-86 integration fixtures (`auth-guards`, `admin-two-factor-signin`,
  `me-ban-exemption`) insert a second `userProfiles` row for one user, but those
  suites never call `ensureIndexes`, so the new unique index does not reach them.
  In production (and any indexed environment) the same pattern must `upsert`.
- A regression that removes the TTL, drops the `{ userId, createdAt }` index, or
  reverts `userProfiles.userId` to non-unique fails the `indexes.test.ts` U1/U2
  lint or the bootstrap I1 set comparison.

## Coverage gaps (requests for the Test Author's next cycle)

- No spec pins the `sessionDevices` TTL field/window or the read's window/limit;
  they are implementation choices this ADR records.
- No spec asserts the `userProfiles` index set (unique `userId`, the partial
  deletion index); only the generic registry lint covers them.
- The `autoProvisioned` precedence (duplicate-profile tie-break) remains unpinned
  (carried from ADR-0041 "Coverage gaps").

## Alternatives considered

- **Add the `userProfiles` unique index and leave ADR-0041 §4 saying the rule is
  load-bearing.** Rejected: the unique index is the schema's stated invariant
  (§13.2) and makes the tie-break genuinely inert; correcting the ADR to call a
  schema-backed rule "load-bearing" would document a weaker design.
- **Prune `sessionDevices` outside the window in the hook instead of a TTL.**
  Rejected: a read-path prune adds a write and a scan to every sign-in for the
  long tail of users who never sign in again; the TTL monitor reaps them without
  touching the request path.
- **A per-fingerprint rather than per-sighting document.** Rejected: it would
  change the stored shape the RED pins tolerate and lose the sighting timeline;
  out of scope for an index/TTL follow-up.
- **Widen `IndexSpec.collection` to `string` instead of registering the
  collections.** Rejected: it removes the compile-time guarantee that an index is
  declared on a known collection — the very guarantee whose absence caused these
  findings.
