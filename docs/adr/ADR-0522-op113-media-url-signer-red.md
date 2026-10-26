# ADR-0522 — OP-113 RED: the path-bound HMAC media URL signer — known vectors, secret rotation and the TTL invariants

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-113 RED (`t_d7caeeb0`) · **Branch:** `OP-113-task-media-url-signer` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_d7caeeb0`
- **Relates to:** [ADR-0520](ADR-0520-op112-object-storage-port-red.md) / [ADR-0521](ADR-0521-op112-object-storage-port-green.md) (the sibling storage lane — the opaque-handle HMAC precedent this signer mirrors, and the `MEDIA_SIGNING_SECRET_CURRENT` note), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card continues the lane's `0520`–`0539` block), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design posture)
- **Contract:** §5.6 (media signed URLs — `{url, expiresAt}`, token lifetimes "thumbnails **24 h**, originals **15 min**. Never invert these") and §5.7 (the data plane — the signature scheme `payload = METHOD + "\n" + PATH + "\n" + EXPIRY`, `signature = base64url(HMAC-SHA256(MEDIA_SIGNING_SECRET, payload))`, `GET https://pic.openpic.in/{t|o}/<sha256>.<ext>?exp=<unix>&sig=<base64url>`) of `docs/API Contract.md`, and the media doc §8/§21 references they name. The media data plane is a Cloudflare Worker **outside the byte path of the control plane** — the Worker authorizes image delivery purely from the URL this signer mints.

## Context

OP-113 is the signing half of the Media Foundations epic: path-bound signed media
URLs so the Cloudflare Worker can authorize `pic.openpic.in` delivery without the
control plane in the byte path. The user story is one sentence: _"[I want]
path-bound signed media URLs so that the Cloudflare Worker can authorize image
delivery without the control plane in the byte path."_

The card's test list is short — U1 known vector, U2 one-character path change →
false, U3 thumbnail token on `/o/` → false, U4 expired → false, U5 previous
secret verifies while configured then fails after removal, U6 thumbnail TTL >
original TTL invariant, U7 preview token on `/o/` → false — and it names almost
no module paths or signatures beyond the shared-vector fixture path
(`packages/contracts/fixtures/media-signing-vectors.json`) and the GREEN card's
`mediaSigner.sign(...)` sketch. This record fixes the executable contract the
tests encode, so the GREEN (`t_f74453a8`) has one coherent spec to implement.
The sibling GREEN's scope notes add: a `preview` derivative at `/p/<sha>.<ext>`
with a TTL strictly between the thumbnail and original TTLs, `verify()`
accepting CURRENT **or** PREVIOUS, and TTLs living in config/settings "never
inverted".

## Decisions

### 1. Module layout — one pure module

| Module                  | Exports                                                                                                                                     | Drives |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `@/server/media/signer` | `MediaDerivativeKind`, `SignMediaInput`, `SignedMediaUrl`, `MediaSignerConfig`, `MediaSigner`, `createMediaSigner`, `MEDIA_URL_TTL_SECONDS` | U1–U7  |

