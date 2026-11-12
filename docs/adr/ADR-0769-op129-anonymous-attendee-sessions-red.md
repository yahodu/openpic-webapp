# ADR-0769 — OP-129 RED: anonymous attendee sessions and the attendee auth resolver

- **Status:** Accepted (RED / executable contract)
- **Consumers:** the OP-129 RED specs — `apps/web/src/test/unit/attendee-session-token.test.ts`
  (U1), `apps/web/src/test/unit/attendee-session-cookie.test.ts` (U2),
  `apps/web/src/test/integration/attendee-sessions.test.ts` (I1–I5) and
  `apps/web/e2e/attendee-sessions.spec.ts` (E1)
- **Lane:** OP-129 (epic Attendee Identity). Reserved range `0769`–`0788`,
  `Next free = 0770`.
- **Supersedes:** nothing. **Amended by:** the OP-129 GREEN ADR (implementation
  choices left open here) and the review sign-off inside that record.

## Context

The epic's user story is _"As an attendee, I want to use an event without logging
in so that I can upload a selfie quickly and privately."_ Contract §1.5 and schema
§13.5 already specify the mechanism: a random `opat_` bearer token, stored only as
`sha256(token)` in `attendeeSessions`, sent back as the `op_att` cookie (web) or
the `X-Attendee-Session` header (mobile), with a 30-day TTL
(`platformSettings.retention.attendeeSessionDays`) and an explicit
`401 attendee_session_expired` when it lapses.

OP-86 left two seams for this lane: the `AttendeeSessionResolver` port and
`noAttendeeSessions` in `apps/web/src/server/auth/guards.ts`. `evaluateAuth`
already admits an attendee principal on the `attendee` label and a user principal
on every label, and that behaviour is already pinned by `guards.test.ts` — so the
RED does **not** re-pin the guard table. The uncovered surface is the token, the
cookie, the two routes, the persistence shape and the expiry decision.

Two constraints shaped every choice below:

1. **The token is a bearer credential to someone's face photo and matched
   photos.** §0.15 forbids returning a raw bearer token after its single issuance
   response, and schema §27 requires it hashed at rest. The pins are therefore
   mostly negative: what must _not_ be reachable.
2. **The RED must be satisfiable without inventing wire shapes.** Every assertion
   in these specs restates contract §1.5, schema §13.5, contract §0.13 (RFC 3339
   ms) or an existing repository convention; where the docs are silent, this ADR
   records the interpretation instead of hiding it in a fixture.

## Decision

### 1. The pure modules the specs import

```
apps/web/src/server/attendee/session-token.ts
  ATTENDEE_TOKEN_PREFIX: "opat_"
  generateAttendeeSessionToken(): string              // fresh on every call
  hashAttendeeSessionToken(raw: string): string       // lowercase hex SHA-256

apps/web/src/server/attendee/session-cookie.ts
  ATTENDEE_COOKIE_NAME: "op_att"
  buildAttendeeSessionCookie({ token, maxAgeSeconds, secure }): string
```

`generateAttendeeSessionToken` is the shipped `randomToken(32, "opat_")`
primitive: 32 random bytes as 43 unpadded base64url characters, which also keeps
the value inside the repository's log-redaction pattern `opat_[A-Za-z0-9_-]{6,}`
(U1 pins the shape and that property). `hashAttendeeSessionToken` is plain
SHA-256 over the **whole** token including the prefix — schema §13.5's
`{tokenHash:1}` unique index is a digest lookup, so an unsalted digest of exactly
what a client presents is the only shape that works.

The cookie builder is pure: no environment read, no clock read. `secure` and
`maxAgeSeconds` are injected, so U2 can pin both TLS shapes and the route owns
the two policy reads.

### 2. The two routes

```
POST /api/v1/p/attendee-sessions           (auth public)
GET  /api/v1/p/attendee-sessions/current   (auth attendee)
```

- `POST` body `{ eventSlug?: string }`; `201` with **exactly**
  `{ sessionToken, expiresAt, issuedAt }` (RFC 3339 ms `Z`), plus
  `Set-Cookie: op_att=<raw>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<ttl>`.
- The stored row is exactly `{ _id, tokenHash, claimedByUserId: null,
claimedAt: null, eventIds: [], deviceFingerprint: { uaHash, ipHash,
acceptLangHash }, createdAt, lastSeenAt, expireAt }` (schema §13.5), with
  `expireAt - createdAt === retention.attendeeSessionDays`.
