# ADR-0005 — Two-tier rate limiting: coarse edge stage + identity-keyed pipeline stage

- **Status:** Accepted · **Date:** 2026-10-04

## Context

Contract §0.11 originally said rate limiting is "Enforced in `middleware.ts`",
but the implementation enforces it as a `defineRoute` pipeline stage. The stage
order is pinned by `define-route.test.ts` U7: `rateLimit` runs **before** `auth`
and before the request body is parsed. That ordering is deliberate — a coarse
limit must be cheap enough to reject an unauthenticated flood before any auth or
body work — but it means the pre-auth stage cannot see the authenticated
`ctx.principal`, and it cannot see the request body's `contact`.

Several §0.11 classes are keyed on exactly those identities: `read.normal`,
`write.normal`, `upload.*`, `media.sign`, `admin`, `internal` are
**principal**-keyed; `auth.otp`/`auth.verify` are **contact**-keyed
(`auth.verify` is contact-only and fail-closed). A single pre-auth stage would
make those identities unavailable exactly when the classes need them, and — once
"no usable identity ⇒ `unavailable` (fail closed)" landed — would turn
contact-only fail-closed classes into a permanent `503`.

The human ruled on the `middleware.ts`-vs-stage question: **Option A, two-tier
limiting** — keep a coarse, IP-keyed limit ahead of auth (so U7 stays valid and
unauth floods are still cheap to reject) and add a second, principal/contact
keyed stage after auth.

## Decision

Rate limiting runs in **two tiers** inside the same `defineRoute` pipeline
(the pre-auth tier is not relocated to `middleware.ts`):

1. **Coarse, pre-auth stage** — `rateLimit`, still first. It keys on what the
   request can attribute before auth: the salted-hashed client IP, and any
   server-resolved facts it is explicitly handed (e.g. an attendee
   `facts.attendeeSessionId` from an edge/session resolver). It never trusts the
   raw `X-Attendee-Session` request header.
2. **Identity-keyed, post-auth stage** — `rateLimitIdentity`, run immediately
   after `auth`. The pipeline parses the request body **once**, before this
   stage, and passes it as the stage's third argument `(ctx, request, body)`.
   The stage keys on `ctx.principal` (published by the route `auth` stage) and,
   for `auth.otp`/`auth.verify`, on the body's `contact`.

Pinned stage order (`define-route.test.ts` U7):

```
rateLimit → auth → rateLimitIdentity → csrf → tenant → idempotency → etag → handler
```

### Which tier owns the attendee scope

There is no single owner: the attendee scope is enforced by **whichever tier is
handed a server-validated `facts.attendeeSessionId`**.

- The coarse stage accepts resolved attendee facts, so an edge/session resolver
  that validated the `X-Attendee-Session` header can enforce an attendee rule
  pre-auth.
- The identity stage accepts the same facts post-auth.

An attendee-only class (`liveness.challenge`) or the attendee rule of a mixed
class (`selfie.submit`, `public.gallery`) is therefore **fail-closed only when
no resolved attendee fact reaches the stage**: an unvalidated/forged header is
not an identity, so the request cannot be bucketed and, being abuse-prone, is
rejected (`503`) rather than silently allowed. A mixed class is not wholly
unattributable — its IP rule is still enforced. When a resolver _has_ validated
the session, the stage keys on the resulting non-raw identity and the request is
admitted/limited normally. This is why the coarse stage needs no special
"IP-only" mode: it evaluates exactly the scopes it can derive.

## Consequences

- A rotated/forged `X-Attendee-Session` cannot mint a fresh bucket or evade an
  attendee-only limit; the raw token never reaches a limiter key or a log line.
- Contact-keyed fail-closed classes are enforceable post-auth, so they are no
  longer a permanent `503`; a request that genuinely carries no contact still
  fails closed.
- A route must wire the coarse and/or identity stage **and** supply the
  resolved attendee facts at whichever tier owns an attendee-scoped class. This
  remains a call-site responsibility; no attendee route exists yet.
- §0.11's wording is corrected to describe the two tiers (the change lives in
  the external archive doc, outside this repository).
- Both tiers share the same `RateLimiter` port and the same `RateLimit-*`
  response headers, so the wire contract is unchanged.

## Alternatives considered

- **Relocate all enforcement to `middleware.ts` (literal §0.11)** — rejected: a
  middleware edge can enforce only the coarse IP tier cheaply; the
  principal/contact identities are not available there without duplicating auth,
  and it would invert the pinned pipeline order (U7).
- **Single pre-auth stage that derives every identity** — rejected: `principal`
  and `contact` do not exist before `auth`/body-parse, and making a
  contact-only fail-closed class "no identity ⇒ unavailable" would `503` every
  request.
- **Move `auth`/body-parse ahead of the rate stage** — rejected: it would defeat
  the point of a cheap pre-auth flood gate and break U7.