`@/server/runtime/crypto` (OP-72: `hmacSha256Base64Url`, `timingSafeEqualStr`)
and `@/server/runtime/clock` (OP-72: `Clock`, `systemClock`) already exist on
`main` and are reused, not re-declared — the signer is the OP-72
"inject a `Clock`" pattern applied to §5.7. The module is **pure**: it reads no
environment at import. Secrets and the clock are injected through
`createMediaSigner({ currentSecret, previousSecret?, clock? })` (the
`createHandleService({ secret })` shape, ADR-0520 §1); the composition root
(GREEN's free choice, unpinned) reads `config.media.signingSecretCurrent` /
`signingSecretPrevious` — the `MEDIA_SIGNING_SECRET_CURRENT` /
`MEDIA_SIGNING_SECRET_PREVIOUS` env keys already validated by OP-70's
`env.ts`.

### 2. The signature scheme (API Contract §5.7, verbatim)

```
payload   = METHOD + "\n" + PATH + "\n" + EXPIRY
signature = base64url(HMAC-SHA256(secret, payload))
```

- `METHOD` is `GET` (the data plane serves GET only; `sign` always signs GET).
- `PATH` is the **URL pathname only** — `/{t|o|p}/<sha256>.<ext>` — never the
  query. U2's one-character hash flip and U3/U7's segment swap are the pins
  that force exact path binding.
- `EXPIRY` is the decimal `?exp=` value **verbatim** (the same string the URL
  carries), so `exp` is self-consistent: `sign` computes `exp = floor(now/sec) +
ttl` and `verify` compares `now >= exp → refused` (valid strictly before `exp`).
- `sig` is compared with `timingSafeEqualStr`; `verify` tries `currentSecret`
  first and falls back to `previousSecret` only when configured (U5).
- `verify(url, method = "GET")` never throws: an unparseable URL or a missing
  `exp`/`sig` answers `false` (the Worker must 403 garbage, never 500).

### 3. Kind → segment map

| Kind        | Segment | Source                                    |
| ----------- | ------- | ----------------------------------------- |
| `thumbnail` | `/t/`   | §5.7                                      |
| `original`  | `/o/`   | §5.7                                      |
| `export`    | `/o/`   | **Assumption** — §5.7 defines exactly `{t | o}`; there is no `/e/` segment |
| `preview`   | `/p/`   | GREEN card §5                             |

The segment is pinned by the URL-shape test for all four kinds and by the
cross-segment negatives U3/U7.

### 4. TTL defaults — the U6 invariant

`MEDIA_URL_TTL_SECONDS` is a `Readonly<Record<MediaDerivativeKind, number>>` of
kind defaults applied when `sign(input, ttlSeconds?)` omits the explicit TTL:

| Kind        | Seconds | Contract source                                |
| ----------- | ------- | ---------------------------------------------- |
| `thumbnail` | 86400   | §5.6 "thumbnails **24 h**"                     |
| `original`  | 900     | §5.6 "originals **15 min**"                    |
| `preview`   | 7200    | strictly between the two (GREEN card §5)       |
| `export`    | 900     | full-size output; the card names no export TTL |

U6 pins the exact 24 h / 15 min constants, the strict ordering (thumbnail >
preview > original), the completeness of the map over the four kinds, **and** the
behavioral consequence: signing without an explicit TTL renders `exp` at exactly
`now + kind-default`, so `?exp=` ordering mirrors the constant invariant. The
"config/settings" phrase is read as immutable module-level constants (the pure
module the Worker-parity `verify` shares); a `platformSettings` override lane
would be new tests.

### 5. Output shape — `SignedMediaUrl`

`sign` returns `{ url, expiresAt }` exactly as §5.6's envelope pairs them:
`url` is the full `https://pic.openpic.in/{seg}/<sha256>.<ext>?exp=<unix>&sig=…`
(host fixed at `https://pic.openpic.in`, §5.7 — not configurable in this lane)
and `expiresAt` is `new Date(exp * 1000).toISOString()`.

### 6. Shared test vectors — `packages/contracts/fixtures/media-signing-vectors.json`

Published for cross-implementation parity (the Worker team implements the same
scheme and checks against the same file). Three vectors (original `/o/`,
thumbnail `/t/`, preview `/p/`, all under one low-entropy test secret, far-future
`exp` 4102444800 so they never rot) carry the preimage scheme, secret, and per
vector the path/exp/ttl/sig and the full signed URL. U1 pins **both**
directions: `sign` reproduces each published `sig` byte-for-byte, and `verify`
accepts each published `url`. The fixture's secret equals the factory constant
`TEST_MEDIA_SIGNING_SECRET_CURRENT`, so an implementation built from the
factories verifies the published vectors.

## Consequences

- The signature covers method, pathname and expiry — never the query, never the
  host — so the same URL verified under a different method, on a different
  segment, or with a one-character path change recomputes to a different MAC and
  is refused. A future "clip the query" cache-keyer (media doc §13) is
  explicitly compatible: `exp`/`sig` are query params, the signed pathname is
  stable.
- Rotation is a config change: while `previousSecret` is set, old URLs verify;
  removing it revokes them without re-signing anything (the §5.6 batch resolver
  re-mints on 403, so a rotation window has no user-visible break).
- `verify` never throws → the Worker's failure mode is uniformly `403`, matching
  §5.7's client contract ("403 means expired or invalid signature → refresh,
  retry once").
- The README ledger gains the lane row (`0520`–`0539`, `Next free 0523`) and
  advances the `unallocated (future lanes)` pool to `0540`+. The unmerged
  OP-112 branch already holds the identical row with `Next free 0522` and the
  same pool edit; union-resolution at merge keeps `0523` (every cell at its
  highest value) — flagged in the handoff.

## Assumptions and open questions

- **`export` signs to `/o/`.** §5.7's data plane has exactly `{t|o}` and no `/e/`
  segment, so the export derivative (a re-encoded full-size deliverable) shares
  the originals segment. If a future lane wants a distinct `/e/` segment, that is
  new pins.
- **`contentHash`/`ext` are not validated by the signer.** The signer binds
  whatever path it is given; the 64-hex shape is the _key builder's_ concern
  (ADR-0520 U2) and the caller's responsibility here. The vector fixture and all
  factories use a valid lowercase hex SHA-256.
- **The host is not signed** (the §5.7 preimage has no host line), and the
  fixed base is `https://pic.openpic.in` — the Worker fronts exactly one host,
  so host binding would add nothing to the scheme.

- **Composition root / route wiring is out of this lane's scope.** No route
  signs URLs in the card; the env keys (`config.media.*`) already exist and the
  GREEN may add a `getMediaSigner()` selector without breaking any pin.
- **Logging.** The GREEN's security note says "never log full signed URLs; log
  counts of URLs signed at debug". The pure module has no logging seam; the pin
  belongs with the route lane that calls `sign` — recorded here so it is not
  lost.
- **`verify`'s expiry boundary is pinned strictly** (valid while `now < exp`,
  refused at `now >= exp`). A Worker that treats `now === exp` as valid would
  fail U4's `atExp` case.

## ADR number allocation

Consumed `0522` — the lane's `Next free` per the OP-112 GREEN handoff (`lane
Next free 0522`), re-read on the current base `a247a42`. As the card that lands
the ledger row, this record writes the lane's `Next free` cell to `0523`. No
number outside the lane range `0520`–`0539` is touched; the shared
`docs/adr/README.md` is the known hotspot and is union-resolved at merge (the
unmerged OP-112 branch holds `0520`/`0521` and the same row).