- `GET current` answers **exactly** `{ id, kind: "anonymous", eventSlugs,
claimedByUserId, expiresAt }` and never the raw token.

The exact key sets are pinned on purpose: "the database holds `tokenHash` only"
and "the raw token is returned once" are only checkable as _what is there_, so a
future field that carried the token (or a MAC of it) has to fail loudly.

### 3. Expired is a distinct failure from absent

- a present-but-expired token → `401 attendee_session_expired` with
  `details.recreateUrl` (contract §1.5 + Appendix A);
- a missing, unknown or malformed token → `401 authentication_required`.

Collapsing the two would tell an attendee whose 30 days elapsed to sign in, and
would let a client that lost its cookie present the wrong recovery path, so the
resolver throws instead of returning `null` for the expired case. `recreateUrl`
is pinned as a non-empty site-relative string (leading `/`): contract §1.5 names
the field but not the landing page, so the exact path is the GREEN's choice.

### 4. `Secure` is environment-scoped, not absolute

Contract §1.5's example shows `Secure` unconditionally, but a browser (and
Playwright's cookie jar) drops a `Secure` cookie on a plain-HTTP origin, so the
e2e journey and local development would both break. The repository already
resolves this for the Better Auth cookie by making TLS-dependent attributes
environment-scoped (`buildCookieOptions`, `@/server/auth/cookies`), so the builder
takes `secure: boolean` and the route sets it for `staging`/`production` only. A
TLS deploy therefore always emits `Secure`; the test environment never does, which
is what lets E1 prove the cookie round trip over the real HTTP stack.

### 5. TTL comes from settings; expiry is inclusive

`expireAt` is `now + retention.attendeeSessionDays` and the cookie's `Max-Age` is
the same value in seconds. The suite seeds `retention.attendeeSessionDays = 7`
(the shipped default is 30) and invalidates the settings cache around the seed, so
a hard-coded 30-day constant reddens the TTL case. `now >= expireAt` counts as
expired, matching MongoDB's TTL monitor semantics; the clock case pins
`expireAt - 1 ms → 200` and `expireAt → 401`.

### 6. The persistence pin is a **database-wide scanner**, not a named collection

