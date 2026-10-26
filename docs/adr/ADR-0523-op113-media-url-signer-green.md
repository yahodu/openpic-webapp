# ADR-0523 — OP-113 GREEN: the path-bound HMAC media URL signer implemented — secret rotation, the TTL invariants and the shared vector fixture

- **Status:** Accepted · **Date:** 2026-10-26
- **Card:** OP-113 GREEN (`t_f74453a8`) · **Branch:** `OP-113-feature-media-url-signer` · **Worktree:** `/root/openpic/openpic-webapp/.worktrees/t_f74453a8`, stacked on the RED head `1b6c25c`
- **Relates to:** [ADR-0522](ADR-0522-op113-media-url-signer-red.md) (the RED contract this card turns green), [ADR-072](ADR-0072-op92-message-transport-and-novu-drift-guard-red.md)* (the OP-72 Runtime Primitives epic the signer reuses — `hmacSha256Base64Url` / `timingSafeEqualStr` in `@/server/runtime/crypto`, the `Clock` port in `@/server/runtime/clock`), [ADR-0300](ADR-0300-adr-number-range-allocation-policy.md) (range allocation — this card takes the lane's next free `0523`), [ADR-0306](ADR-0306-op101-stale-branch-deletion.md) (RED-by-design posture)

\* The runtime-crypto/clock modules are OP-72; if ADR-0072 is not the OP-72 record, the import line above resolves to the correct OP-72 ADR number on the merged lane.

## Context

ADR-0522 fixed the executable contract the RED's 25-case unit spec (U1–U7)
encodes. This GREEN implements `@/server/media/signer` — the single pure
module the ADR's module table names — with the one unit spec, the
`factories/media.ts` file and the `media-signing-vectors.json` fixture carried
byte-unchanged. The signer lands the §5.6–§5.7 path-bound HMAC URL scheme:
the data plane (`pic.openpic.in`) is a Cloudflare Worker outside the control
plane's byte path, and `verify` is shared between this module (for tests) and
the Worker parity fixture.

## Decisions

### 1. `sign` and `verify` answer through one `createMediaSigner({ currentSecret, previousSecret?, clock? })`

As ADR-0522 §1 prescribes — no env read at import. `currentSecret` minted the
URL with `sign`; `verify` tries `currentSecret` first, then `previousSecret`
only when configured (U5), and never throws on malformed/missing input
(returns `false`, so the Worker answers a uniform `403`). `clock` defaults to
`systemClock`.

### 2. The §5.7 signature is computed over the exact preimage and compared in constant time

`signWith(secret, method, path, exp)` = `base64url(HMAC-SHA256(secret,
"METHOD\nPATH\nEXPIRY"))` reusing OP-72's `hmacSha256Base64Url`, and `verify`
compares the recomputed MAC to the presented `sig` with `timingSafeEqualStr`
(then `previousSecret` on a miss). The path is the URL **pathname** only and
`EXPIRY` is the `?exp=` decimal **verbatim** — so U2's one-character hash
flip, U3/U7's segment swap and the method binding all recompute to a different
MAC and are refused. The expiry boundary is strict: `verify` refuses at
`now >= exp`, valid strictly before (U4).

### 3. Kind → segment → default TTL resolved by one exhaustive switch

The kind-to-segment map (thumbnail `/t/`, original `/o/`, export `/o/` — §5.7
has no `/e/`; preview `/p/`) lives in a `derivativeForKind(kind)` switch that
also returns the kind's default TTL by reading `MEDIA_URL_TTL_SECONDS`'s literal
property (`MEDIA_URL_TTL_SECONDS.thumbnail` etc.), which keeps `sign`'s
default-TTL application ($5.6) as one `ttlSeconds ?? kindDefaultTtl`. The
unknown-kind guard is separate (`kind in MEDIA_URL_TTL_SECONDS`), so a `bogus`
kind throws naming it before any switch runs.

### 4. `MEDIA_URL_TTL_SECONDS` is the single source of truth for the TTL invariant

`thumbnail: 86400` (24 h), `original: 900` (15 min), `preview: 7200` (strictly
between), `export: 900` — the U6 constants and the behavioural invariant (a
no-TTL `sign` renders `exp` exactly at `now + kind-default`) both hang off the
one record, so the ordering can never be inverted by drift.

### 5. The shared vector fixture pins both directions

U1 signs each published vector and asserts the `sig` byte-for-byte, and verifies
each published `url` — a signer keyed with the fixture secret
(`== TEST_MEDIA_SIGNING_SECRET_CURRENT`) reproduces and accepts the Worker
team's bytes, making the fixture the cross-implementation parity contract.

## Number allocation

This card consumes the lane's **`0523`** (ADR-0522: "The gated GREEN
`t_f74453a8` consumes `0523` next") and advances the lane's `Next free` cell to
`0524`. No number outside the lane range `0520`–`0539` is touched.

## Consequences

- **The data plane is off the byte path with a verified scheme**: signing is
  deterministic over method + pathname + expiry under the current secret, and
  rotation is a config change — while `previousSecret` is set old URLs verify,
  removing it revokes them without re-signing anything (U5).
- **The Worker team has a parity artifact**: `media-signing-vectors.json`
  commits the preimage scheme, secret and three signed URLs both sides must
  reproduce.
- `verify` never throws: the Worker's failure mode is uniformly `403`, matching
  §5.7's client contract.

## Evidence

At the head: focused spec **25 passed (25)**; full unit **120 files · 2074
passed | 3 skipped**; full unit + integration + coverage **205 files · 2789
passed | 3 skipped** with global coverage above the 80 % bars — statements
`92.49 %`, branches `80.97 %`, functions `96.56 %`, lines `92.88 %`; `tsc` exit
`0` on the root / `packages/contracts` / `apps/web` projects; ESLint 0 errors;
`prettier --check` clean; the `adr-numbering` guard green; gitleaks clean over
`origin/main..HEAD` (the only full-tree finding is the pre-existing
`redaction.test.ts`). The one RED test file, the factory and the vector fixture
are byte-unchanged from the RED head. No test, mock, fixture or factory was
written or edited by this card.