`COLLECTIONS` does not carry `attendeeSessions` yet, and the collection's name is
the GREEN's to choose (`attendeeSessions` matches the recent camelCase entries,
`attendee_sessions` matches the snake_case block). The specs therefore never name
it: they list the database's collections and look for the document that carries
`tokenHash = sha256(raw)` (I1) or for any document whose JSON contains the raw
token (I5). That is both name-agnostic and the stronger statement — a leak into a
domain event, a dispatch body or an idempotency snapshot is exactly the case where
the collection is not the one the writer meant to touch, and I5's repeated-create
case (same `Idempotency-Key`, so "if any snapshot exists, it must not hold the
token") is driven through the same scanner.

### 7. `attendee_session_expired` is a new catalogue code

The code exists in contract Appendix A but not in the server catalogue, so the
GREEN must append it (the repository's append-only pattern: its own closed set or
the auth set, plus a transport row at `401`, non-retryable). The RED asserts only
the **wire** code, so it does not force a set name.

## Evidence

All commands run inside `/root/openpic/openpic-webapp/.worktrees/t_8b1c0dfe`
(`pnpm install --frozen-lockfile --offline` first; the worktree ships no
`node_modules`).

1. **Type-correct RED.** `npx tsc -p apps/web/tsconfig.json --noEmit` exits `0`
   with throwaway faithful stubs at the four intended paths, so every later
   failure is assertion-level rather than a type error ambushing the GREEN.
2. **The contract is satisfiable.** With those stubs:
   - unit — `15 passed (15)` across the two specs;
   - integration — `12 passed (12)` against a real `MongoMemoryReplSet`, including
     the fake-`Date` expiry case and the database-wide scanner.
     The stubs were then **deleted**; `git status` shows the four spec files and
     this ADR only.
3. **The pins bite** — three mutations of the stubs, each reverted:

   | Mutation                                                    | Result                                                                                                 |
   | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
   | store `sessionToken: token` alongside `tokenHash`           | `I1: stores only …` → `AssertionError: expected [ '_id', 'claimedAt', …(8) ] to deeply equal [ …(7) ]` |
   | drop the expiry throw from the resolver                     | both `I4` expiry cases → `AssertionError: expected 200 to be 401`                                      |
   | write `{ mutationSnapshot: token }` into another collection | both `I5` cases → `AssertionError: expected [ { …(2) } ] to deeply equal []`                           |

4. **The honest RED after deletion** is the missing-module failure the GREEN
   starts from: `Failed to resolve import "@/server/attendee/session-token"`,
   `"@/app/api/v1/p/attendee-sessions/route"` and
   `"@/app/api/v1/p/attendee-sessions/current/route"`.
5. **The e2e cannot run at RED by design** (OP-93/ADR-0306): `next build`
   typechecks the whole project, so a branch importing modules that do not exist
   has no standalone server to start. It is written and typechecked; the GREEN's
   PR is where it executes. A probe build with the stubs present also proved the
   build gate checks route exports (`"authSurface" is not a valid Route export
field`), so the e2e doubles as a compile-time contract for the routes.

## Consequences

- The GREEN must implement the module paths and signatures in §1, both routes,
  the `attendeeSessions` index (`{tokenHash:1}` unique, `{expireAt:1}` TTL 0,
  `{claimedByUserId:1}` sparse — schema §13.5), and the new error code. Its
  branch must be based on this pins branch, not bare `origin/main`, or it will not
  see the specs.
- `noAttendeeSessions` should stop being the production default: a route that
  forgets to pass the resolver silently resolves no attendee. The GREEN wires
  `createAttendeeSessionResolver` into the `current` route's auth stage.
- The specs seed `retention.attendeeSessionDays = 7` and invalidate the settings
  cache in `beforeAll`/`afterAll`. Any future suite that seeds settings in the
  same worker must do the same, or it may observe this TTL for up to the cache's
  30-second lifetime.
- Rate limiting (contract §1.5's "60 / hour / IP") is **not** pinned: §0.11 has no
  class for this endpoint and the rate-limit stage is configuration, not behaviour
  this story owns. It is listed under Open questions rather than half-pinned.

## Alternatives considered

- **Pin the collection name** (`COLLECTIONS.attendeeSessions`). Rejected: it
  forces a naming decision that belongs to the GREEN, and the scanner states the
  security property more directly.
- **Always emit `Secure`** (the literal reading of §1.5's example). Rejected: it
  breaks the browser and e2e cookie round trip on a plain-HTTP origin, and the
  repository's own auth cookie already treats TLS attributes as
  environment-scoped.
- **Test the resolver in isolation** with a fake database instead of driving the
  routes. Rejected for I2–I4: the contract is about the wire (`401` codes,
  `details`), the guard's label admission and the row the create route wrote, so
  the handler is the honest seam. The resolver's port shape is still pinned
  indirectly — the GREEN cannot satisfy I2/I3 without implementing it.
- **Assert `eventSlugs` round-trips an `eventSlug`** on create. Deferred: it needs
  an event fixture and the contract does not say what an unknown slug does, so a
  pin would invent the failure mode. The empty case is pinned; the rest is an open
  question for the GREEN's ADR.

## Assumptions

1. `/api/v1/p/attendee-sessions[/current]` is the path (contract §1.5), and both
   handlers are driven directly in integration specs.
2. 32 bytes → 43 base64url characters is the token shape (repository convention,
   `randomToken`).
3. `hashAttendeeSessionToken` is unsalted SHA-256 of the whole token.
4. `deviceFingerprint` is `{uaHash, ipHash, acceptLangHash}`, each a 64-hex digest
   of a salted component; the salt and the exact pre-image are not pinned.
5. `secure` is an injected boolean, true only on `staging`/`production`.
6. `expireAt`/`Max-Age` follow `retention.attendeeSessionDays`; expiry is
   inclusive.
7. `details.recreateUrl` is a site-relative path (leading `/`); the exact page is
   the GREEN's.
8. `POST` is not idempotency-required, so a repeated create with the same
   `Idempotency-Key` may mint a new session or replay — only "no raw token is
   persisted" is pinned.

## Open questions for the GREEN

- What an **unknown `eventSlug`** answers (`404`, or silently ignored) and how the
  slug is resolved (`events.accessLinks[].slug` is the only slug in the schema).
- Whether the `POST` route declares an idempotency stage at all; if it does, the
  stored snapshot must not carry the raw token (I5 constrains it either way).
- Which rate-limit class the create endpoint uses (§0.11 has no matching row; the
  contract says 60 / hour / IP).
- Whether `lastSeenAt` is refreshed on a successful `current` read (not pinned, to
  avoid a write-per-read assumption).
- Whether `current` answers anything useful for a **user** session (the `attendee`
  label admits one, but the contract only describes the attendee body).
