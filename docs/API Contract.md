# OpenPic — API Contract

**Version:** 1.0.0 (normative)
**Date:** 2026-09-25
**Status:** Base contract for backend ↔ frontend integration. Machine-actionable.

**Downstream consumers:** Next.js App Router route handlers, React frontend (web), future React Native client, Python worker, Cloudflare Worker (`pic.openpic.in`), Cashfree webhook receiver, Novu transport adapter.

---

## Table of contents

**Part 0 — Ground rules**
[0.1 Scope & layers](#01-scope--layers) · [0.2 Base URLs & versioning](#02-base-urls--versioning) · [0.3 Authentication](#03-authentication) · [0.4 Tenancy in URLs](#04-tenancy-in-urls) · [0.5 Response envelopes](#05-response-envelopes) · [0.6 Errors](#06-errors) · [0.7 Status codes](#07-status-codes) · [0.8 Pagination](#08-pagination) · [0.9 Idempotency](#09-idempotency) · [0.10 Concurrency & ETags](#010-concurrency--etags) · [0.11 Rate limiting](#011-rate-limiting) · [0.12 Headers](#012-headers) · [0.13 Data type conventions](#013-data-type-conventions) · [0.14 Entitlement enforcement contract](#014-entitlement-enforcement-contract) · [0.15 Never-return rules](#015-never-return-rules)

**Part 1 — Identity**
[1.1 Better Auth surface](#11-better-auth-surface) · [1.2 Current user](#12-current-user) · [1.3 Sessions & devices](#13-sessions--devices) · [1.4 Account deletion](#14-account-deletion) · [1.5 Anonymous attendee sessions](#15-anonymous-attendee-sessions)

**Part 2 — Tenancy & collaboration**
[2.1 Tenants](#21-tenants) · [2.2 Tenant members](#22-tenant-members) · [2.3 Invitations](#23-invitations)

**Part 3 — Plans, billing, entitlements**
[3.1 Plans (public)](#31-plans-public) · [3.2 Subscription](#32-subscription) · [3.3 Checkout, upgrade, downgrade, cancel](#33-checkout-upgrade-downgrade-cancel) · [3.4 Transactions & invoices](#34-transactions--invoices) · [3.5 Entitlements & usage](#35-entitlements--usage) · [3.6 Add-ons](#36-add-ons)

**Part 4 — Events**
[4.1 Event CRUD](#41-event-crud) · [4.2 Access links & QR](#42-access-links--qr) · [4.3 Event members](#43-event-members) · [4.4 Event images](#44-event-images) · [4.5 Event stats & analytics](#45-event-stats--analytics)

**Part 5 — Uploads & media**
[5.1 Upload contract overview](#51-upload-contract-overview) · [5.2 Batch resolve](#52-batch-resolve) · [5.3 Single PUT path](#53-single-put-path) · [5.4 Multipart path](#54-multipart-path) · [5.5 Batch status](#55-batch-status) · [5.6 Media signed URLs](#56-media-signed-urls) · [5.7 Media data plane (`pic.openpic.in`)](#57-media-data-plane-picopenpicin)

**Part 6 — Attendee (public) surface**
[6.1 Public event resolution](#61-public-event-resolution) · [6.2 Consent](#62-consent) · [6.3 Liveness & selfie](#63-liveness--selfie) · [6.4 Participation status (polling)](#64-participation-status-polling) · [6.5 Gallery](#65-gallery) · [6.6 Originals & downloads](#66-originals--downloads) · [6.7 Claiming & "my events"](#67-claiming--my-events)

**Part 7 — Notifications**
[7.1 In-app feed](#71-in-app-feed) · [7.2 Unread count (hot path)](#72-unread-count-hot-path) · [7.3 Notification actions](#73-notification-actions) · [7.4 Preferences](#74-preferences) · [7.5 Unsubscribe & suppression](#75-unsubscribe--suppression) · [7.6 Type catalogue (normative)](#76-type-catalogue-normative) · [7.7 Domain event contract](#77-domain-event-contract)

**Part 8 — Compliance**
[8.1 Data subject requests](#81-data-subject-requests) · [8.2 Consent history & policy acknowledgement](#82-consent-history--policy-acknowledgement)

**Part 9 — Admin**
[9.1 Admin conventions](#91-admin-conventions) · [9.2 Tenants & users](#92-tenants--users) · [9.3 Plans](#93-plans) · [9.4 Notification catalogue & templates](#94-notification-catalogue--templates) · [9.5 Deliverability forensics](#95-deliverability-forensics) · [9.6 Queue & pipeline health](#96-queue--pipeline-health) · [9.7 Billing operations](#97-billing-operations) · [9.8 DSR queue](#98-dsr-queue) · [9.9 Audit logs](#99-audit-logs) · [9.10 Platform settings](#910-platform-settings)

**Part 10 — Machine-to-machine**
[10.1 Provider webhooks](#101-provider-webhooks) · [10.2 Cron endpoints](#102-cron-endpoints) · [10.3 Worker contract](#103-worker-contract) · [10.4 Queue message envelope](#104-queue-message-envelope)

**Part 11 — Appendices**
[A. Error code catalogue](#appendix-a--error-code-catalogue) · [B. TypeScript DTOs](#appendix-b--typescript-dtos) · [C. Route → collection/index map](#appendix-c--route--collectionindex-map) · [D. Authorization matrix](#appendix-d--authorization-matrix) · [E. Polling & cache policy](#appendix-e--polling--cache-policy) · [F. Implementation checklist](#appendix-f--implementation-checklist) · [G. Open questions](#appendix-g--open-questions)

---

# Part 0 — Ground rules

## 0.1 Scope & layers

There are **three planes**. Do not mix them.

| Plane                  | Host                                             | Carries                                                            | Auth                                            |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| **Control plane**      | `https://openpic.in/api/...` (Next.js on Vercel) | JSON only. Auth, authorization, metadata, signing, state machines. | Better Auth session / bearer / attendee session |
| **Media data plane**   | `https://pic.openpic.in/...` (Cloudflare Worker) | Image bytes only. Never JSON.                                      | Path-bound HMAC (`?exp=&sig=`)                  |
| **Storage data plane** | R2 presigned `PUT` URLs                          | Upload bytes only.                                                 | Presigned S3 signature                          |

**Hard rule:** image bytes never transit the Next.js control plane, in either direction. Any endpoint in this document that returns an image returns a **URL**, never bytes. Any endpoint that accepts an image returns a **presigned URL**, never accepts a multipart body — with one exception, `POST /api/v1/tenants/{tenantId}/assets/branding` (logos/watermarks, ≤2 MB), which is explicitly allowed to accept bytes because volume is negligible.

## 0.2 Base URLs & versioning

```
Production   https://openpic.in/api/v1
Staging      https://staging.openpic.in/api/v1
Better Auth  https://openpic.in/api/auth        (unversioned — library-owned)
Media        https://pic.openpic.in
```

- The version is in the path. `v1` is frozen once shipped; breaking changes require `v2`.
- **Non-breaking** (allowed in `v1`): new endpoints, new optional request fields, new response fields, new enum values in _response_ positions, new `typeKey` values, new error codes.
- **Breaking** (requires `v2`): removing/renaming a field, changing a type, changing a status code, making an optional request field required, removing an enum value.
- Clients **must** ignore unknown response fields and **must** tolerate unknown enum values by falling back to a safe default (`severity → "informational"`, `status → "unknown"`).
- Deprecations are announced with `Deprecation: true` and `Sunset: <HTTP-date>` response headers for ≥90 days.

## 0.3 Authentication

Five credential types. Every endpoint below declares exactly one **Auth** requirement.

| Auth label      | Credential                                                                               | Transport                                                                                                                           | Notes                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `public`        | none                                                                                     | —                                                                                                                                   | Rate-limited by IP.                                                                                                                       |
| `user`          | Better Auth session                                                                      | `Cookie: better-auth.session_token` (web, `HttpOnly; Secure; SameSite=Lax`) **or** `Authorization: Bearer <session_token>` (mobile) | Must have `userProfiles.status == "active"`.                                                                                              |
| `user:complete` | as above **and** `accountCompletedAt != null`                                            | —                                                                                                                                   | Email **and** phone verified. Returns `403 account_incomplete` otherwise.                                                                 |
| `attendee`      | anonymous attendee session **or** `user`                                                 | `Cookie: op_att` (`HttpOnly; Secure; SameSite=Lax`) **or** `X-Attendee-Session: <raw token>` (mobile)                               | Raw token is SHA-256'd and matched against attendeeSessions.tokenHash. A user session satisfies this label too.                           |
| `admin`         | `user` **and** `userProfiles.platformRole == "admin"` **and** `twoFactorEnabled == true` | —                                                                                                                                   | 2FA is mandatory for admins. Returns `403 admin_2fa_required`.                                                                            |
| `internal`      | shared secret + HMAC                                                                     | `Authorization: Bearer <INTERNAL_API_SECRET>` + `X-Signature: sha256=<hex>` over the raw body + `X-Timestamp` (±300 s)              | Cron and Python worker only. Never reachable from the browser; enforced at the edge by `middleware.ts` (deny if `Origin` header present). |
| `provider`      | provider signature                                                                       | provider-specific header                                                                                                            | Webhooks. See §10.1.                                                                                                                      |

**CSRF.** All cookie-authenticated state-changing requests (`POST`/`PATCH`/`PUT`/`DELETE`) must carry `X-Requested-With: XMLHttpRequest` **and** originate from an allow-listed `Origin`. Bearer-authenticated requests are exempt. Violations → `403 csrf_failed`.

**Banned users** → `423 account_banned` with `{ banReason, banExpires }` on every authenticated endpoint except `GET /me` and `POST /me/data-requests`.

## 0.4 Tenancy in URLs

`tenantId` is **explicit in the path for every organizer-side resource**, including nested items. This is deliberate: it makes the `tenantId` filter structurally unavoidable in every handler, which is the mitigation named in schema §10.2.

```
/api/v1/tenants/{tenantId}/events/{eventId}/images/{imageId}
```

- `{tenantId}` accepts the literal alias **`current`**, resolved to `userProfiles.primaryTenantId`. Servers must resolve the alias before any DB call and echo the resolved id in `X-Tenant-Id`.
- Every handler under `/tenants/{tenantId}/` must (a) verify `tenantMembers` or `eventMembers` grants access, and (b) include `tenantId` in every Mongo filter. A nested resource whose stored `tenantId` ≠ path `tenantId` → **`404 not_found`** (never `403` — do not confirm existence across tenants).
- Non-tenant-scoped namespaces: `/me/*` (user scope), `/p/*` (public/attendee), `/plans`, `/admin/*`, `/internal/*`, `/webhooks/*`, `/invitations/*`.
- The **only** permitted cross-tenant read is `GET /api/v1/me/events` (§6.7), and it may only ever return rows whose `subject.userId` equals the caller.

## 0.5 Response envelopes

**Single resource** — returned bare.

```json
{ "id": "6702f1a...", "name": "Rahul & Priya's Wedding", "status": "live" }
```

**Collection** — always wrapped.

```json
{
  "data": [{ "id": "..." }],
  "page": { "nextCursor": "eyJjIjoiMjAyNi0wOS0yNFQx...", "hasMore": true, "limit": 40 }
}
```

**Async accepted** — `202` with a poll target.

```json
{
  "status": "accepted",
  "jobRef": { "kind": "download", "id": "6703a..." },
  "pollUrl": "/api/v1/p/downloads/6703a..."
}
```

**Empty success** — `204 No Content`, no body.

Rules:

- `id` is always a string. Never expose `_id` or `ObjectId` wrappers.
- Timestamps are RFC 3339 UTC with `Z`: `"2026-09-24T18:30:00.000Z"`.
- `null` means "known to be absent". Absent key means "not applicable / not requested". Clients must treat both as absent.
- No field is ever renamed in a response; new fields are additive only.

## 0.6 Errors

Single error shape, everywhere, including `/internal` and webhooks.

```json
{
  "error": {
    "code": "plan_limit_exceeded",
    "message": "You have used all 7 events available on the Starter plan this month.",
    "details": {
      "entitlementKey": "events.active",
      "limit": 7,
      "used": 7,
      "periodKey": "2026-09",
      "reason": "plan_limit",
      "upgradePath": "/api/v1/tenants/current/billing/upgrade"
    },
    "requestId": "req_01JBQ7X3M2",
    "retryable": false
  }
}
```

| Field       | Type                 | Rules                                                                                                                                                                                           |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`      | string, `snake_case` | **Stable. The only field clients may branch on.** Full catalogue in Appendix A.                                                                                                                 |
| `message`   | string               | Human-readable, end-user-safe, English. Never contains stack traces, SQL/Mongo fragments, provider error text, contact details or tokens. Localised copy lives in the frontend keyed by `code`. |
| `details`   | object \| absent     | Machine-readable context. Shape is documented per code.                                                                                                                                         |
| `requestId` | string               | Echoes `X-Request-Id`. Must be surfaced in the UI on `5xx`.                                                                                                                                     |
| `retryable` | boolean              | `true` ⇒ the identical request with the same `Idempotency-Key` may be retried.                                                                                                                  |

**Validation errors** (`422`) carry a field list:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Request body is invalid.",
    "details": {
      "fields": [
        { "path": "startAt", "code": "invalid_datetime", "message": "Must be RFC 3339." },
        {
          "path": "displayTimeZone",
          "code": "unknown_timezone",
          "message": "Must be an IANA zone."
        }
      ]
    },
    "requestId": "req_01JBQ7X3M2",
    "retryable": false
  }
}
```

## 0.7 Status codes

| Code          | Used for                                                                                                                           | Notes                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `200`         | Successful read; successful mutation returning a body; **idempotent replay**; **already-terminal state transition**                | §7.3, §2.3 — never `409` for a second accept/reject click.         |
| `201`         | Resource created                                                                                                                   | `Location` header required.                                        |
| `202`         | Accepted for async processing                                                                                                      | Body carries `pollUrl`.                                            |
| `204`         | Successful mutation, no body                                                                                                       | Deletes, mark-read, seen.                                          |
| `304`         | `If-None-Match` matched                                                                                                            | Only on `GET /me/notifications/unread-count` and `GET /plans`.     |
| `400`         | Malformed syntax, bad cursor, unparseable JSON                                                                                     |                                                                    |
| `401`         | Missing/invalid/expired credential                                                                                                 | `WWW-Authenticate` + `details.loginUrl`.                           |
| `402`         | Blocked by **outstanding payment** (`reason: "payment_downgrade"`)                                                                 | Distinct from `403`. Body carries `pendingDueMinor` + `payNowUrl`. |
| `403`         | Authenticated but not permitted; **plan limit exceeded**; CSRF; admin 2FA missing                                                  |                                                                    |
| `404`         | Not found, **or** exists in another tenant, **or** hidden by authorization                                                         |                                                                    |
| `409`         | State conflict that is _not_ idempotent-safe: upload window closed, event not published, duplicate live invite, concurrent mandate |                                                                    |
| `410`         | Resource permanently gone: purged gallery, revoked access link, expired export                                                     |                                                                    |
| `412`         | Precondition failed: `If-Match` mismatch, **consent missing**                                                                      |                                                                    |
| `413`         | Payload/file too large                                                                                                             | `details.maxBytes`.                                                |
| `415`         | Unsupported media type                                                                                                             | `details.supportedMimeTypes`.                                      |
| `422`         | Semantically invalid body                                                                                                          | Field list.                                                        |
| `423`         | Account banned/suspended                                                                                                           |                                                                    |
| `429`         | Rate limited                                                                                                                       | `Retry-After` + `RateLimit-*`.                                     |
| `500`         | Unhandled                                                                                                                          | Never leak internals.                                              |
| `502` / `503` | Upstream provider or DB unavailable                                                                                                | `Retry-After`; `retryable: true`.                                  |

## 0.8 Pagination

**Cursor-based only. No offset/page params anywhere.**

Request: `?cursor=<opaque>&limit=<1..100>` (default `40`; `20` for the notification feed).

The cursor is `base64url(JSON.stringify({ c: <sortFieldValue>, i: <id> }))` — a compound key that never ties, matching the `{userId:1, createdAt:-1}` / `{eventId:1, sequence:-1}` index shapes. It is **opaque**: clients must not construct or parse it. An unparseable or foreign cursor → `400 invalid_cursor`.

```json
"page": { "nextCursor": "eyJjIjoi...", "hasMore": true, "limit": 40 }
```

- `nextCursor` is `null` when `hasMore` is `false`.
- Collections are **never** returned with a total count unless a cached counter exists (`tenants.counters`, `events.counters`, `attendeeEventProfiles.matchCount`). Totals that would require an aggregation are omitted. Where a total is available it appears as `page.total` and is documented as **approximate (cached counter, reconciled nightly)**.

Sort order is fixed per endpoint and documented; it is never client-controlled except where an explicit `sort` enum is listed.

## 0.9 Idempotency

`Idempotency-Key: <client-generated UUIDv4>` is **REQUIRED** on:

```
POST /tenants/{t}/billing/checkout
POST /tenants/{t}/billing/upgrade
POST /tenants/{t}/billing/retry-charge
POST /tenants/{t}/billing/addons
POST /tenants/{t}/events
POST /tenants/{t}/events/{e}/uploads/multipart/{uploadId}/complete
POST /tenants/{t}/events/{e}/uploads/params
POST /tenants/{t}/events/{e}/invitations
POST /p/events/{slug}/selfies
POST /p/events/{slug}/downloads
POST /me/data-requests
POST /admin/invitations
```

It is **OPTIONAL but honoured** on every other `POST`.

Semantics, backed by `idempotencyKeys` (`{key, scope}` unique, TTL 24 h, `scope = "<METHOD> <route-template>"`):

1. First request → insert `{status: "in_progress"}`, execute, store `responseSnapshot`, set `completed`.
2. Replay with the **same** key and an identical `requestHash` → return the stored response verbatim with `200` (never `201`) and `Idempotency-Replayed: true`.
3. Replay while the original is still `in_progress` → `409 idempotency_in_progress`, `Retry-After: 2`, `retryable: true`.
4. Same key, **different** `requestHash` → `422 idempotency_key_reuse`.
5. Missing key on a required endpoint → `400 idempotency_key_required`.

`requestHash = sha256(canonicalJson(body) + "\n" + resolvedTenantId + "\n" + userId)`.

## 0.10 Concurrency & ETags

Mutable resources with meaningful concurrent-edit risk return a **strong `ETag`** and accept `If-Match`:

| Resource                        | ETag source                               |
| ------------------------------- | ----------------------------------------- |
| `events`                        | `"<updatedAt.getTime()>-<schemaVersion>"` |
| `plans` (admin)                 | `version`                                 |
| `notificationTypes` (admin)     | `version`                                 |
| `notificationTemplates` (admin) | `version`                                 |
| `platformSettings`              | `updatedAt`                               |

`PATCH` without `If-Match` on these → `428 precondition_required`. `If-Match` mismatch → `412 etag_mismatch` with `details.currentETag`.

All other `PATCH` endpoints are last-write-wins and do not require `If-Match`.

## 0.11 Rate limiting

Enforced in `middleware.ts` via Upstash Ratelimit (sliding window). Keyed as documented; the stricter of the listed limits applies.

| Class                | Endpoints                                                       | Limit                                                                                                                          |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `auth.otp`           | Better Auth OTP send                                            | **5 / hour / contact**, 15 / hour / IP — aligns with the `auth.otp.*` throttle in notification §4.1                            |
| `auth.verify`        | OTP verify                                                      | 10 / 10 min / contact, then exponential lockout → `auth.suspicious.blocked`                                                    |
| `read.hot`           | `GET /me/notifications/unread-count`, `GET /p/events/{slug}/me` | 60 / min / principal                                                                                                           |
| `read.normal`        | all other `GET`                                                 | 300 / min / principal                                                                                                          |
| `write.normal`       | all other `POST`/`PATCH`/`DELETE`                               | 60 / min / principal                                                                                                           |
| `upload.resolve`     | `POST /uploads/batch-resolve`                                   | 60 / min / user, max 500 hashes per call                                                                                       |
| `upload.sign`        | `GET .../multipart/{id}/{partNumber}`                           | **900 / min / user** — deliberately high; Uppy signs every part and re-signs on retry                                          |
| `upload.complete`    | multipart complete, single params                               | 600 / min / user                                                                                                               |
| `selfie.submit`      | `POST /p/events/{slug}/selfies`                                 | 6 / hour / attendee-session, 20 / hour / IP. Independent of the `selfies.per_attendee` entitlement (3), which is the hard cap. |
| `liveness.challenge` | `POST /p/events/{slug}/liveness/challenges`                     | 12 / hour / attendee-session                                                                                                   |
| `public.gallery`     | `/p/**` reads                                                   | 120 / min / attendee-session, 600 / min / IP                                                                                   |
| `media.sign`         | `POST /media/signed-urls`                                       | 120 / min / principal, max 200 items per call                                                                                  |
| `admin`              | `/admin/**`                                                     | 300 / min / admin                                                                                                              |
| `webhook`            | `/webhooks/**`                                                  | **not rate limited**; protected by signature verification + `providerWebhookEvents` unique index                               |
| `internal`           | `/internal/**`                                                  | 600 / min / secret                                                                                                             |

Response on limit:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 37
RateLimit-Limit: 60
RateLimit-Remaining: 0
RateLimit-Reset: 37
```

> **Note.** Bytes uploaded via presigned R2 `PUT` are not proxied and therefore **cannot** be rate limited by us. Mitigations are: short presign expiry (§5), per-part signing limits above, `declaredSize` validation against `upload.maxFileBytes`, and server-side verification of actual `bytes` at completion (`409 size_mismatch` if it disagrees by more than 1 %).

## 0.12 Headers

**Request**

| Header                                          | Required                    | Purpose                                                |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `Content-Type: application/json; charset=utf-8` | on bodies                   | `415` otherwise                                        |
| `Accept: application/json`                      | recommended                 |                                                        |
| `Idempotency-Key`                               | per §0.9                    |                                                        |
| `If-Match` / `If-None-Match`                    | per §0.10                   |                                                        |
| `X-Request-Id`                                  | optional                    | Client-supplied trace id; echoed. Generated if absent. |
| `X-Requested-With: XMLHttpRequest`              | cookie auth, state-changing | CSRF                                                   |
| `X-Attendee-Session`                            | mobile attendee             |                                                        |
| `X-Tenant-Id`                                   | never sent by clients       | Response-only                                          |
| `Accept-Language`                               | optional                    | Advisory; `userProfiles.locale` wins for stored copy   |

**Response (all endpoints)**

```http
X-Request-Id: req_01JBQ7X3M2
X-Tenant-Id: 6702f1a...            # when tenant-scoped
Cache-Control: no-store            # default for every JSON endpoint
Content-Security-Policy: default-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

`Cache-Control: no-store` is the default. Exceptions are listed in Appendix E.

## 0.13 Data type conventions

| Concept        | Wire format                         | Example                                                    |
| -------------- | ----------------------------------- | ---------------------------------------------------------- |
| Identifier     | string (24-hex ObjectId)            | `"6702f1a3c8e4b2001f9a7d21"`                               |
| Stable key     | `snake_case` / dotted string        | `"starter"`, `"events.active"`, `"attendee.matches.ready"` |
| Timestamp      | RFC 3339 UTC, ms precision, `Z`     | `"2026-09-24T18:30:00.000Z"`                               |
| Date bucket    | `YYYY-MM-DD`                        | `"2026-09-24"`                                             |
| Period key     | `YYYY-MM` \| `YYYY` \| `"lifetime"` | `"2026-09"`                                                |
| Time zone      | IANA name                           | `"Asia/Kolkata"`                                           |
| Money          | **integer minor units** + ISO-4217  | `{ "amountMinor": 49900, "currency": "INR" }`              |
| Bytes          | integer                             | `107374182400`                                             |
| Content hash   | lowercase hex SHA-256, 64 chars     | `"e3b0c442..."`                                            |
| Phone          | E.164                               | `"+919876543210"`                                          |
| Masked contact | prefix + `•`                        | `"r•••@gmail.com"`, `"+91•••••3210"`                       |
| Enum           | lowercase snake string              | `"past_due"`                                               |
| Boolean state  | prefer nullable timestamp           | `readAt: null` not `isRead: false`                         |

**Money is never a float, anywhere, in any direction.** A request body containing a non-integer `amountMinor` → `422`.

## 0.14 Entitlement enforcement contract

Every mutating endpoint that consumes a metered resource declares an **Entitlements** line listing the `entitlementKey`s checked. Handlers must call `checkEntitlement()` (schema §14.2) **inside the same transaction** as the domain write and the `usageCounters.$inc` (schema §23).

Failure responses are fully determined by `checkEntitlement().reason`:

| `reason`            | Status | `code`                |
| ------------------- | ------ | --------------------- |
| `plan_limit`        | `403`  | `plan_limit_exceeded` |
| `payment_downgrade` | `402`  | `payment_required`    |

Both bodies carry `details = { entitlementKey, limit, used, periodKey, scope, reason }`, plus `pendingDueMinor` and `payNowUrl` for `402`.

**Both responses MUST also cause the server to emit the `usage.action.blocked` domain event** (notification §4.4, in-app only, throttled 1/key/h). The client renders the upgrade CTA from the error body; the in-app notification is the durable record.

**Invariant C6 (never delete for non-payment) as an API rule:** no endpoint in this contract deletes, hides, or degrades stored content as a consequence of billing state. A `402` blocks **creation** only. Read, list, gallery, download and export endpoints are **unaffected** by `subscriptions.status`. Any deviation is a P0 bug.

**Advisory pre-checks.** `GET /tenants/{t}/entitlements` (§3.5) exists so the UI can grey out buttons and show quota bars. It is **advisory**. The server re-checks at write time and is authoritative; clients must handle `402`/`403` on every write regardless of what the pre-check said.

## 0.15 Never-return rules

These are contract violations, not style preferences. Enforce with response-schema tests.

| Never returned by any endpoint, to any caller, including admins                                                     | Why                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Face embeddings / vectors (`imageFaces.vectors.*`, `selfies.embedding`) in any form, raw or base64                  | Schema P8 / §27. Biometric data.                                                      |
| Raw bearer tokens after their single issuance response (`attendeeSessions` token, `invitations` token, push tokens) | Schema §27 — hashed at rest                                                           |
| R2 bucket names, object keys, `locationKey`, presigned-URL signing secrets, `MEDIA_SIGNING_SECRET`                  | Schema §11.2 — logical keys only                                                      |
| Provider API keys, webhook secrets, `externalRefs[].meta`                                                           | Only that vendor's adapter reads `meta`                                               |
| Full email/phone of **another** user                                                                                | Masked per §0.13. `eventMembers` listings return `displayName` + masked contact only. |
| OTP codes, in any channel, in any log, in any dispatch record (`retainBody: false`)                                 | Notification rule 6                                                                   |
| `rawPayload` of provider webhooks outside `/admin`                                                                  |                                                                                       |
| Another tenant's data, under any circumstances                                                                      | §0.4                                                                                  |

---

# Part 1 — Identity

## 1.1 Better Auth surface

`/api/auth/**` is **owned by Better Auth** and is NOT specified here. Do not hand-roll, wrap, or proxy it. The frontend uses `better-auth/react` client methods.

Required plugin configuration (this _is_ part of the contract, because the rest of the API depends on it):

| Capability        | Plugin        | Exposes                                                                              |
| ----------------- | ------------- | ------------------------------------------------------------------------------------ |
| Email OTP sign-in | `emailOTP`    | `POST /api/auth/email-otp/send-verification-otp`, `POST /api/auth/sign-in/email-otp` |
| Phone OTP         | `phoneNumber` | `POST /api/auth/phone-number/send-otp`, `POST /api/auth/phone-number/verify`         |
| 2FA               | `twoFactor`   | enable/disable/verify                                                                |
| Admin             | `admin`       | ban/unban, impersonation (admin-only, audited)                                       |
| Sessions          | core          | list/revoke                                                                          |

**Mandatory Better Auth hooks** (the seam between auth and this API):

| Hook                                | Must do                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after` user created                | Insert `userProfiles` (`platformRole: "client"`, `status: "active"`, `locale` from `Accept-Language`, `timeZone` from client hint or `"Asia/Kolkata"`); insert `notificationPreferences` defaults; emit `account.welcome`; **run the lazy-invite hook** (notification §19.4): find `invitations` where `invitee.email == user.email` or `invitee.phoneE164 == user.phoneNumber` and `status == "pending"`, and create the corresponding in-app `notifications` rows. |
| `after` email **or** phone verified | If both now verified and `accountCompletedAt == null`, set it and emit `auth.account.completed`.                                                                                                                                                                                                                                                                                                                                                                     |
| `after` session created             | Compare device/IP fingerprint against prior sessions; if new, emit `auth.signin.new_device` (dedupe `1/device/24h`). If the user is an admin, emit `auth.admin.signin`.                                                                                                                                                                                                                                                                                              |
| `after` email/phone changed         | Emit `auth.contact.changed` **fanned out to both the old and the new contact** (notification §4.1).                                                                                                                                                                                                                                                                                                                                                                  |
| `after` 2FA toggled                 | Emit `auth.2fa.enabled` / `auth.2fa.disabled`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `after` sessions revoked            | Emit `account.sessions.revoked`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OTP send                            | The OTP body is delivered by our `NotificationService` via `auth.otp.email.requested` / `auth.otp.mobile.requested`. **`auth.otp.mobile.requested` is pinned to the `sms` channel, never the `mobile` group** (notification §4.1) — WhatsApp must never carry auth secrets.                                                                                                                                                                                          |

**Auth-adjacent app endpoint:**

### `POST /api/v1/me/whatsapp-capability:probe`

Auth `user:complete` · Rate `write.normal` · Phase 2

Probes whether the verified phone number is WhatsApp-reachable and writes `userProfiles.contactCapabilities.whatsappCapable` + `whatsappCheckedAt`. Flipping this value silently changes `mobile` group resolution from `sms` to `whatsapp` for this user — **no preference row and no notification type changes** (notification §1.1).

`200` → `{ "whatsappCapable": true, "checkedAt": "..." }`

---

## 1.2 Current user

### `GET /api/v1/me`

Auth `user` · Rate `read.normal` · `Cache-Control: no-store`

The single bootstrap call for an authenticated session. The frontend must not need a second request to render the shell.

```json
{
  "id": "6702f1a3c8e4b2001f9a7d21",
  "email": "rahul@example.com",
  "emailVerified": true,
  "phoneNumber": "+919876543210",
  "phoneNumberVerified": true,
  "twoFactorEnabled": false,
  "accountCompletedAt": "2026-09-01T10:04:00.000Z",
  "displayName": "Rahul Menon",
  "avatarUrl": "https://pic.openpic.in/t/9ab3....webp?exp=1790000000&sig=...",
  "locale": "en-IN",
  "timeZone": "Asia/Kolkata",
  "platformRole": "client",
  "status": "active",
  "marketingOptIn": false,
  "contactCapabilities": { "whatsappCapable": null, "whatsappCheckedAt": null },
  "primaryTenant": {
    "id": "6702f200c8e4b2001f9a7d30",
    "slug": "rahul-studio",
    "name": "Rahul Studio",
    "role": "owner",
    "status": "active"
  },
  "tenants": [
    {
      "id": "6702f200c8e4b2001f9a7d30",
      "slug": "rahul-studio",
      "name": "Rahul Studio",
      "role": "owner",
      "status": "active"
    }
  ],
  "capabilities": {
    "canCreateEvent": true,
    "canPurchase": true,
    "isAdmin": false
  },
  "unreadNotificationCount": 3,
  "pendingInvitationCount": 1,
  "deletionScheduledAt": null
}
```

Notes:

- `primaryTenant` is `null` for a **pure attendee** — this is normal, not an error (schema §13.2). The UI must render an attendee-only shell in that case and must not offer event creation.
- `tenants[]` is derived from `tenantMembers` where `status == "active"`.
- `capabilities` is a convenience projection; it is **advisory** (§0.14).
- `unreadNotificationCount` is included so the bell renders on first paint without a second round trip.
- `phoneNumber` is the caller's **own** contact and is returned **raw E.164** (§0.13 "Phone"), e.g. `"+919876543210"`; the masked form (§0.13 "Masked contact") is reserved for **other users'** contacts (§0.15).

### `PATCH /api/v1/me`

Auth `user` · Rate `write.normal`

Body (all optional, at least one required):

| Field            | Type           | Validation                                                                                                                                                                            |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName`    | string         | 1–80 chars, trimmed                                                                                                                                                                   |
| `locale`         | enum           | `"en-IN"` (extend additively)                                                                                                                                                         |
| `timeZone`       | string         | valid IANA zone → `422 unknown_timezone`                                                                                                                                              |
| `marketingOptIn` | boolean        | Stored separately from transactional preferences (schema §13.2)                                                                                                                       |
| `avatarAssetId`  | string \| null | must be a `mediaAssets` doc with `kind: "event_logo"`-class branding upload owned by the caller; otherwise → `422 validation_failed` with `details.fields[].path === "avatarAssetId"` |

`200` → the full `/me` body. Changing email/phone is **not** available here — it goes through Better Auth (which triggers `auth.contact.changed`).

### `GET /api/v1/me/push-tokens` · `POST` · `DELETE /{tokenId}`

Auth `user` · Phase 3 (mobile)

`POST` body: `{ "token": "<fcm/apns token>", "platform": "android"|"ios", "deviceId": "..." }`. The server stores **only** `tokenHash` (schema §13.2). The response never echoes the token. `GET` returns `[{ id, platform, deviceId, lastSeenAt }]`.

---

## 1.3 Sessions & devices

### `GET /api/v1/me/sessions`

Auth `user`

```json
{
  "data": [
    {
      "id": "sess_...",
      "current": true,
      "deviceLabel": "Chrome on macOS",
      "ipCountry": "IN",
      "createdAt": "...",
      "lastActiveAt": "...",
      "expiresAt": "..."
    }
  ]
}
```

Raw IPs are never returned — only `ipCountry`. Full IP is stored hashed (`auditLogs.actor.ipHash`).

### `DELETE /api/v1/me/sessions/{sessionId}` → `204`

### `POST /api/v1/me/sessions:revoke-all`

Auth `user` · Body `{ "keepCurrent": true }` → `204`. Emits `account.sessions.revoked`. This is the endpoint the "not you?" action in `auth.signin.new_device` links to.

---

## 1.4 Account deletion

### `POST /api/v1/me/deletion`

Auth `user` · Idempotency optional · Rate `write.normal`

Body: `{ "reason": "string?", "confirmEmail": "rahul@example.com" }` — `confirmEmail` must match exactly (`422 confirmation_mismatch`).

Sets `userProfiles.status = "deletion_pending"` and `deletionScheduledAt = now + 14 days`. Emits `account.deletion.requested` (in-app + email + **mobile**, because irreversible — notification §4.2).

`202` →

```json
{
  "status": "deletion_pending",
  "scheduledAt": "2026-10-09T...",
  "cancelUntil": "2026-10-09T...",
  "cancelUrl": "/api/v1/me/deletion"
}
```

**Does not delete anything immediately.** Purge runs from cron (§10.2) and emits `account.deletion.completed` to the last known email (in-app is impossible by then).

### `DELETE /api/v1/me/deletion`

Auth `user` — cancels within the window. `204`. `409 deletion_already_executed` if the purge has started.

---

## 1.5 Anonymous attendee sessions

The mechanism behind _"attendees must be able to upload a selfie without logging in"_ (schema §13.5).

### `POST /api/v1/p/attendee-sessions`

Auth `public` · Rate 60 / hour / IP

Body: `{ "eventSlug": "k7m2xq9p" }` (optional; appends to `eventIds`).

`201` →

```json
{
  "sessionToken": "opat_9f2c...", // RAW TOKEN — returned exactly once, never again
  "expiresAt": "2026-10-25T...",
  "issuedAt": "2026-09-25T..."
}
```

Also sets:

```http
Set-Cookie: op_att=opat_9f2c...; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000
```

- Server stores `sha256(token)` in `attendeeSessions.tokenHash`. TTL 30 days.
- Web clients ignore `sessionToken` and rely on the cookie. Mobile/native clients store it in the OS keychain and send `X-Attendee-Session`.
- `deviceFingerprint` is derived server-side from hashed UA/IP/Accept-Language for abuse detection only.
- **Anonymous attendees are deliberately unreachable by notifications** (notification §2). Their UI state comes from polling §6.4 with this token. This is a privacy feature.

### `GET /api/v1/p/attendee-sessions/current`

Auth `attendee`

```json
{
  "id": "...",
  "kind": "anonymous",
  "eventSlugs": ["k7m2xq9p"],
  "claimedByUserId": null,
  "expiresAt": "..."
}
```

`401 attendee_session_expired` once TTL has passed — the client must re-create a session and the attendee must re-upload a selfie. Make this explicit in UI copy.

---

# Part 2 — Tenancy & collaboration

## 2.1 Tenants

### `GET /api/v1/tenants/{tenantId}`

Auth `user` + member of tenant · Rate `read.normal`

Powers the organizer dashboard header in one read (schema §13.3, `counters` cache).

```json
{
  "id": "6702f200...",
  "slug": "rahul-studio",
  "name": "Rahul Studio",
  "status": "active",
  "ownerUserId": "6702f1a3...",
  "billingContactUserId": "6702f1a3...",
  "dataRegion": "in",
  "myRole": "owner",
  "counters": {
    "eventCount": 12,
    "activeEventCount": 3,
    "imageCount": 41208,
    "storageBytes": 73400320000,
    "attendeeCount": 1840,
    "approximate": true,
    "reconciledAt": "2026-09-25T02:00:00.000Z"
  },
  "settings": {
    "defaultTimeZone": "Asia/Kolkata",
    "brandLogoUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
    "defaultWatermarkUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=..."
  },
  "createdAt": "..."
}
```

`counters.approximate: true` is mandatory and must be surfaced as such to developers — these are `$inc` caches reconciled nightly (schema P7), not live aggregations.

### `PATCH /api/v1/tenants/{tenantId}`

Auth `user` + role `owner`|`admin` · Body: `name`, `settings.defaultTimeZone`, `settings.brandLogoAssetId`, `settings.defaultWatermarkAssetId`, `billingContactUserId` (owner only; must be an active `tenantMembers` row → `422 invalid_billing_contact`).

### `POST /api/v1/tenants/{tenantId}/assets/branding`

Auth `user` + role `owner`|`admin` · **The one byte-accepting endpoint** · `multipart/form-data`, field `file`, ≤2 MB, `image/png|image/jpeg|image/svg+xml|image/webp`

`201` → `{ "assetId": "...", "kind": "event_logo"|"watermark", "url": "https://pic.openpic.in/t/...", "bytes": 48120 }`

`413 file_too_large` / `415 unsupported_media_type`.

> Tenant creation is **not** a public endpoint in v1. A tenant is created by the Better Auth post-signup hook the first time a user takes an organizer action, or by an admin. `POST /api/v1/tenants` is reserved for v2 (multi-workspace).

## 2.2 Tenant members

### `GET /api/v1/tenants/{tenantId}/members`

Auth `user` + member

```json
{
  "data": [
    {
      "userId": "...",
      "displayName": "Rahul Menon",
      "emailMasked": "r•••@example.com",
      "role": "owner",
      "status": "active",
      "joinedAt": "...",
      "invitedByUserId": null,
      "avatarUrl": null
    }
  ]
}
```

### `PATCH /api/v1/tenants/{tenantId}/members/{userId}` — `{ "role": "admin"|"member" }`, owner only. Cannot change the owner's own role (`409 cannot_demote_owner`).

### `DELETE /api/v1/tenants/{tenantId}/members/{userId}` — soft removal (`status: "removed"`, `removedAt`). `204`. Cannot remove the owner (`409`).

## 2.3 Invitations

Backed by `invitations` (schema §13.6), the **single owner of the terminal decision**. This section implements notification §7 exactly: _acceptance/rejection is idempotent and final across channels._

### Non-negotiable behavioural contract

1. Every terminal transition is **one** conditional `findOneAndUpdate` with `status: "pending"` and `expiresAt: {$gt: now}` in the filter.
2. If it matches zero documents, the endpoint reads the current state and returns **`200`** with that state. **Never `409`.** A second email-link click, or an in-app click after an email accept, is a normal success.
3. After a successful transition, the server runs `notifications.updateMany` over `{"actionTarget.kind":"invitation","actionTarget.id":inviteId}` setting `actions.$[].state = "unavailable"`, `actionTarget.state = "resolved"`, `actionResolvedVia`, `actionResolvedAt` — closing the affordance in every channel.
4. `revoked` and `expired` make acceptance **structurally impossible**, because the filter can never match. There is no permission check to forget.

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/invitations`

Auth `user` + event role `organizer` · **Idempotency required** · Entitlements `coorganizers.per_event`

```json
{
  "invitee": { "kind": "email", "email": "buck@example.com" },
  "role": "co_organizer",
  "message": "Please help with the reception photos."
}
```

`invitee.kind` ∈ `"user"` (`userId`) | `"email"` (`email`) | `"phone"` (`phoneE164`). An invite **may precede the account** (schema §13.6).

`201` →

```json
{
  "id": "6703bb...",
  "kind": "event_co_organizer",
  "eventId": "...",
  "role": "co_organizer",
  "status": "pending",
  "inviteeMasked": "b•••@example.com",
  "channelsNotified": ["in_app", "email", "sms"],
  "expiresAt": "2026-10-09T...",
  "createdAt": "..."
}
```

- Emits `collab.invite.sent` → **in-app + email + mobile, all three** (notification §4.6, PRD requirement).
- The raw token is **never** returned. It exists only inside the email/SMS link.
- `409 invitation_already_pending` if a pending invite for the same `(eventId, invitee)` exists — enforced by the unique partial index, surfaced as an error rather than a silent duplicate.
- `403 plan_limit_exceeded` (`coorganizers.per_event`) counts `eventMembers(active) + invitations(pending)`.

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/invitations?status=pending`

Auth `user` + event member. Sorted `createdAt` desc.

### `DELETE /api/v1/tenants/{tenantId}/events/{eventId}/invitations/{invitationId}`

Auth `user` + event role `organizer` — **revoke**.

Sets `status: "revoked"`, `revokedAt`, `revokedByUserId`, `revokeReason`. Emits `collab.invite.revoked` and marks the invitee's in-app actions `unavailable`. `200` with the invitation in its current state (idempotent — revoking an already-revoked invite is `200`).

### `GET /api/v1/me/invitations?status=pending`

Auth `user` — "my pending invitations" across all tenants (index `{"invitee.userId":1, status:1, createdAt:-1}`).

```json
{
  "data": [
    {
      "id": "6703bb...",
      "kind": "event_co_organizer",
      "status": "pending",
      "role": "co_organizer",
      "event": {
        "id": "...",
        "name": "Rahul & Priya's Wedding",
        "startAt": "...",
        "displayTimeZone": "Asia/Kolkata"
      },
      "tenant": { "id": "...", "name": "Rahul Studio" },
      "invitedBy": { "displayName": "Rahul Menon" },
      "message": "Please help with the reception photos.",
      "expiresAt": "...",
      "createdAt": "..."
    }
  ]
}
```

### `POST /api/v1/me/invitations/{invitationId}/accept` · `.../reject`

Auth `user` — the in-app path.

`200` (both first call and every replay) →

```json
{
  "id": "6703bb...",
  "status": "accepted",
  "resolvedAt": "2026-09-25T09:14:00.000Z",
  "resolvedVia": "in_app",
  "alreadyResolved": false,
  "membership": { "eventId": "...", "role": "co_organizer" },
  "redirectUrl": "/events/6702ff.../images"
}
```

On replay: identical body with `"alreadyResolved": true` and the original `resolvedVia` (e.g. `"email"`). Frontend renders "Already accepted" — not an error toast.

`410 invitation_expired` and `410 invitation_revoked` are the only non-`200` terminal outcomes, because those states mean the affordance should disappear rather than report success. `accept`/`reject` on an already-`accepted`/`rejected` invite is `200`.

Accept is wrapped in a **transaction**: `invitations` transition + `eventMembers` insert (schema §23). Emits `collab.invite.accepted` (to organizer) and, on reject, `collab.invite.rejected`.

### `POST /api/v1/invitations/{token}/accept` · `.../reject`

Auth `public` → but requires a resolvable identity.

The email/SMS link path. `{token}` is the raw one-time token; the server looks up `sha256(token)` against `invitations.tokenHash`.

- If the caller **is** authenticated and the session user matches/resolves the `invitee` → behaves exactly like the in-app path, `resolvedVia: "email"` (or `"sms"`, taken from a `?via=` hint, defaulting to `"email"`).
- If the caller is **not** authenticated → `401` with:
  ```json
  {
    "error": {
      "code": "authentication_required",
      "message": "Sign in to accept this invitation.",
      "details": {
        "loginUrl": "/sign-in?next=%2Finvite%2F<token>%2Faccept",
        "inviteePreview": { "emailMasked": "b•••@example.com" }
      },
      "requestId": "req_...",
      "retryable": false
    }
  }
  ```
  The token must **not** be consumed. The invitee signs in (or signs up — the post-signup hook resolves `invitee.email` → `userId`) and is returned to the same URL.
- If authenticated as a **different** user than the invitee → `403 invitation_not_for_you`.
- Unknown/garbage token → `404 not_found`. Do not distinguish "never existed" from "already consumed".

### `GET /api/v1/invitations/{token}`

Auth `public` — read-only preview so the landing page can render before sign-in. Returns `status`, event name, inviter display name, `expiresAt`, masked invitee. **Never** returns the token, `userId`s, or tenant internals. Rate-limited 20 / min / IP.

### `DELETE /api/v1/tenants/{tenantId}/events/{eventId}/members/{userId}`

Auth `user` + event role `organizer` — remove an **accepted** co-organizer.

Sets `eventMembers.status = "removed"` and the originating `invitations.status = "revoked"` (so the PRD's "must not be able to accept after removal" holds structurally). Emits `collab.member.removed` (to the removed user, in-app + email — they lose access to content they uploaded) and `collab.member.removed.ack` (to the organizer, in-app only).

`409 cannot_remove_organizer` if the target holds `role: "organizer"` — guarded by the unique partial index enforcing exactly one organizer per event.

---

# Part 3 — Plans, billing, entitlements

## 3.1 Plans (public)

### `GET /api/v1/plans?currency=INR&billingCycle=monthly`

Auth `public` · `Cache-Control: public, max-age=300` · supports `ETag`/`304`

Drives the pricing page from `plans` data so copy changes are not deploys (schema §14.1).

```json
{
  "data": [
    {
      "key": "free",
      "name": "Free",
      "description": "...",
      "tierRank": 0,
      "selfServe": true,
      "salesAssisted": false,
      "marketingFeatures": ["1 active event", "500 images", "7-day gallery"],
      "prices": [],
      "entitlements": {
        "events.active": {
          "limit": 1,
          "resetPeriod": "monthly",
          "scope": "tenant",
          "enforcement": "hard",
          "display": "1 active event / month"
        },
        "storage.bytes": {
          "limit": 2147483648,
          "resetPeriod": "lifetime",
          "scope": "tenant",
          "enforcement": "hard",
          "display": "2 GB"
        },
        "images.per_event": {
          "limit": 500,
          "resetPeriod": "none",
          "scope": "event",
          "enforcement": "hard",
          "display": "500 images / event"
        },
        "gallery.retention_days": {
          "limit": 7,
          "resetPeriod": "none",
          "scope": "event",
          "enforcement": "policy",
          "display": "7-day gallery"
        },
        "originals.download": {
          "limit": null,
          "resetPeriod": "none",
          "scope": "event",
          "enforcement": "feature",
          "enabled": false,
          "display": "Original downloads"
        }
      },
      "version": 1
    },
    {
      "key": "starter",
      "name": "Starter",
      "tierRank": 1,
      "selfServe": true,
      "salesAssisted": false,
      "prices": [
        {
          "priceKey": "starter-monthly-inr",
          "billingCycle": "monthly",
          "amountMinor": 49900,
          "currency": "INR",
          "taxBehavior": "inclusive",
          "trialDays": 0,
          "active": true
        }
      ],
      "entitlements": { "...": "..." },
      "version": 3
    },
    {
      "key": "enterprise",
      "name": "Enterprise",
      "tierRank": 3,
      "selfServe": false,
      "salesAssisted": true,
      "prices": [],
      "contactSalesUrl": "/contact-sales",
      "entitlements": { "...": "..." },
      "version": 1
    }
  ]
}
```

Contract notes:

- `entitlements` is returned **verbatim from the DB**, including `resetPeriod`, `scope` and `enforcement`, plus an added `display` string for UI. Adding an entitlement key is a **data edit with zero API change** — clients must render unknown keys generically from `display` rather than switch on a hard-coded key list.
- `limit: null` + `enforcement: "feature"` means a boolean gate; `enabled` disambiguates on/off.
- `limit: null` + `enforcement: "hard"` means **unlimited**.
- `plans.prices[].externalRefs` is **never** exposed (§0.15).
- Retired plans (`active: false`) are excluded unless `?includeInactive=true` with `admin` auth.

## 3.2 Subscription

### `GET /api/v1/tenants/{tenantId}/subscription`

Auth `user` + member · Rate `read.normal`

The single source for every billing UI surface. Absence of a `subscriptions` document is a **valid free state** (schema §14.3) and is represented explicitly, not as `404`.

```json
{
  "tenantId": "6702f200...",
  "exists": true,
  "status": "past_due",
  "subscribedPlanKey": "starter",
  "subscribedPlanVersion": 3,
  "activePlanKey": "starter",
  "priceKey": "starter-monthly-inr",
  "billingCycle": "monthly",
  "paymentMethodKind": "mandate_upi",
  "mandateStatus": "active",
  "currentPeriodStart": "2026-09-01T00:00:00.000Z",
  "currentPeriodEnd": "2026-10-01T00:00:00.000Z",
  "nextChargeAt": "2026-10-01T00:00:00.000Z",
  "gracePeriodEndsAt": "2026-10-09T00:00:00.000Z",
  "pendingDue": { "amountMinor": 49900, "currency": "INR" },
  "dunning": {
    "attemptCount": 2,
    "lastAttemptAt": "...",
    "remindersSent": ["d1", "d5"],
    "nextReminderAt": "..."
  },
  "scheduledChange": null,
  "cancelAt": null,
  "actions": {
    "canUpgrade": true,
    "canDowngrade": true,
    "canCancel": true,
    "canRetryCharge": true,
    "mustCompleteMandate": false
  },
  "banner": {
    "kind": "past_due",
    "severity": "critical",
    "daysRemaining": 14,
    "downgradeOn": "2026-10-09T00:00:00.000Z",
    "reassurance": "Nothing has been deleted. Your photos and events are safe."
  },
  "updatedAt": "..."
}
```

Free tenant with no document:

```json
{
  "tenantId": "...",
  "exists": false,
  "status": "none",
  "activePlanKey": "free",
  "subscribedPlanKey": "free",
  "pendingDue": null,
  "actions": {
    "canUpgrade": true,
    "canDowngrade": false,
    "canCancel": false,
    "canRetryCharge": false,
    "mustCompleteMandate": false
  },
  "banner": null
}
```

**`banner.reassurance` is mandatory on `past_due` and `downgraded`.** Notification §4.3 calls the "nothing has been deleted" message _the single most important copy in the product_; the API supplies it so web and mobile cannot diverge.

`status` enum: `none` | `incomplete` | `active` | `past_due` | `downgraded` | `cancelled` | `expired`.
`mandateStatus` is **independent** of `status` (schema §14.3): `active` + `revoked` is a legitimate combination meaning "paid up, but the next renewal will fail". The UI must warn on that pair.

### `GET /api/v1/tenants/{tenantId}/subscription/history`

Auth `user` + role `owner`|`admin` — returns `statusHistory[]` (`{from, to, at, reason, actor}`), capped at 50. Answers "why is this tenant on free?" without log diving.

## 3.3 Checkout, upgrade, downgrade, cancel

All four are **provider-agnostic by contract**. No request or response field is named after a payment vendor. `checkoutUrl` is opaque.

### `POST /api/v1/tenants/{tenantId}/billing/checkout`

Auth `user:complete` + role `owner` · **Idempotency required** · Rate `write.normal`

```json
{
  "planKey": "starter",
  "priceKey": "starter-monthly-inr",
  "returnUrl": "https://openpic.in/billing/return"
}
```

- `returnUrl` must be on an allow-listed origin → `422 invalid_return_url`.
- `409 subscription_already_active` if a live subscription exists (unique partial index on `{tenantId}` where `status ∉ {cancelled, expired}`).
- `422 plan_not_self_serve` for `enterprise`.

`201` →

```json
{
  "subscriptionId": "6703cc...",
  "status": "incomplete",
  "checkout": {
    "kind": "redirect",
    "url": "https://<provider-hosted-auth-link>",
    "expiresAt": "2026-09-25T10:14:00.000Z"
  },
  "paymentMethodKind": "mandate_upi",
  "amountMinor": 49900,
  "currency": "INR"
}
```

**The client must never treat a return-URL landing as proof of success.** State changes only on a verified webhook (schema P4). After redirect-back, the client polls `GET /subscription` (2 s interval, 60 s ceiling) and then falls back to the `billing.mandate.pending` notification. Emits `billing.mandate.pending`.

### `POST /api/v1/tenants/{tenantId}/billing/upgrade`

Auth `user:complete` + role `owner` · **Idempotency required**

`{ "targetPlanKey": "professional", "priceKey": "professional-monthly-inr", "returnUrl": "..." }`

Upgrades are **immediate** (billing doc §4.5). Because recurring mandates cannot be mutated in place, this is cancel-old + create-new; the new `subscriptions` document carries `previousSubscriptionId` and the old one is retained with `status: "cancelled"` for history. `usageCounters` are **not** reset — only the limit they are compared against changes.

`201` → same shape as checkout, plus:

```json
{
  "requiresReauthorization": true,
  "notice": "You'll approve the new mandate in your UPI app. Your new limits apply as soon as the first charge succeeds."
}
```

`422 not_an_upgrade` if `targetPlanKey.tierRank <= current.tierRank` (use the downgrade endpoint). Emits `billing.plan.upgraded` on success.

### `POST /api/v1/tenants/{tenantId}/billing/downgrade`

Auth `user:complete` + role `owner` · **Idempotency recommended**

`{ "targetPlanKey": "starter", "acknowledgeConsequences": true }`

Self-serve downgrades take effect **at period end**, unlike upgrades. Writes `subscriptions.scheduledChange = { toPlanKey, effectiveAt: currentPeriodEnd, reason: "self_downgrade" }`.

`acknowledgeConsequences` must be `true` → else `422 acknowledgement_required`, with `details.consequences` computed from current usage vs. target limits:

```json
{
  "error": {
    "code": "acknowledgement_required",
    "details": {
      "consequences": [
        {
          "entitlementKey": "events.active",
          "currentUsage": 15,
          "newLimit": 7,
          "effect": "You won't be able to create new events until your active count falls below 7.",
          "destructive": false
        },
        {
          "entitlementKey": "gallery.retention_days",
          "current": 90,
          "new": 30,
          "effect": "Galleries for events created after the change will expire after 30 days.",
          "destructive": false
        }
      ]
    }
  }
}
```

**Every `effect` must have `destructive: false`.** Nothing already created is retroactively removed or hidden (billing doc §10). If any computed consequence would be destructive, that is a bug in the consequence calculator, not a valid response.

`200` → `{ "scheduledChange": { "toPlanKey": "starter", "effectiveAt": "2026-10-01T..." } }`. Emits `billing.plan.downgrade_scheduled`; the cron sweep emits `billing.plan.downgrade_applied` on the effective date.

### `DELETE /api/v1/tenants/{tenantId}/billing/scheduled-change` → `204`, cancels a scheduled downgrade.

### `POST /api/v1/tenants/{tenantId}/billing/retry-charge`

Auth `user:complete` + role `owner` · **Idempotency required**

The "Pay now" button on the `past_due`/`downgraded` banner. Triggers an on-demand charge against the existing mandate.

`202` → `{ "status": "charge_initiated", "billingTransactionId": "...", "pollUrl": "/api/v1/tenants/current/subscription" }`

`409 no_pending_due` if `pendingDueMinor == 0`. `409 mandate_not_chargeable` if `mandateStatus ∈ {revoked, expired}` — body carries `details.recoveryAction: "recreate_mandate"` and the client is directed to checkout. On success the subscription returns to `active` with `activePlanKey = subscribedPlanKey`, emitting `billing.subscription.reactivated` and `usage.limit.restored`.

### `POST /api/v1/tenants/{tenantId}/billing/cancel`

Auth `user:complete` + role `owner`

`{ "atPeriodEnd": true, "reason": "string?" }`

`200` → `{ "status": "active", "cancelAt": "2026-10-01T...", "note": "Your events and photos are not deleted when the subscription ends." }`

Confirmed by webhook; `status` becomes `cancelled` only then. Emits `billing.subscription.cancelled` (in-app + email + mobile — provider-initiated cancellations happen without user intent).

## 3.4 Transactions & invoices

### `GET /api/v1/tenants/{tenantId}/billing/transactions?cursor=&kind=`

Auth `user` + role `owner`|`admin` · Sorted `occurredAt` desc

```json
{
  "data": [
    {
      "id": "6703dd...",
      "kind": "charge",
      "status": "failed",
      "amountMinor": 49900,
      "currency": "INR",
      "occurredAt": "...",
      "settledAt": null,
      "periodCovered": { "start": "2026-09-01T...", "end": "2026-10-01T..." },
      "invoiceNumber": null,
      "failure": {
        "category": "insufficient_funds",
        "message": "Your bank declined the debit due to insufficient balance.",
        "retryable": true
      }
    }
  ],
  "page": { "nextCursor": null, "hasMore": false, "limit": 40 }
}
```

`failure.category` ∈ `insufficient_funds` | `mandate_revoked` | `auth_required` | `technical`. **Clients and dunning copy branch on `category` only** — `failure.providerCode` is never exposed (schema §14.4). `kind` ∈ `authorization` | `charge` | `refund` | `chargeback` | `credit` | `adjustment`.

### `GET /api/v1/tenants/{tenantId}/billing/invoices/{invoiceNumber}`

Auth `user` + role `owner`|`admin` → `{ "invoiceNumber": "OP-2026-000431", "downloadUrl": "...", "expiresAt": "..." }` (short-lived signed URL, 15 min).

## 3.5 Entitlements & usage

### `GET /api/v1/tenants/{tenantId}/entitlements`

Auth `user` + member · Rate `read.normal` · **Advisory only (§0.14)**

The one call that powers every quota bar, disabled button and upgrade tooltip.

```json
{
  "activePlanKey": "starter",
  "subscribedPlanKey": "starter",
  "subscriptionStatus": "active",
  "blockReason": null,
  "entitlements": [
    {
      "key": "events.active",
      "limit": 7,
      "effectiveLimit": 7,
      "used": 5,
      "remaining": 2,
      "periodKey": "2026-09",
      "resetPeriod": "monthly",
      "resetsAt": "2026-10-01T00:00:00.000Z",
      "scope": "tenant",
      "enforcement": "hard",
      "unlimited": false,
      "thresholdCrossed": null,
      "display": "5 of 7 active events"
    },
    {
      "key": "storage.bytes",
      "limit": 107374182400,
      "effectiveLimit": 160961665024,
      "used": 73400320000,
      "remaining": 87561345024,
      "periodKey": "lifetime",
      "resetPeriod": "lifetime",
      "resetsAt": null,
      "scope": "tenant",
      "enforcement": "hard",
      "unlimited": false,
      "grants": [{ "delta": 53687091200, "source": "purchase", "validUntil": null }],
      "thresholdCrossed": null,
      "display": "68.4 GB of 150 GB"
    },
    {
      "key": "originals.download",
      "limit": null,
      "effectiveLimit": null,
      "enabled": true,
      "scope": "event",
      "enforcement": "feature",
      "unlimited": true,
      "display": "Original downloads"
    }
  ],
  "computedAt": "2026-09-25T09:12:00.000Z"
}
```

- `effectiveLimit = overrideLimit ?? (plan.limit + Σ active grants.delta)` (schema §14.2). `limit` is the raw plan value; both are returned so the UI can show "100 GB + 50 GB add-on".
- `blockReason` is `null` | `"plan_limit"` | `"payment_downgrade"` and drives the global banner.
- `thresholdCrossed` ∈ `null` | `80` | `95` | `100`, mirroring the latched `usage.storage.threshold` / `usage.events.threshold` notifications so the UI and the notification agree.
- Event- and attendee-scoped entitlements appear here with their plan limits but **without** `used`; per-event consumption is returned by `GET /events/{eventId}` (§4.1).

### `GET /api/v1/tenants/{tenantId}/usage?periodKey=2026-09`

Auth `user` + role `owner`|`admin` — raw `usageCounters` rows, for support and reconciliation.

## 3.6 Add-ons

### `POST /api/v1/tenants/{tenantId}/billing/addons`

Auth `user:complete` + role `owner` · **Idempotency required**

`{ "addonKey": "storage-50gb", "quantity": 1, "returnUrl": "..." }`

Creates a one-time charge; on webhook confirmation inserts an **additive** `entitlementGrants` row (`delta`, `source.kind: "purchase"`, `source.billingTransactionId`) — never a mutation of the plan (schema §14.2). Emits `billing.addon.purchased` and, if the purchase clears a block, `usage.limit.restored`.

`201` → checkout envelope as §3.3.

---

# Part 4 — Events

## 4.1 Event CRUD

### `POST /api/v1/tenants/{tenantId}/events`

Auth `user:complete` + role `owner`|`admin`|`member` · **Idempotency required** · Entitlements `events.active`, `events.duration_days`

```json
{
  "name": "Rahul & Priya's Wedding",
  "description": "Reception photos",
  "startAt": "2026-11-14T12:00:00.000Z",
  "endAt": "2026-11-16T18:00:00.000Z",
  "displayTimeZone": "Asia/Kolkata",
  "logoAssetId": null,
  "watermarkAssetId": null,
  "publish": true
}
```

Validation:

| Rule                                                                     | Failure                                                                                               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `name` 1–120 chars                                                       | `422 validation_failed`                                                                               |
| `endAt > startAt`                                                        | `422 invalid_date_range`                                                                              |
| `displayTimeZone` valid IANA                                             | `422 unknown_timezone`                                                                                |
| `ceil((endAt - startAt) / 1 day) <= entitlement("events.duration_days")` | `403 plan_limit_exceeded` (`details.entitlementKey: "events.duration_days"`, `details.requestedDays`) |
| `startAt` ≥ now − 30 days                                                | `422 start_too_far_past`                                                                              |

Server-derived, **materialised at creation and on every date edit** (schema §15.1):

- `uploadWindowEndsAt = endAt + entitlement("events.post_upload_days")`
- `retentionExpiresAt = endAt + entitlement("gallery.retention_days")`
- one `accessLinks[]` element with a random 8-char `slug`, `active: true`
- one `eventMembers` row `{role: "organizer", status: "active"}` (unique partial index guarantees exactly one)
- `sequence` counter initialised

Executed in a **transaction** with the `usageCounters.$inc` on `events.active` (schema §23).

`201`, `Location: /api/v1/tenants/{tenantId}/events/{eventId}` → the full Event DTO. Emits `event.created` (carrying share link + QR — the organizer's most-needed artefact).

### `GET /api/v1/tenants/{tenantId}/events?status=&cursor=&limit=&q=`

Auth `user` + member · Sorted `startAt` desc (index `{tenantId:1, status:1, startAt:-1}`)

`status` ∈ `draft` | `published` | `live` | `ended` | `archived` | `deleting` (repeatable). `q` matches `name` (prefix, case-insensitive).

```json
{
  "data": [
    {
      "id": "6702ff...",
      "name": "Rahul & Priya's Wedding",
      "status": "live",
      "startAt": "...",
      "endAt": "...",
      "displayTimeZone": "Asia/Kolkata",
      "uploadWindowEndsAt": "...",
      "retentionExpiresAt": "...",
      "coverThumbnailUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
      "counters": {
        "imageCount": 4120,
        "processedImageCount": 4118,
        "failedImageCount": 2,
        "attendeeCount": 84,
        "matchCount": 1904,
        "storageBytes": 12884901888,
        "approximate": true
      },
      "myRole": "organizer",
      "shareUrl": "https://openpic.in/e/k7m2xq9p",
      "createdAt": "..."
    }
  ],
  "page": { "nextCursor": "...", "hasMore": true, "limit": 40 }
}
```

### `GET /api/v1/tenants/{tenantId}/events/{eventId}`

Auth `user` + event member · Returns `ETag`

Full Event DTO — list fields plus:

```json
{
  "description": "Reception photos",
  "logoUrl": null,
  "watermarkUrl": null,
  "thumbnailPreset": "default",
  "accessLinks": [
    {
      "slug": "k7m2xq9p",
      "active": true,
      "shareUrl": "https://openpic.in/e/k7m2xq9p",
      "qrUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
      "scanCount": 148,
      "createdAt": "...",
      "revokedAt": null
    }
  ],
  "members": [
    { "userId": "...", "displayName": "Rahul Menon", "role": "organizer", "status": "active" }
  ],
  "windows": {
    "uploadOpen": true,
    "uploadClosesAt": "2026-11-23T18:00:00.000Z",
    "uploadClosesInHours": 168,
    "galleryExpiresAt": "2027-02-14T18:00:00.000Z",
    "canExtendUploadWindow": false
  },
  "entitlementUsage": [
    { "key": "images.per_event", "limit": 5000, "used": 4120, "remaining": 880 },
    { "key": "coorganizers.per_event", "limit": 3, "used": 1, "remaining": 2 }
  ],
  "pipeline": {
    "status": "indexing",
    "queuedCount": 2,
    "processingCount": 0,
    "failedCount": 2,
    "percentComplete": 99.95,
    "lastIndexedAt": "...",
    "delayed": false
  },
  "createdByUserId": "...",
  "updatedAt": "...",
  "schemaVersion": 1
}
```

`pipeline.status` ∈ `idle` | `indexing` | `indexed` | `delayed` | `partial_failure`. This drives the organizer's "did my 4,000 photos land?" surface, which notification §4.7 identifies as the organizer's biggest anxiety.

### `PATCH /api/v1/tenants/{tenantId}/events/{eventId}`

Auth `user` + event role `organizer`|`co_organizer` · **`If-Match` required**

Editable: `name`, `description`, `startAt`, `endAt`, `displayTimeZone`, `logoAssetId`, `watermarkAssetId`, `thumbnailPreset`, `visibilityDefaults`, `status` (`draft → published` only).

- Changing `startAt`/`endAt` **recomputes** `uploadWindowEndsAt` and `retentionExpiresAt` and returns both in the response. If the recomputation would move `retentionExpiresAt` into the past → `422 retention_would_expire_immediately`.
- Re-validates `events.duration_days`.
- Emits `event.details.updated`, which is **coalesced over a 15-minute window** (notification §4.5) so a 6-field edit is one notification. The API does not coalesce; the notification resolver does.
- `409 event_deleting` if `status == "deleting"`.

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/archive` → `200`, emits `event.archived`.

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/upload-window:extend`

Auth `user` + role `organizer` · Entitlements `events.post_upload_days`

`{ "additionalDays": 7 }` → `200` with new `uploadWindowEndsAt`, or `403 plan_limit_exceeded` with `details.upgradePath` (the upgrade offer named in `event.upload_window.closed`).

### `DELETE /api/v1/tenants/{tenantId}/events/{eventId}`

Auth `user` + role `organizer` · Body `{ "confirmName": "Rahul & Priya's Wedding" }` (`422 confirmation_mismatch`)

Sets `status: "deleting"`, `deletedAt`, and enqueues an ordered purge (storage objects → vectors → metadata, counted for DSR evidence — schema §22). **This is the only content-destroying endpoint in the contract, and it is user-initiated.**

`202` → `{ "status": "deleting", "purgeScheduledAt": "...", "irreversible": true }`. Emits `event.deleted` (in-app + email + **mobile** — irreversible and destroys attendee access).

## 4.2 Access links & QR

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/access-links:rotate`

Auth `user` + role `organizer` · Body `{ "confirmUnderstood": true }`

Pushes a new `accessLinks[]` element and sets `active: false` + `revokedAt` on the previous one (schema §15.1). **Already-printed QR codes stop working** — hence the mandatory confirmation and the `event.link.rotated` notification.

`200` →

```json
{
  "accessLinks": [
    {
      "slug": "p9z4nn2k",
      "active": true,
      "shareUrl": "https://openpic.in/e/p9z4nn2k",
      "qrUrl": "...",
      "createdAt": "..."
    },
    { "slug": "k7m2xq9p", "active": false, "revokedAt": "...", "scanCount": 148 }
  ],
  "warning": "Previously printed QR codes for k7m2xq9p will no longer work."
}
```

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/access-links/{slug}/qr?format=png&size=1024`

Auth `user` + event member · `format` ∈ `png` | `svg` | `pdf`; `size` ∈ 256–2048

`200` with a **redirect-free signed URL** in JSON: `{ "url": "...", "expiresAt": "...", "format": "png", "size": 1024 }`. The QR is generated once and stored as a `mediaAssets` doc (`kind: "export"`), so repeated downloads are cache hits.

## 4.3 Event members

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/members`

Auth `user` + event member

```json
{
  "data": [
    {
      "userId": "...",
      "displayName": "Rahul Menon",
      "role": "organizer",
      "status": "active",
      "emailMasked": "r•••@example.com",
      "addedAt": "...",
      "uploadedImageCount": 3200
    },
    {
      "userId": "...",
      "displayName": "Buck Sharma",
      "role": "co_organizer",
      "status": "active",
      "emailMasked": "b•••@example.com",
      "addedAt": "...",
      "invitationId": "...",
      "uploadedImageCount": 920
    }
  ]
}
```

`uploadedImageCount` is the PRD's attribution requirement; cost stays with `tenantId` regardless (schema §10.1). Invites and removal are in §2.3.

## 4.4 Event images

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/images?cursor=&limit=&status=&visibility=&uploadedBy=&batchId=&sort=`

Auth `user` + event member · Sorted `sequence` desc by default (index `{eventId:1, sequence:-1}`)

`status` filters on `processing.status` ∈ `queued` | `processing` | `done` | `failed` | `skipped`.
`sort` ∈ `sequence_desc` (default) | `sequence_asc`.

```json
{
  "data": [
    {
      "id": "6704aa...",
      "sequence": 4120,
      "thumbnailUrl": "https://pic.openpic.in/t/e3b0c442....webp?exp=1790086400&sig=...",
      "thumbnailUrlExpiresAt": "2026-09-26T09:00:00.000Z",
      "width": 4000,
      "height": 6000,
      "orientation": 1,
      "bytes": 8421310,
      "contentType": "image/jpeg",
      "faceCount": 3,
      "visibility": "visible",
      "processing": {
        "status": "done",
        "attempts": 1,
        "finishedAt": "...",
        "durationMs": 3400,
        "lastError": null
      },
      "uploadedByUserId": "...",
      "uploadBatchId": "...",
      "createdAt": "..."
    }
  ],
  "page": { "nextCursor": "...", "hasMore": true, "limit": 60 },
  "summary": {
    "total": 4120,
    "done": 4118,
    "queued": 0,
    "processing": 0,
    "failed": 2,
    "approximate": true
  }
}
```

`width`/`height`/`orientation` are returned so the grid can reserve correct aspect-ratio space **before** the image loads, with no layout shift (media doc §41, schema §25).

### `PATCH .../images/{imageId}` — `{ "visibility": "hidden" }`. Hiding is **not** deletion. `200`.

### `DELETE .../images/{imageId}` — organizer/co-organizer, user-initiated. Decrements `refCount`; the asset is purged only at `refCount == 0`. `204`.

### `POST .../images/{imageId}/reprocess`

Auth `user` + event member · Only when `processing.status == "failed"`

Resets `processing` to `queued`, zeroes `attempts`, re-enqueues. `409 not_failed` otherwise. `202`.

### `POST .../images:reprocess-failed`

Bulk retry for the whole event. `202` → `{ "requeuedCount": 2 }`. This is the action target of `upload.batch.completed_with_errors` and the `pipeline.image.failed` daily digest.

### `POST .../images/originals:archive`

Auth `user` + event member · Entitlements `originals.download`

Requests a zip of originals. `202` → `{ "jobRef": { "kind": "download", "id": "..." }, "pollUrl": "/api/v1/tenants/{t}/downloads/{id}" }`. Emits `attendee.download.ready`'s organizer analogue on completion. `403 feature_not_available` if `originals.download.enabled == false` on the active plan.

## 4.5 Event stats & analytics

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/stats`

Auth `user` + event member — `events.counters` + pipeline breakdown + top-line attendee funnel (`selfiesUploaded`, `attendeesWithMatches`, `attendeesWithoutMatches`).

### `GET /api/v1/tenants/{tenantId}/analytics?from=2026-09-01&to=2026-09-25&scope=tenant|event&eventId=`

Auth `user` + role `owner`|`admin` · Max 366-day range (`422 range_too_large`)

Reads **only** `analyticsDaily` rollups (schema §20.1) — never aggregates transactional collections at request time.

```json
{
  "scope": { "kind": "tenant", "id": "6702f200..." },
  "from": "2026-09-01",
  "to": "2026-09-25",
  "series": [
    {
      "dateKey": "2026-09-24",
      "eventsCreated": 3,
      "imagesUploaded": 4120,
      "imagesProcessed": 4118,
      "imagesFailed": 2,
      "selfiesUploaded": 87,
      "matchesCreated": 1904,
      "uniqueAttendees": 84,
      "storageBytesAdded": 12884901888,
      "downloads": 412,
      "p95ProcessingMs": 3400
    }
  ],
  "totals": { "...": 0 },
  "computedAt": "2026-09-25T02:00:00.000Z",
  "note": "Rolled up nightly. Today's figures are partial."
}
```

---

# Part 5 — Uploads & media

## 5.1 Upload contract overview

Four-phase, resumable, deduplicated. Bytes go **browser → R2 directly**; the control plane only signs and records.

```
  ① hash (Web Worker, SHA-256)
        │
        ▼
  ② POST /uploads/batch-resolve        ← dedupe + resume decision, batched
        │
        ├── completed   → skip entirely, link asset to event
        ├── in_progress → reuse uploadId, list parts from R2, upload the gaps
        └── not_found   → fresh upload
        │
        ▼
  ③ single PUT (< 8 MB)   OR   multipart create → sign part × n → complete
        │
        ▼
  ④ server writes mediaAssets + eventImages + storage counter (one transaction)
        → enqueue face pipeline → emit upload.batch.* / pipeline.*
```

Fixed parameters (all read from `platformSettings`, exposed via §5.1.1 so the client never hard-codes them):

| Parameter                        | Value                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `multipartThresholdBytes`        | 8 388 608 (8 MB)                                                                                |
| `partSizeBytes`                  | 8 388 608                                                                                       |
| `maxFileBytes`                   | 104 857 600 (100 MB)                                                                            |
| `maxBatchSize`                   | 500 hashes per `batch-resolve` call                                                             |
| `supportedMimeTypes` (originals) | `image/jpeg`, `image/png`, `image/webp`, `image/avif`, `image/heic`, `image/heif`, `image/tiff` |
| Presign TTL (single PUT)         | 900 s                                                                                           |
| Presign TTL (part)               | 900 s                                                                                           |
| `uploadSessions` TTL             | 5 days (staggered before R2's 7-day abort lifecycle rule)                                       |

**The content hash is the identity.** `mediaAssets.contentHash` (lowercase hex SHA-256 of the original bytes) doubles as the R2 object key and as the media URL path segment. `fileName`, `declaredSize` and `declaredMimeType` are **display/audit only and never identity**.

### 5.1.1 `GET /api/v1/uploads/config`

Auth `user` · `Cache-Control: private, max-age=300`

```json
{
  "multipartThresholdBytes": 8388608,
  "partSizeBytes": 8388608,
  "maxFileBytes": 104857600,
  "maxBatchSize": 500,
  "supportedMimeTypes": [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/heif",
    "image/tiff"
  ],
  "presignTtlSeconds": 900,
  "maxConcurrentParts": 4,
  "hashAlgorithm": "sha256"
}
```

Uppy's `shouldUseMultipart` and the client's hashing worker read from here. Tuning upload behaviour becomes a settings change, not a frontend deploy.

## 5.2 Batch resolve

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batch-resolve`

Auth `user` + event member · Rate `upload.resolve` · Entitlements advisory-checked (`storage.bytes`, `images.per_event`)

**Runs before any file is handed to Uppy.** One round trip for up to 500 files.

```json
{
  "batchId": "6705aa...",
  "files": [
    {
      "hash": "e3b0c442...",
      "size": 8421310,
      "fileName": "DSC_0421.JPG",
      "mimeType": "image/jpeg"
    },
    { "hash": "9f2c1d88...", "size": 2140000, "fileName": "DSC_0422.JPG", "mimeType": "image/jpeg" }
  ]
}
```

`batchId` is **client-generated** (UUIDv4 or ObjectId-shaped string) and groups the whole drag-and-drop batch. It drives `upload.batch.*` notifications and the progress bar. Reusing a `batchId` across calls is allowed and appends to the batch.

`200` →

```json
{
  "batchId": "6705aa...",
  "uploadWindowOpen": true,
  "resolutions": {
    "e3b0c442...": {
      "state": "completed",
      "assetId": "6704bb...",
      "eventImageId": "6704aa...",
      "linked": true,
      "bytes": 8421310
    },
    "9f2c1d88...": {
      "state": "in_progress",
      "uploadId": "2~abc...",
      "mode": "multipart",
      "uploadedPartNumbers": [1, 2, 3],
      "uploadedBytes": 25165824
    },
    "77aa33bb...": { "state": "not_found", "mode": "single" },
    "cc44dd55...": {
      "state": "rejected",
      "reason": "unsupported_mime_type",
      "message": "HEIC Live Photos with embedded video are not supported."
    }
  },
  "quota": {
    "storage": { "remainingBytes": 34161000000, "requestedBytes": 10561310, "sufficient": true },
    "images": { "remaining": 880, "requested": 2, "sufficient": true }
  }
}
```

`state` semantics:

| `state`       | Client behaviour                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `completed`   | **Skip the upload entirely.** If `linked: false`, the asset exists in this tenant but is not yet attached to this event — call §5.3's link-only variant. Counts as `duplicates skipped` in the batch summary.                              |
| `in_progress` | Resume. Pass `uploadId` as `existingUploadId` to Uppy's `createMultipartUpload`; `uploadedPartNumbers` is sourced **live from R2 `ListParts`**, not from Mongo (upload doc §5) — there is no part-tracking collection to fall out of sync. |
| `not_found`   | Fresh upload via `mode`.                                                                                                                                                                                                                   |
| `rejected`    | Do not attempt. Folded into the `upload.batch.files_rejected` summary; **never** notified per file.                                                                                                                                        |

Scoping rule that must not be got wrong (upload doc §5, schema §16.2): the **completed** lookup is scoped by `{tenantId, contentHash}` (tenant-wide dedupe, so an organizer and co-organizer uploading the same photo dedupe correctly). The **in_progress** lookup is additionally scoped by `createdByUserId`, so user B never attaches to user A's in-flight multipart upload. Dedupe is never global across tenants (schema §16.1).

`409 upload_window_closed` if `now > uploadWindowEndsAt`, with `details.uploadWindowEndsAt` and `details.canExtend`.

## 5.3 Single PUT path

### `POST /api/v1/tenants/{tenantId}/events/{eventId}/uploads/params`

Auth `user` + event member · **Idempotency required** · Uppy hook `getUploadParameters`

```json
{
  "batchId": "6705aa...",
  "hash": "77aa33bb...",
  "size": 2140000,
  "fileName": "DSC_0423.JPG",
  "mimeType": "image/jpeg"
}
```

`201` →

```json
{
  "uploadSessionId": "6705cc...",
  "method": "PUT",
  "url": "https://<r2-presigned>?X-Amz-Signature=...",
  "headers": { "Content-Type": "image/jpeg" },
  "expiresAt": "2026-09-25T09:29:00.000Z",
  "completeUrl": "/api/v1/tenants/6702f200.../events/6702ff.../uploads/6705cc.../complete"
}
```

The response **never** contains the bucket name or object key (§0.15) — only the opaque presigned URL.

### `POST .../uploads/{uploadSessionId}/complete`

Auth `user` + event member · **Idempotency required** · Entitlements `storage.bytes`, `images.per_event`

`{ "etag": "\"a3f9e1...\"", "bytes": 2140000 }`

Server: `HeadObject` to verify existence, size and checksum → **transaction** { insert/upsert `mediaAssets`, insert `eventImages` (unique `{eventId, assetId}`), `$inc` storage + image counters } → enqueue thumbnail derivative + face pipeline.

`201` → `EventImage` DTO with `processing.status: "queued"`.
`409 size_mismatch` if stored bytes differ from `bytes` by >1 %. `409 duplicate_in_event` is **not** an error path — the unique index collision is caught and returned as `200` with the existing `eventImage` (idempotent by design, schema §16.3).

### Link-only variant — `POST .../uploads:link`

`{ "batchId": "...", "assetIds": ["6704bb..."] }` → attaches already-stored tenant assets to this event without any byte transfer. Used for `state: "completed", linked: false`. `201` → `{ "linked": [ { "assetId": "...", "eventImageId": "..." } ], "skipped": [] }`.

## 5.4 Multipart path

Six endpoints, mapping 1:1 onto Uppy's `@uppy/aws-s3` hooks. **Do not run Uppy Companion.**

| Uppy hook                 | Endpoint                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `createMultipartUpload`   | `POST .../uploads/multipart`                                   |
| `listParts`               | `GET .../uploads/multipart/{uploadId}/parts`                   |
| `signPart`                | `GET .../uploads/multipart/{uploadId}/parts/{partNumber}/sign` |
| `completeMultipartUpload` | `POST .../uploads/multipart/{uploadId}/complete`               |
| `abortMultipartUpload`    | `DELETE .../uploads/multipart/{uploadId}`                      |
| `getUploadParameters`     | §5.3                                                           |

### `POST .../uploads/multipart`

`{ "batchId": "...", "hash": "9f2c1d88...", "size": 41943040, "fileName": "DSC_0422.NEF", "mimeType": "image/tiff", "existingUploadId": "2~abc..." }`

If `existingUploadId` is supplied and still valid, it is **reused** (no new `CreateMultipartUpload`); otherwise a new one is created. Upserts `uploadSessions` with `status: "pending"`, `mode: "multipart"`, and the provider's multipart id inside `externalRefs` (never a vendor-named field — schema §11.1).

`201` → `{ "uploadSessionId": "...", "uploadId": "2~abc...", "key": "<opaque handle>", "partSizeBytes": 8388608, "partCount": 5, "resumed": true }`

> `key` is an **opaque server-issued handle**, not the R2 object key. Uppy passes it back on later calls; the server maps handle → real key. This keeps §0.15 intact while satisfying Uppy's hook signature.

### `GET .../uploads/multipart/{uploadId}/parts?key={handle}`

Proxies R2 `ListParts`. `200` → `{ "parts": [ { "PartNumber": 1, "ETag": "\"...\"", "Size": 8388608 } ] }` (S3-shaped keys, because Uppy consumes them verbatim).

### `GET .../uploads/multipart/{uploadId}/parts/{partNumber}/sign?key={handle}`

Rate `upload.sign` · `partNumber` ∈ 1–10000

`200` → `{ "url": "https://<r2-presigned>", "expiresAt": "..." }`. Called again automatically by Uppy on retry after expiry — this is expected, not an error.

### `POST .../uploads/multipart/{uploadId}/complete`

**Idempotency required** · Entitlements `storage.bytes`, `images.per_event`

`{ "key": "<handle>", "parts": [ { "PartNumber": 1, "ETag": "\"...\"" } ] }`

Calls `CompleteMultipartUpload`, then the same transaction as §5.3. Sets `uploadSessions.status = "completed"`, `assetId`. `201` → `EventImage` DTO.

`409 parts_missing` → `details.missingPartNumbers`. `409 upload_expired` if R2 has already aborted the multipart upload (past the 7-day lifecycle rule) — the client must restart from `batch-resolve`.

### `DELETE .../uploads/multipart/{uploadId}?key={handle}` → `AbortMultipartUpload`, `uploadSessions.status = "aborted"`. `204`. Idempotent.

## 5.5 Batch status

### `GET /api/v1/tenants/{tenantId}/events/{eventId}/uploads/batches/{batchId}`

Auth `user` + event member · Rate `read.normal` · Poll 3 s while the batch is active, stop at `phase: "complete"`

```json
{
  "batchId": "6705aa...",
  "phase": "processing",
  "createdAt": "...",
  "completedAt": null,
  "files": {
    "total": 500,
    "uploaded": 500,
    "duplicatesSkipped": 12,
    "rejected": 3,
    "failedUpload": 0
  },
  "pipeline": { "queued": 40, "processing": 8, "done": 449, "failed": 3 },
  "failures": [
    {
      "eventImageId": "...",
      "fileName": "DSC_0999.JPG",
      "code": "no_faces_detected",
      "message": "No faces were detected in this image.",
      "retryable": false
    }
  ],
  "stalledSessions": [
    {
      "uploadSessionId": "...",
      "fileName": "DSC_1000.NEF",
      "uploadedBytes": 25165824,
      "totalBytes": 41943040,
      "abortDeadline": "..."
    }
  ]
}
```

`phase` ∈ `uploading` | `processing` | `complete` | `complete_with_errors`.

Notification coupling (notification §4.7), enforced server-side, not client-side:

- `upload.batch.completed` when `phase → complete` with zero failures. Email **only if** ≥100 files or >10 min runtime.
- `upload.batch.completed_with_errors` when `phase → complete_with_errors` — always email, carries the retry action.
- `upload.batch.files_rejected` folds rejections into the batch summary; **never** per file.
- `upload.session.stalled` when a session is idle >24 h with parts stored.
- `upload.blocked.quota` goes to the uploader **and** the organizer, because only the organizer can buy storage — otherwise a co-organizer is stuck silently.

## 5.6 Media signed URLs

### `POST /api/v1/media/signed-urls`

Auth `user` **or** `attendee` · Rate `media.sign` · Max 200 items

The refresh endpoint for a long-lived gallery page whose 24 h thumbnail URLs have expired.

```json
{
  "scope": { "kind": "event", "id": "6702ff..." },
  "items": [
    { "kind": "thumbnail", "imageId": "6704aa..." },
    { "kind": "original", "imageId": "6704aa..." }
  ]
}
```

`200` →

```json
{
  "urls": [
    {
      "imageId": "6704aa...",
      "kind": "thumbnail",
      "url": "https://pic.openpic.in/t/e3b0c442....webp?exp=1790086400&sig=...",
      "expiresAt": "2026-09-26T09:00:00.000Z"
    },
    {
      "imageId": "6704aa...",
      "kind": "original",
      "url": "https://pic.openpic.in/o/e3b0c442....jpg?exp=1790001300&sig=...",
      "expiresAt": "2026-09-25T09:15:00.000Z"
    }
  ],
  "denied": []
}
```

Authorization is performed **per item** before signing (media doc §25):

- `thumbnail` — caller must be an event member, **or** an attendee with a `faceMatches` row for that `imageId`.
- `original` — event member with `originals.download` enabled, **or** an attendee with a match **and** the event's plan permitting attendee original access.

Items the caller may not access are returned in `denied: [{ imageId, kind, code }]` with the **whole request still `200`** — a 200-item batch must not fail because one image was hidden. If **every** item is denied → `403`.

Token lifetimes (media doc §8): thumbnails **24 h**, originals **15 min**. Never invert these.

## 5.7 Media data plane (`pic.openpic.in`)

Not a JSON API. Documented so clients and the Cloudflare Worker agree.

```
GET https://pic.openpic.in/t/<sha256>.webp?exp=<unix>&sig=<base64url>     # thumbnail, watermarked
GET https://pic.openpic.in/o/<sha256>.<ext>?exp=<unix>&sig=<base64url>    # original
```

Signature (media doc §21):

```
payload   = METHOD + "\n" + PATH + "\n" + EXPIRY
signature = base64url(HMAC-SHA256(MEDIA_SIGNING_SECRET, payload))
```

Client contract:

- Use `<img src>` directly. **Never** send `Authorization` headers to `pic.openpic.in` — it interferes with Workers Cache storage (media doc §29).
- `403` means expired or invalid signature → call §5.6 to refresh, then retry **once**. Do not retry-loop on `403`.
- `404` means the object is genuinely absent (purged or never generated).
- `410` on a purged gallery path.
- Always set `loading="lazy"`; virtualize grids above ~500 items.
- Two different signed URLs for the same image resolve to the **same** cached object — the Worker strips `exp`/`sig` from the cache key (media doc §13). Clients must not treat the URL as an identity; `imageId` + `contentHash` are the identity.

---

# Part 6 — Attendee (public) surface

Namespace `/api/v1/p/**`. Auth is `attendee` (anonymous session or logged-in user) unless stated. Every route is scoped by the event's **active** access-link `slug`, resolved through the unique partial index on `accessLinks.slug` where `active: true`.

## 6.1 Public event resolution

### `GET /api/v1/p/events/{slug}`

Auth `public` · Rate `public.gallery` · `Cache-Control: private, max-age=30`

The attendee landing page. Must render fully from this one call.

```json
{
  "slug": "k7m2xq9p",
  "event": {
    "id": "6702ff...",
    "name": "Rahul & Priya's Wedding",
    "startAt": "...",
    "endAt": "...",
    "displayTimeZone": "Asia/Kolkata",
    "startAtLocal": "2026-11-14T17:30:00+05:30",
    "logoUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
    "organizerDisplayName": "Rahul Studio",
    "status": "live"
  },
  "gallery": {
    "open": true,
    "expiresAt": "2027-02-14T18:00:00.000Z",
    "imageCount": 4120,
    "indexingComplete": true
  },
  "selfie": {
    "acceptedMimeTypes": ["image/jpeg", "image/png", "image/webp", "image/heic"],
    "maxBytes": 10485760,
    "livenessRequired": true,
    "attemptsAllowed": 3,
    "attemptsUsed": 0
  },
  "consent": {
    "required": true,
    "purpose": "biometric_processing",
    "policyVersion": "biometric-2026-03",
    "policyUrl": "https://openpic.in/legal/biometric/2026-03",
    "granted": false
  },
  "session": { "kind": "anonymous", "hasProfile": false, "canClaimByLogin": true }
}
```

Error states the frontend must handle:

| Condition                 | Response                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Unknown slug              | `404 not_found`                                                                                                               |
| Slug revoked by rotation  | `410 access_link_revoked` with `details.message` ("This QR code is no longer valid. Ask the organizer for the current link.") |
| Event `draft`             | `404 not_found` (do not leak unpublished events)                                                                              |
| Event `deleting` / purged | `410 event_gone`                                                                                                              |
| Gallery retention elapsed | `200` with `gallery.open: false`, `gallery.expiredAt` set                                                                     |

`startAtLocal` is pre-rendered in `displayTimeZone` so the attendee page needs no timezone library (schema §15.1 — the timezone is a display preference, stored separately from the UTC instant).

## 6.2 Consent

**Consent is a hard precondition for selfie processing.** No selfie endpoint may be reached without it.

### `POST /api/v1/p/events/{slug}/consent`

Auth `attendee` · Rate `write.normal`

```json
{ "purpose": "biometric_processing", "policyVersion": "biometric-2026-03", "granted": true }
```

Writes a `consents` row with `policyVersion`, `policyDocumentHash`, `grantedAt`, and `evidence { ipHash, uaHash, method: "checkbox", locale }` — the fields that make consent _demonstrable_ years later (schema §15.4).

`201` →

```json
{
  "consentId": "6706aa...",
  "purpose": "biometric_processing",
  "policyVersion": "biometric-2026-03",
  "grantedAt": "...",
  "receiptSent": false,
  "receiptNote": "A consent receipt is emailed only to signed-in attendees."
}
```

Emits `attendee.consent.receipt` (**email only**, notification §4.8) — skipped for anonymous attendees, who have no verified contact; the `consents` row still exists either way.

`422 policy_version_stale` if `policyVersion` ≠ the current one; `details.currentPolicyVersion` + `policyUrl` let the client re-render and retry.

### `DELETE /api/v1/p/events/{slug}/consent`

Withdraws consent. Sets `consents.withdrawnAt`, sets `attendeeEventProfiles.status = "withdrawn"`, and **deletes the selfie, its embedding and all `faceMatches` for this profile** (this is a data-subject-initiated deletion, permitted and required). `204`.

Response header `X-Deleted-Counts: selfies=1;embeddings=1;matches=1904` for the client's confirmation copy; the same counts are recorded in `dataSubjectRequests.executionLog` if a DSR is open.

## 6.3 Liveness & selfie

### `POST /api/v1/p/events/{slug}/liveness/challenges`

Auth `attendee` · Rate `liveness.challenge` · Precondition: consent granted

`201` →

```json
{
  "challengeId": "6706bb...",
  "challengeKind": "gesture",
  "spec": { "sequence": ["look_left", "blink", "look_center"], "timeoutMs": 15000 },
  "expiresAt": "2026-09-25T09:20:00.000Z"
}
```

`412 consent_required` with `details.requiredPolicyVersion` if consent is missing.

### `POST /api/v1/p/events/{slug}/selfies/uploads`

Auth `attendee` · Rate `selfie.submit`

`{ "hash": "b4c7e9...", "size": 2140000, "mimeType": "image/jpeg" }`

`201` → same presign envelope as §5.3 (`method`, `url`, `headers`, `expiresAt`, `confirmUrl`). Selfies are always single-PUT.

### `POST /api/v1/p/events/{slug}/selfies`

Auth `attendee` · **Idempotency required** · Rate `selfie.submit` · Entitlements `selfies.per_attendee`

```json
{
  "uploadSessionId": "6706cc...",
  "hash": "b4c7e9...",
  "challengeId": "6706bb...",
  "livenessFrameHashes": ["...", "...", "..."]
}
```

Server: verifies the object, verifies the liveness challenge is unexpired and unused, creates/updates `attendeeEventProfiles` (creating with `subject.kind: "anonymous"` or `"user"`), inserts `selfies` with `processing.status: "queued"`, `processing.priority: "high"` (PRD: attendee selfies are high priority), enqueues to `q:selfie`.

`202` →

```json
{
  "selfieId": "6706dd...",
  "profileId": "6706ee...",
  "status": "processing",
  "pollUrl": "/api/v1/p/events/k7m2xq9p/me",
  "pollIntervalMs": 2000,
  "attemptsUsed": 1,
  "attemptsRemaining": 2
}
```

Failure paths:

| Condition                         | Response                                                             |
| --------------------------------- | -------------------------------------------------------------------- |
| Consent missing                   | `412 consent_required`                                               |
| Liveness challenge expired/reused | `409 liveness_challenge_invalid`                                     |
| Selfie attempts exhausted         | `403 plan_limit_exceeded` (`entitlementKey: "selfies.per_attendee"`) |
| Upload window / gallery closed    | `409 gallery_closed`                                                 |
| File too large                    | `413 file_too_large`                                                 |

The **outcome** of detection/liveness is asynchronous (`attendee.selfie.accepted` / `attendee.selfie.rejected`, notification §4.8) and observed through §6.4. `attendee.selfie.rejected` emails only when the attendee is identified **and** has failed twice consecutively.

### `GET /api/v1/p/selfies/reusable`

Auth `user` (identified only) — the PRD's "reuse a previous selfie".

```json
{
  "data": [
    {
      "selfieId": "6706dd...",
      "createdAt": "...",
      "previewUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
      "quality": { "accepted": true }
    }
  ]
}
```

Returns **crops/previews only**, never the embedding. Reuse: `POST /p/events/{slug}/selfies:reuse` with `{ "selfieId": "..." }` → `202`, same envelope as above, skipping upload and liveness.

## 6.4 Participation status (polling)

### `GET /api/v1/p/events/{slug}/me`

Auth `attendee` · Rate `read.hot` · `Cache-Control: no-store`

**The single polling endpoint for the whole attendee experience**, including anonymous attendees who are deliberately unreachable by notifications (notification §2).

```json
{
  "profileId": "6706ee...",
  "subject": { "kind": "anonymous", "canClaimByLogin": true },
  "status": "ready",
  "statusDetail": null,
  "selfie": {
    "id": "6706dd...",
    "accepted": true,
    "previewUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
    "liveness": { "required": true, "passed": true },
    "quality": { "accepted": true, "rejectionReason": null },
    "attemptsUsed": 1,
    "attemptsRemaining": 2
  },
  "matchCount": 38,
  "newMatchCount": 12,
  "lastMatchRunAt": "2026-09-25T09:18:00.000Z",
  "indexingComplete": true,
  "galleryUrl": "/e/k7m2xq9p/gallery",
  "galleryExpiresAt": "2027-02-14T18:00:00.000Z",
  "pollIntervalMs": 15000,
  "nextPollAfter": "2026-09-25T09:19:00.000Z"
}
```

`status` ∈ `no_selfie` | `selfie_pending` | `processing` | `ready` | `no_match` | `failed` | `withdrawn`.

`statusDetail` is populated on `failed`/`no_match`:

```json
{
  "code": "no_face_detected",
  "message": "We couldn't find a face in your photo.",
  "remedy": "Try a photo taken in better light, facing the camera.",
  "canRetry": true
}
```

**Adaptive polling is server-driven.** The client must honour `pollIntervalMs`: `2000` while `processing`, `15000` while `ready` and the event is still indexing, `60000` once `indexingComplete`. This is how the attendee page stays live without a realtime transport.

`matchCount` is the cached `attendeeEventProfiles.matchCount` (`$inc`'d on match insert) — no count query per poll. `newMatchCount` is matches with `createdAt > lastSeenGalleryAt`.

## 6.5 Gallery

### `GET /api/v1/p/events/{slug}/gallery?cursor=&limit=`

Auth `attendee` + owns the profile · Sorted `createdAt` desc, **newest first** (PRD) · Default `limit` 40, max 100

```json
{
  "data": [
    {
      "matchId": "6707aa...",
      "imageId": "6704aa...",
      "thumbnailUrl": "https://pic.openpic.in/t/e3b0c442....webp?exp=1790086400&sig=...",
      "thumbnailUrlExpiresAt": "2026-09-26T09:00:00.000Z",
      "width": 4000,
      "height": 6000,
      "orientation": 1,
      "aspectRatio": 0.6667,
      "isNew": true,
      "confidence": "strong",
      "originalAvailable": true,
      "createdAt": "2026-09-25T09:18:00.000Z"
    }
  ],
  "page": { "nextCursor": "...", "hasMore": true, "limit": 40, "total": 38 },
  "summary": {
    "matchCount": 38,
    "newMatchCount": 12,
    "hiddenCount": 1,
    "galleryExpiresAt": "2027-02-14T18:00:00.000Z",
    "indexingComplete": true
  }
}
```

Contract rules:

- `width`/`height`/`orientation`/`aspectRatio` are **mandatory** on every item so the grid reserves correct space before load — the PRD's "correct orientation, layout and padding" with zero layout shift (schema §25).
- `isNew = createdAt > attendeeEventProfiles.lastSeenGalleryAt` — drives the "New" badge.
- `similarity` (the raw cosine) is **never** returned to attendees. Only the coarse `confidence` ∈ `strong` | `normal`. Exposing a score invites "why is this only 0.41?" and leaks model characteristics.
- `hiddenAt != null` matches are excluded from `data` and counted in `summary.hiddenCount`.
- `page.total` is the cached `matchCount` and is labelled approximate in the DTO docs.
- `410 gallery_expired` once `retentionExpiresAt` has passed and the purge has run.

### `POST /api/v1/p/events/{slug}/gallery:seen`

Auth `attendee` · `{ "seenAt": "2026-09-25T09:20:00.000Z" }` (optional; defaults to now)

Sets `attendeeEventProfiles.lastSeenGalleryAt` and stamps `faceMatches.seenAt` for unseen rows. `204`. This is what dismisses the "New" badge; it must be a separate explicit call, not a side effect of `GET`, so a prefetch never clears the badge.

### `POST /api/v1/p/matches/{matchId}/hide` · `.../unhide`

Auth `attendee` + owns the profile

Sets/clears `faceMatches.hiddenAt`. **Never deletes the row** — a false positive is a model-quality signal, and deleting it would make the next incremental match run re-insert it (schema §17.5). `204`.

Optional body `{ "reason": "not_me" | "poor_quality" | "other" }` feeds abuse/quality review.

## 6.6 Originals & downloads

### `POST /api/v1/p/events/{slug}/images/{imageId}/original-url`

Auth `attendee` + has a match for `imageId` · Rate `media.sign`

`201` → `{ "url": "https://pic.openpic.in/o/....jpg?exp=...&sig=...", "expiresAt": "...", "ttlSeconds": 900 }`

Originals are **never** included in gallery list responses (media doc §43) — they are requested only on explicit user action, with a 15-minute token.

`403 feature_not_available` if the event's active plan does not grant attendee original access.

### `POST /api/v1/p/events/{slug}/downloads`

Auth `attendee` · **Idempotency required**

`{ "scope": "all_matches" | "selected", "matchIds": ["..."], "quality": "original" | "thumbnail" }`

`202` → `{ "downloadId": "6708aa...", "status": "queued", "pollUrl": "/api/v1/p/downloads/6708aa...", "pollIntervalMs": 3000 }`

### `GET /api/v1/p/downloads/{downloadId}`

Auth `attendee` + owner

```json
{
  "downloadId": "6708aa...",
  "status": "ready",
  "fileCount": 38,
  "bytes": 412000000,
  "url": "https://pic.openpic.in/o/....zip?exp=...&sig=...",
  "expiresAt": "2026-09-25T10:30:00.000Z",
  "downloadsRemaining": 3,
  "createdAt": "..."
}
```

`status` ∈ `queued` | `building` | `ready` | `failed` | `expired`. Emits `attendee.download.ready` (short-lived signed link, capped download count). `410 download_expired` after expiry — the client re-requests.

## 6.7 Claiming & "my events"

### `POST /api/v1/me/attendee-sessions:claim`

Auth `user` · Body `{ "sessionToken": "opat_9f2c..." }` (or omitted, reading the `op_att` cookie)

The PRD's _"she doesn't have to re-visit and re-upload"_. Re-points every `attendeeEventProfiles` row from `subject.kind: "anonymous"` to `subject.kind: "user"` in a **single atomic update per profile** (schema §15.3). **No data moves. No selfie re-upload. No reprocessing.**

`200` →

```json
{
  "claimed": [
    {
      "eventId": "6702ff...",
      "eventName": "Rahul & Priya's Wedding",
      "profileId": "6706ee...",
      "matchCount": 38,
      "galleryUrl": "/e/k7m2xq9p/gallery"
    }
  ],
  "skipped": [{ "eventId": "...", "reason": "already_claimed_by_this_user" }]
}
```

Emits `attendee.event.linked` per claimed event (in-app only — confirms "the event is saved to my account"). Also clears the `op_att` cookie.

`409 session_claimed_by_other_user` if `claimedByUserId` is already set to a different user. `401 attendee_session_expired` past the 30-day TTL.

### `GET /api/v1/me/events?cursor=&limit=`

Auth `user` · **The single whitelisted cross-tenant read** (schema §10.3)

Queries `attendeeEventProfiles` by `subject.userId` **across tenants**, using index `{"subject.userId":1, updatedAt:-1}`. Must be implemented in **one** whitelisted repository function with an explicit test asserting it can only ever return rows whose `subject.userId` equals the caller.

```json
{
  "data": [
    {
      "eventId": "6702ff...",
      "eventName": "Rahul & Priya's Wedding",
      "organizerDisplayName": "Rahul Studio",
      "startAt": "...",
      "displayTimeZone": "Asia/Kolkata",
      "slug": "k7m2xq9p",
      "galleryUrl": "/e/k7m2xq9p/gallery",
      "coverThumbnailUrl": "https://pic.openpic.in/t/....webp?exp=...&sig=...",
      "matchCount": 38,
      "newMatchCount": 12,
      "status": "ready",
      "galleryExpiresAt": "2027-02-14T18:00:00.000Z",
      "expiringSoon": false
    }
  ],
  "page": { "nextCursor": null, "hasMore": false, "limit": 40 }
}
```

`expiringSoon` is `true` within 7 days of `galleryExpiresAt`, mirroring `attendee.gallery.expiring` (T-7d, T-1d; mobile at T-1d only; **not opt-outable**, because after purge the photos are gone).

---

# Part 7 — Notifications

Implements notification design Parts I and §19. **Novu holds no routing, no templates, no preferences, no digests** (notification §8) — all of it is served and enforced here.

## 7.1 In-app feed

### `GET /api/v1/me/notifications?cursor=&limit=&filter=&category=&eventId=&window=`

Auth `user` · Rate `read.normal` · Sorted `createdAt` desc (index `{userId:1, createdAt:-1}`)

| Param      | Default               | Notes                                                                                                                                       |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `limit`    | `20`                  | max `50`                                                                                                                                    |
| `filter`   | `active`              | `active` (last 30 days) \| `unread` \| `all` (last 90 days) \| `archived` (30–90 days)                                                      |
| `category` | —                     | repeatable: `authentication`, `account`, `billing`, `usage`, `event`, `collaboration`, `pipeline`, `matching`, `compliance`, `platform_ops` |
| `eventId`  | —                     | scope to one event                                                                                                                          |
| `window`   | derived from `filter` | never exceeds 90 days (the TTL horizon)                                                                                                     |

```json
{
  "data": [
    {
      "id": "6709aa...",
      "typeKey": "attendee.matches.new",
      "category": "matching",
      "severity": "informational",
      "title": "38 new photos of you",
      "body": "New matches found in Rahul & Priya's Wedding.",
      "data": {
        "eventId": "6702ff...",
        "link": "/e/k7m2xq9p/gallery",
        "count": 38,
        "latestImageId": "6704aa..."
      },
      "groupKey": "6702ff...",
      "groupCount": 38,
      "actionTarget": null,
      "actions": [],
      "readAt": null,
      "eventId": "6702ff...",
      "tenantId": null,
      "createdAt": "2026-09-25T09:18:00.000Z",
      "updatedAt": "2026-09-25T09:41:00.000Z"
    },
    {
      "id": "6709bb...",
      "typeKey": "collab.invite.sent",
      "category": "collaboration",
      "severity": "important",
      "title": "Rahul invited you to co-organize",
      "body": "Rahul & Priya's Wedding · expires in 13 days",
      "data": {
        "eventId": "6702ff...",
        "invitationId": "6703bb...",
        "link": "/invitations/6703bb..."
      },
      "groupKey": null,
      "groupCount": 1,
      "actionTarget": { "kind": "invitation", "id": "6703bb...", "state": "open" },
      "actions": [
        { "key": "accept", "label": "Accept", "style": "primary", "state": "available" },
        { "key": "reject", "label": "Decline", "style": "secondary", "state": "available" }
      ],
      "actionResolvedVia": null,
      "actionResolvedAt": null,
      "readAt": null,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "page": { "nextCursor": "...", "hasMore": true, "limit": 20 },
  "summary": {
    "unreadCount": 3,
    "unreadByCategory": { "matching": 1, "collaboration": 1, "billing": 1 }
  }
}
```

Non-negotiable client rules:

1. **`title` and `body` are pre-rendered at write time** and must be displayed verbatim (notification §19.4). The client must **not** re-render from `typeKey` + `data`. A notification says what it said when it was sent, even if the template has since changed.
2. **`groupCount` is a live rolling counter**, not a history. `attendee.matches.new` upserts into the _same_ document while `readAt == null`; once read, the next arrival starts a fresh row. Clients must render `groupCount` and re-sort on `updatedAt`, not assume one row = one occurrence.
3. **`actions[].state`** is a denormalised convenience and **may be briefly stale**. Always POST the action (§7.3) and trust the response; never block on the cached state. Render `state: "unavailable"` as a disabled button, not a hidden one — the user needs to see that the decision was made.
4. **Unknown `typeKey`/`category`/`severity` values must render generically** using `title`/`body`/`severity` fallback. New types ship without a client deploy.
5. OTP notifications are **never present in this feed** by design (`in_app: false`, notification rule 6). A client that special-cases OTP rendering here is wrong.

### `POST /api/v1/me/notifications/{id}/read` → `204` (idempotent)

### `POST /api/v1/me/notifications/read-all`

Body `{ "before": "2026-09-25T09:00:00.000Z", "category": "matching", "eventId": "..." }` — all optional, all AND-ed. `200` → `{ "markedCount": 12, "unreadCount": 0 }`.

### `DELETE /api/v1/me/notifications/{id}` → `204`. Removes the row from the caller's feed only. Does **not** affect `notificationDispatches` (the audit ledger is independent).

## 7.2 Unread count (hot path)

### `GET /api/v1/me/notifications/unread-count`

Auth `user` · Rate `read.hot` · **Polled every 30 s** · Supports `ETag`/`If-None-Match` → `304`

```json
{
  "unreadCount": 3,
  "byCategory": { "matching": 1, "collaboration": 1, "billing": 1 },
  "highestSeverity": "important",
  "pollIntervalSeconds": 30,
  "serverTime": "2026-09-25T09:42:00.000Z"
}
```

```http
Cache-Control: no-store
ETag: "3-important-1790086920"
```

Implementation contract:

- `countDocuments` against the **partial** index `idx_user_unread` (`{userId:1, createdAt:-1}` where `readAt: null`) — the partial predicate keeps the index proportional to unread rows, which is why this is cheap enough to poll (schema §21).
- `pollIntervalSeconds` comes from `platformSettings.notifications.pollIntervalSeconds`; the client **must** honour it so cadence is tunable without a deploy.
- Clients **must** pause polling when `document.visibilityState !== "visible"`.
- Clients **should** send `If-None-Match` and treat `304` as "no change" (no re-render).
- `highestSeverity` lets the bell show a red dot vs. a grey dot without fetching the list.

> A future realtime transport (SSE/Pusher) changes only _how the client learns to refetch_. This endpoint, the feed endpoint, the collection and the indexes stay identical (notification §19.4). Do not design around WebSockets.

## 7.3 Notification actions

### `POST /api/v1/me/notifications/{id}/actions/{actionKey}`

Auth `user` · Rate `write.normal`

Body: action-specific, usually `{}`.

**This endpoint owns no state.** It resolves `actionTarget` and delegates to that entity's idempotent transition (notification §7). The notification is a _pointer_; the owning document is the source of truth.

| `actionTarget.kind` | `actionKey`            | Delegates to                                            |
| ------------------- | ---------------------- | ------------------------------------------------------- |
| `invitation`        | `accept` \| `reject`   | `POST /me/invitations/{id}/accept                       | reject` |
| `subscription`      | `pay_now`              | `POST /tenants/{t}/billing/retry-charge`                |
| `subscription`      | `complete_mandate`     | returns the stored `checkout.url`                       |
| `upload_batch`      | `retry_failed`         | `POST .../images:reprocess-failed`                      |
| `policy`            | `acknowledge`          | writes a `consents` row (`purpose: "terms_of_service"`) |
| `event`             | `extend_upload_window` | `POST .../upload-window:extend`                         |
| `selfie`            | `retry`                | returns `{ "redirectUrl": "/e/{slug}" }`                |

`200` (always, including replays) →

```json
{
  "notificationId": "6709bb...",
  "actionKey": "accept",
  "outcome": "applied",
  "alreadyResolved": false,
  "resolvedVia": "in_app",
  "targetState": "accepted",
  "actions": [
    { "key": "accept", "label": "Accept", "state": "unavailable" },
    { "key": "reject", "label": "Decline", "state": "unavailable" }
  ],
  "redirectUrl": "/events/6702ff.../images",
  "message": "You're now a co-organizer."
}
```

`outcome` ∈ `applied` | `already_resolved` | `unavailable`. **Never `409`** for a repeated action — that is the whole point of notification §7. `410` only when the target is `revoked`/`expired`, where the affordance should disappear rather than report success.

After any successful transition the server runs the `notifications.updateMany` fan-out (§2.3 rule 3), so the same decision is closed in every channel and on every device on the next poll.

## 7.4 Preferences

### `GET /api/v1/me/notification-preferences`

Auth `user`

Returns the user's stored overrides **merged with** the catalogue defaults, so the settings screen is one read (schema §19.3 — one document per user, sparse nested maps).

```json
{
  "global": { "email": "on", "mobile": "off", "in_app": "on" },
  "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timeZone": "Asia/Kolkata" },
  "digest": { "attendee.matches.new": "daily" },
  "locale": "en-IN",
  "byType": { "event.details.updated": { "email": "off" } },
  "byEvent": { "6702ff...": { "mobile": "off" } },
  "resolved": [
    {
      "category": "billing",
      "label": "Billing & subscription",
      "types": [
        {
          "typeKey": "billing.payment.failed",
          "label": "Payment failed",
          "channels": {
            "in_app": { "effective": "on", "optOutAllowed": false, "source": "transactional" },
            "email": { "effective": "on", "optOutAllowed": false, "source": "transactional" },
            "mobile": {
              "effective": "on",
              "optOutAllowed": false,
              "source": "transactional",
              "resolvesTo": "sms",
              "resolvesToReason": "whatsapp_capability_unknown"
            }
          },
          "transactional": true,
          "severity": "critical"
        }
      ]
    }
  ],
  "updatedAt": "..."
}
```

Contract rules the frontend must obey:

- `optOutAllowed: false` toggles render **locked with an explanation**, never hidden. Transactional types (security, billing, legal, erasure) cannot be opted out of (notification rule 7).
- `in_app` is **never** opt-outable for any type — it is the app's own UI, and suppressing it just hides state the user needs.
- Preferences are expressed against **channel groups**, not channels. `mobile` is the group `[whatsapp, sms]` with strategy `first_eligible`. The user's setting means "don't text me", which is what they actually mean; `resolvesTo` is informational only (notification §1.1).
- `source` ∈ `default` | `global` | `type` | `event` | `transactional`, reflecting the precedence chain: `transactional > byEvent > byType > global > catalogue default`.

### `PATCH /api/v1/me/notification-preferences`

Auth `user` · Body is a **sparse patch** — only the keys present are changed; `null` removes an override and reverts to the next-most-general scope.

```json
{
  "global": { "mobile": "off" },
  "byType": { "event.details.updated": { "email": "off" }, "event.starting_soon": null },
  "byEvent": { "6702ff...": { "mobile": "off" } },
  "quietHours": { "enabled": true, "start": "22:00", "end": "07:00", "timeZone": "Asia/Kolkata" },
  "digest": { "attendee.matches.new": "quiet_period" }
}
```

`digest` values: `instant` | `quiet_period` | `daily` | `off`.

`422 opt_out_not_allowed` with `details.typeKey` + `details.channelGroup` if the patch tries to disable a channel where `optOutAllowed == false`. `422 unknown_type_key` for an unrecognised `typeKey`. Quiet hours are `HH:MM` 24-hour strings; `severity: "critical"` notifications bypass them regardless.

`200` → the full merged document.

## 7.5 Unsubscribe & suppression

### `GET /api/v1/notifications/unsubscribe/{token}` (auth `public`)

### `POST /api/v1/notifications/unsubscribe/{token}` (auth `public`)

One-click unsubscribe from an email footer (and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers the transport adapter must set).

`{token}` is an HMAC over `{userId, typeKey?, scope}` with a 90-day expiry. `GET` previews what will be muted; `POST` applies it.

- `scope: "type"` → writes `byType.{typeKey}.email = "off"`.
- `scope: "marketing"` → sets `userProfiles.marketingOptIn = false` **and** writes a `notificationSuppressions` row with `scope: "marketing"`.
- `scope: "all"` → writes `byType` opt-outs for every `optOutAllowed: true` type. **Transactional types are unaffected and the response says so explicitly.**

`200` →

```json
{
  "applied": true,
  "scope": "type",
  "typeKey": "billing.invoice.issued",
  "stillReceiving": ["Security alerts", "Payment failures", "Legal notices"],
  "managePreferencesUrl": "https://openpic.in/settings/notifications"
}
```

`scope` in `notificationSuppressions` distinguishes "never contact" from "no marketing" precisely so an unsubscribe can never silently block an OTP (notification §19.6).

Suppressions are **first-party** (notification §19.6): a provider swap must not resurrect a hard-bounced address, and the resolver must be able to skip _before_ spending a send and record `skipReason: "suppressed"`.

## 7.6 Type catalogue (normative)

### `GET /api/v1/notification-types?category=&audience=`

Auth `user` · `Cache-Control: private, max-age=600`

Returns the catalogue as data, for building the settings UI generically. **Never hard-code this list in the frontend.**

```json
{
  "data": [
    {
      "typeKey": "attendee.matches.ready",
      "category": "matching",
      "label": "Your photos are ready",
      "description": "Sent once, the first time we find photos of you at an event.",
      "audiences": ["attendee_identified"],
      "channelGroups": [
        { "group": "in_app", "enabled": true, "optOutAllowed": false },
        { "group": "email", "enabled": true, "optOutAllowed": false },
        {
          "group": "mobile",
          "enabled": true,
          "optOutAllowed": false,
          "candidates": ["whatsapp", "sms"],
          "strategy": "first_eligible"
        }
      ],
      "transactional": true,
      "severity": "important",
      "respectQuietHours": true,
      "throttle": { "strategy": "none" },
      "dedupe": { "keyTemplate": "{typeKey}:{profileId}", "windowHours": null },
      "actionable": false,
      "enabled": true,
      "version": 3
    }
  ]
}
```

`retainBody` is **not** exposed (it governs internal dispatch storage for OTP types).

### Normative `typeKey` enumeration

These are the **only** valid `typeKey` / `eventKey` values in v1. Adding one is a `notificationTypes` insert plus templates — no code change, no API change.

<details>
<summary><strong>Full catalogue — 81 keys across 10 categories</strong> (expand)</summary>

| Category         | `typeKey`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authentication` | `auth.otp.email.requested`, `auth.otp.mobile.requested`, `auth.signin.new_device`, `auth.2fa.enabled`, `auth.2fa.disabled`, `auth.contact.changed`, `auth.account.completed`, `auth.suspicious.blocked`, `auth.admin.signin`                                                                                                                                                                                                                                                                |
| `account`        | `account.welcome`, `account.verification.incomplete`, `account.deletion.requested`, `account.deletion.completed`, `account.sessions.revoked`                                                                                                                                                                                                                                                                                                                                                |
| `billing`        | `billing.mandate.pending`, `billing.mandate.failed`, `billing.subscription.activated`, `billing.renewal.upcoming`, `billing.payment.succeeded`, `billing.payment.failed`, `billing.grace.reminder`, `billing.subscription.downgraded`, `billing.subscription.reactivated`, `billing.plan.upgraded`, `billing.plan.downgrade_scheduled`, `billing.plan.downgrade_applied`, `billing.addon.purchased`, `billing.invoice.issued`, `billing.subscription.cancelled`, `billing.refund.processed` |
| `usage`          | `usage.storage.threshold`, `usage.events.threshold`, `usage.action.blocked`, `usage.limit.restored`                                                                                                                                                                                                                                                                                                                                                                                         |
| `event`          | `event.created`, `event.details.updated`, `event.starting_soon`, `event.ended`, `event.upload_window.closing`, `event.upload_window.closed`, `event.link.rotated`, `event.archived`, `event.deleted`, `event.retention.expiring`, `event.attendee.milestone`                                                                                                                                                                                                                                |
| `collaboration`  | `collab.invite.sent`, `collab.invite.reminder`, `collab.invite.accepted`, `collab.invite.rejected`, `collab.invite.revoked`, `collab.invite.expired`, `collab.member.removed`, `collab.member.removed.ack`                                                                                                                                                                                                                                                                                  |
| `pipeline`       | `upload.batch.completed`, `upload.batch.completed_with_errors`, `upload.batch.files_rejected`, `upload.session.stalled`, `upload.blocked.quota`, `pipeline.event.indexed`, `pipeline.image.failed`, `pipeline.delayed`                                                                                                                                                                                                                                                                      |
| `matching`       | `attendee.selfie.accepted`, `attendee.selfie.rejected`, `attendee.matches.ready`, `attendee.matches.new`, `attendee.matches.none_found`, `attendee.event.linked`, `attendee.gallery.expiring`, `attendee.download.ready`, `attendee.consent.receipt`                                                                                                                                                                                                                                        |
| `compliance`     | `legal.terms.updated`, `privacy.dsr.received`, `privacy.export.ready`, `privacy.erasure.completed`                                                                                                                                                                                                                                                                                                                                                                                          |
| `platform_ops`   | `admin.invite.sent`, `admin.abuse.flagged`, `admin.queue.backlog`, `admin.provider.failing`, `admin.billing.manual_review`, `admin.dsr.sla_risk`, `admin.plan.modified`                                                                                                                                                                                                                                                                                                                     |

**Reconciliation with the design doc's "65 types":** the notification matrix collapses several rows (e.g. `auth.2fa.enabled` / `.disabled` share one row; `collab.invite.expired` fans out to two audiences from one row). Enumerating one key per distinct notification yields **81** keys. Channel routing, throttles and opt-out rules are **unchanged** — each key inherits the row it came from. The seed script is the authority; it must produce exactly these 81 `notificationTypes` documents.

</details>

Channel routing for every key is **not** duplicated here — it lives in `notificationTypes.channelGroups`, seeded from notification §4, and is served by `GET /api/v1/notification-types`. Duplicating it in a second place would reintroduce exactly the drift that §8 eliminates.

## 7.7 Domain event contract

Every notification originates from a `domainEvents` row. The invariant that makes this work:

> **`domainEvents.eventKey` === `notificationTypes.typeKey`** for every event that produces a notification.

The fan-out worker looks up `notificationTypes.findOne({ typeKey: ev.eventKey, enabled: true })` (schema §25). An event with no matching type row simply produces no notification — which is how analytics-only events (`event.viewed`, etc.) coexist.

Emitting is **always** via `emitDomainEvent()`, never by calling the notification service directly. Business code calls it once; notifications, analytics and queue publishing are independent consumers with independent `dispatch.*` flags, so a notification failure cannot block the analytics rollup (schema §18.3).

```ts
await emitDomainEvent({
  eventKey: "collab.invite.accepted",
  tenantId,
  actorRef: { kind: "user", id: userId },
  subjectRef: { kind: "invitation", id: inviteId },
  payload: { inviteId, eventId, eventName, inviteeUserId, role },
});
```

`payload` rules: **minimal and resolvable**. Include identifiers plus the few denormalised fields templates need (`eventName`, `count`). **Never** include contact details, tokens, OTP codes, vectors, or anything that would be wrong if read 6 hours later from a digest bucket.

---

# Part 8 — Compliance

## 8.1 Data subject requests

### `POST /api/v1/me/data-requests`

Auth `user` **or** `attendee` · **Idempotency required** · Rate 5 / day / principal

```json
{
  "requestType": "erasure",
  "regulation": "dpdpa",
  "scope": { "eventIds": ["6702ff..."] },
  "verifiedEmail": "rahul@example.com",
  "note": "Please remove my face data."
}
```

`requestType` ∈ `access` | `erasure` | `rectification` | `portability` | `consent_withdrawal`.
`regulation` ∈ `gdpr` | `dpdpa` (defaults from `tenants.dataRegion` / caller geo).
Omitting `scope` means "all of my data, everywhere".

`202` →

```json
{
  "id": "670aaa...",
  "requestType": "erasure",
  "status": "received",
  "slaDueAt": "2026-10-25T00:00:00.000Z",
  "acknowledgement": "We've received your request and will complete it by 25 October 2026.",
  "pollUrl": "/api/v1/me/data-requests/670aaa..."
}
```

Emits `privacy.dsr.received` — the statutory acknowledgement, carrying the SLA date. `admin.dsr.sla_risk` fires when within 48 h of the deadline.

### `GET /api/v1/me/data-requests` · `GET /api/v1/me/data-requests/{id}`

```json
{
  "id": "670aaa...",
  "requestType": "erasure",
  "regulation": "dpdpa",
  "status": "completed",
  "slaDueAt": "...",
  "completedAt": "...",
  "executionLog": [
    { "step": "faceEmbeddings.deleted", "count": 412, "at": "..." },
    { "step": "faceMatches.deleted", "count": 1904, "at": "..." },
    { "step": "selfies.deleted", "count": 3, "at": "..." },
    { "step": "storageObjects.deleted", "count": 3, "at": "..." }
  ],
  "export": null
}
```

**`executionLog` is what turns "we deleted your data" into evidence** (schema §20.3). Because vectors live only on `imageFaces` and `selfies`, and both carry `tenantId` + `eventId` + subject refs, erasure is a bounded, countable sequence of `deleteMany` calls whose counts are recorded — not a scavenger hunt. The API must expose these counts to the data subject.

For `access`/`portability`, `export` carries a short-lived signed link with a capped download count:

```json
{
  "export": {
    "url": "https://pic.openpic.in/o/....zip?exp=...&sig=...",
    "expiresAt": "...",
    "downloadsRemaining": 3,
    "bytes": 8410000,
    "format": "json+media"
  }
}
```

Emits `privacy.export.ready`. Completion of an erasure emits `privacy.erasure.completed` (**email only** — in-app may no longer exist).

## 8.2 Consent history & policy acknowledgement

### `GET /api/v1/me/consents?purpose=`

Auth `user` — `[{ id, purpose, policyVersion, policyUrl, grantedAt, withdrawnAt, eventId, method }]`. `policyDocumentHash` is included so the record is verifiable years later.

### `GET /api/v1/legal/policies/current`

Auth `public` · `Cache-Control: public, max-age=3600`

```json
{
  "policies": [
    {
      "purpose": "terms_of_service",
      "version": "tos-2026-03",
      "url": "...",
      "effectiveFrom": "...",
      "documentHash": "sha256:..."
    },
    {
      "purpose": "biometric_processing",
      "version": "biometric-2026-03",
      "url": "...",
      "effectiveFrom": "...",
      "documentHash": "sha256:..."
    }
  ]
}
```

### `POST /api/v1/me/consents/acknowledge`

Auth `user` · `{ "purpose": "terms_of_service", "policyVersion": "tos-2026-03" }` → `201`. This is the action target of the `legal.terms.updated` in-app notification, which carries an acknowledge action that writes a `consents` row.

---

# Part 9 — Admin

## 9.1 Admin conventions

- Namespace `/api/v1/admin/**`. Auth `admin` (platform role **and** 2FA) on every route, no exceptions.
- **Every** `POST`/`PATCH`/`DELETE` writes an `auditLogs` row with `actor{kind:"admin", id, ipHash, uaHash}`, `action`, `target{kind,id}`, `before`, `after`, `reason`. A `reason` string is **required** in the body of any destructive or financially material admin mutation → `422 reason_required`.
- Admin endpoints may read across tenants. They may **never** return face vectors (§0.15).
- Impersonation (via Better Auth admin plugin) is audited, time-boxed (≤30 min), and forbidden for billing mutations.
- Privileged-access transparency: `admin.invite.sent` notifies the invitee **and** all other admins; `admin.plan.modified` notifies **other** admins — pricing changes must never be invisible.

## 9.2 Tenants & users

| Method & path                                       | Purpose                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/tenants?q=&status=&planKey=&cursor=`    | Cross-tenant search. Returns `counters`, `activePlanKey`, `subscriptionStatus`.                                                             |
| `GET /admin/tenants/{tenantId}`                     | Full tenant detail incl. subscription, grants, recent transactions, recent audit rows.                                                      |
| `PATCH /admin/tenants/{tenantId}`                   | `status` (`active`/`suspended`/`closed`), `name`, `billingContactUserId`. **Requires `reason`.**                                            |
| `GET /admin/users?q=&platformRole=&status=&cursor=` |                                                                                                                                             |
| `GET /admin/users/{userId}`                         | Profile, tenants, events, DSRs, recent dispatches. Contacts **unmasked** for admins (support necessity), and that access is itself audited. |
| `POST /admin/users/{userId}/ban`                    | `{ reason, expiresAt? }`. Better Auth admin plugin.                                                                                         |
| `POST /admin/users/{userId}/unban`                  |                                                                                                                                             |
| `POST /admin/invitations`                           | `{ "kind": "platform_admin", "invitee": {...} }`. Emits `admin.invite.sent`.                                                                |

> **`tenants.status` is not `subscriptions.status`.** Suspension is an abuse response and blocks the tenant; downgrade is a billing state and merely limits it. Conflating them is how non-payers get treated as abusers (schema §13.3). Admin UI must present them as separate controls.

## 9.3 Plans

| Method & path                                              | Purpose                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/plans?includeInactive=true`                    | Full plan docs incl. `prices[].externalRefs`                                                                                                                                                                       |
| `POST /admin/plans`                                        | Create. `version: 1`.                                                                                                                                                                                              |
| `PATCH /admin/plans/{key}`                                 | **`If-Match` required.** Bumps `version` when `entitlements` change. Requires `reason`. Emits `admin.plan.modified` to other admins.                                                                               |
| `POST /admin/plans/{key}/prices`                           | Append a price. Adding yearly billing = one array push, zero schema change.                                                                                                                                        |
| `PATCH /admin/plans/{key}/prices/{priceKey}`               | `active`, `validUntil` only. **Amounts are immutable** — a price change is a new `priceKey` → `422 price_amount_immutable`.                                                                                        |
| `POST /admin/tenants/{tenantId}/entitlement-grants`        | Manual top-up / promo / negotiated override. Body `{ entitlementKey, delta, overrideLimit?, validFrom, validUntil?, source: { kind: "manual"\|"promo", note }, reason }`. **Additive row, never a plan mutation.** |
| `DELETE /admin/tenants/{tenantId}/entitlement-grants/{id}` | Sets `validUntil = now`. Never hard-deletes.                                                                                                                                                                       |

**Plans are never deleted** (`422 plan_deletion_forbidden`) — live subscriptions and historical invoices point at them. Retirement is `active: false` (grandfathering: active-for-existing, hidden-for-new).

## 9.4 Notification catalogue & templates

This is the admin surface over **the single source of truth for routing** (notification §8).

| Method & path                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/notification-types`                               | All 81 rows, unfiltered                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /admin/notification-types/{typeKey}`                   | **`If-Match` required.** Editable: `channelGroups[].enabled`, `channelGroups[].optOutAllowed`, `severity`, `respectQuietHours`, `throttle`, `dedupe`, `enabled`. **Not editable:** `typeKey`, `category`, `audiences` (audience is a validation guard — changing it would let an attendee-only type route to a platform admin). Bumps `version`, sets `updatedByUserId`, requires `reason`. |
| `GET /admin/notification-types/{typeKey}/impact`              | Before-and-after: estimated recipients per channel per day, and how many users have an explicit override. Mandatory read before a routing change.                                                                                                                                                                                                                                           |
| `GET /admin/notification-templates?typeKey=&channel=&locale=` |                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST` / `PATCH /admin/notification-templates/{id}`           | **`If-Match` required.** Bumps `version`. `variables[]` is validated against the template body at save time → `422 template_variable_mismatch` (this is what prevents an email that says "Hi {{firstName}}").                                                                                                                                                                               |
| `POST /admin/notification-templates/{id}/preview`             | `{ "sampleData": {...}, "locale": "en-IN" }` → rendered `subject`/`html`/`text`. No send.                                                                                                                                                                                                                                                                                                   |
| `POST /admin/notification-templates/{id}/test-send`           | `{ "toUserId": "..." }`. Sends to an **admin's own** verified contact only → `422 test_send_self_only` otherwise. Writes a dispatch with `typeKey` suffixed `.test`.                                                                                                                                                                                                                        |
| `GET /admin/transport/health`                                 | Adapter reachability + the CI drift assertion result (notification §8.3): exactly three pass-through workflows, one step each, channel matching the name. A failure here should already have raised `admin.provider.failing`.                                                                                                                                                               |

**Guard that must be enforced in CI, not just here** (notification §8.3): fetch all transport workflows and fail the build unless the set is exactly `{transport-email, transport-sms, transport-whatsapp}`, each with exactly one step whose active channel matches its name. A dashboard edit turns the build red instead of silently changing production.

## 9.5 Deliverability forensics

### `GET /admin/notification-dispatches?userId=&typeKey=&channel=&status=&skipReason=&eventId=&from=&to=&cursor=`

Auth `admin`

**The answer to "why didn't my co-organizer get the invite?", from MongoDB alone, without opening a provider dashboard** (notification §5). This endpoint is the entire justification for persisting skips.

```json
{
  "data": [
    {
      "id": "670bbb...",
      "userId": "...",
      "typeKey": "collab.invite.sent",
      "channelGroup": "mobile",
      "channel": "sms",
      "status": "skipped",
      "skipReason": "no_verified_contact",
      "contactHashPrefix": "a3f9e1",
      "templateVersion": 4,
      "dedupeKey": "collab.invite.sent:6703bb",
      "providerRef": null,
      "attempts": 0,
      "lastError": null,
      "queuedAt": "...",
      "sentAt": null,
      "deliveredAt": null,
      "failedAt": null,
      "notificationId": null,
      "eventId": "6702ff..."
    }
  ],
  "page": { "nextCursor": "...", "hasMore": false, "limit": 40 }
}
```

- `status` ∈ `queued` | `sent` | `delivered` | `failed` | `skipped` | `bounced` — **normalised by the adapter**, never a vendor string.
- `skipReason` ∈ `user_opt_out` | `no_verified_contact` | `suppressed` | `throttled` | `deduped` | `type_disabled` | `quiet_hours_deferred`.
- `channelGroup` + `channel` together prove WhatsApp-vs-SMS fallback behaviour after phase 2.
- `contactHashPrefix` is the first 6 chars of `contactHash` — enough to correlate "did we ever reach this address?", not enough to make the log a harvestable contact list.
- `retainBody: false` types (OTP) have **no body stored here, ever**. The endpoint must not invent one.

### `GET /admin/notification-dispatches/summary?from=&to=&groupBy=typeKey|channel|skipReason`

Deliverability analytics from index `{typeKey:1, channel:1, queuedAt:-1}`: sent/delivered/bounce/skip rates.

### `GET /admin/notification-suppressions?channel=&reason=&cursor=` · `DELETE /admin/notification-suppressions/{id}`

Deleting requires `reason` and is audited. Deleting a `hard_bounce` suppression is permitted but flagged in the response as `{ "warning": "Re-sending to a hard-bounced address damages sender reputation." }`.

### `POST /admin/notifications:resend`

`{ "dispatchId": "...", "reason": "..." }` → re-renders and re-dispatches. Creates a **new** dispatch row (the ledger is append-only) linked via `originalDispatchId`. Rate-limited 20 / hour / admin.

## 9.6 Queue & pipeline health

### `GET /admin/pipeline/health`

Auth `admin` · Poll 30 s

```json
{
  "queues": [
    {
      "queueKey": "selfie",
      "priority": "high",
      "depth": 4,
      "oldestAgeSeconds": 3,
      "provider": "upstash"
    },
    {
      "queueKey": "image",
      "priority": "normal",
      "depth": 4120,
      "oldestAgeSeconds": 840,
      "provider": "upstash"
    }
  ],
  "workers": [
    {
      "workerId": "w-3f2a",
      "lastHeartbeatAt": "...",
      "inFlight": 8,
      "throughputPerMin": 220,
      "status": "healthy"
    }
  ],
  "work": { "queued": 4124, "processing": 8, "failedLast24h": 12, "deadLettered": 2 },
  "leases": { "expiredAwaitingSweep": 0, "lastSweepAt": "..." },
  "sla": {
    "breached": false,
    "p95ProcessingMs": 3400,
    "backlogWarnDepth": 5000,
    "backlogWarnAgeMinutes": 15
  },
  "vectorSearch": {
    "activeSpaceKey": "arcface_r100_512",
    "indexName": "imageFaces_vec_arcface_r100_512",
    "indexedFaceCount": 14820411,
    "status": "READY",
    "exactSearch": true
  }
}
```

Breaches emit `admin.queue.backlog` (1/30 min while firing; mobile at sev-1) — serving the PRD's "worker must never idle / must keep up".

### `POST /admin/pipeline/requeue`

`{ "scope": "event"|"dead_letter"|"stalled", "eventId": "...", "limit": 1000, "reason": "..." }` → `202` `{ "requeuedCount": 412 }`.

### `GET /admin/face-models` · `POST` · `PATCH /{modelKey}`

Registry CRUD (schema §17.2). `PATCH` may set `status` ∈ `active` | `shadow` | `retired` and adjust `thresholds`. **Changing a threshold must never require an index rebuild** — thresholds are applied in the aggregation pipeline, not baked into the index.

### `POST /admin/face-models/{modelKey}/promote`

`{ "confirmSpaceKey": "arcface_r100_512_v2", "reason": "..." }` — flips `platformSettings.face.activeSpaceKey`. **This single field is the entire production switch for a model swap** (schema §17.2). Requires that the new space's backfill coverage be ≥99.9 % → `409 backfill_incomplete` with `details.coveragePercent` otherwise.

## 9.7 Billing operations

| Method & path                                                          | Purpose                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/subscriptions?status=&planKey=&graceEndingBefore=&cursor=` | Dunning cohort view                                                                                                                                                                                                                                                          |
| `POST /admin/subscriptions`                                            | Manual/Enterprise subscription. `paymentMethodKind: "invoice"\|"manual"`, no `externalRefs`. Already supported by the schema with no changes.                                                                                                                                |
| `PATCH /admin/subscriptions/{id}`                                      | **Restricted to** `status`, `activePlanKey`, `currentPeriodEnd`, `gracePeriodEndsAt`, `pendingDueMinor`, `scheduledChange`. Requires `reason`. **Any attempt to touch an event/media field → `422 forbidden_field`.** This is invariant C6 expressed as a request validator. |
| `POST /admin/subscriptions/{id}/credit`                                | Manual `credit`/`adjustment` `billingTransactions` row. Append-only.                                                                                                                                                                                                         |
| `GET /admin/webhook-events?provider=&processed=false&cursor=`          | The webhook inbox                                                                                                                                                                                                                                                            |
| `POST /admin/webhook-events/{id}/replay`                               | Re-projects a stored raw payload. Idempotent by construction.                                                                                                                                                                                                                |
| `GET /admin/billing/reconciliation?from=&to=`                          | Our state vs. provider state; mismatches emit `admin.billing.manual_review`                                                                                                                                                                                                  |

## 9.8 DSR queue

| Method & path                                                        | Purpose                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /admin/data-requests?status=&regulation=&slaDueBefore=&cursor=` | Sorted by `slaDueAt` asc                                                    |
| `PATCH /admin/data-requests/{id}`                                    | `status`, `rejectionReason` (required for `rejected`)                       |
| `POST /admin/data-requests/{id}/execute`                             | Runs the bounded purge/export. `202`. Appends counted `executionLog` steps. |

## 9.9 Audit logs

### `GET /admin/audit-logs?tenantId=&actorId=&action=&targetKind=&targetId=&from=&to=&cursor=`

Read-only. No write, update or delete endpoint exists, by design. Retention 400 days (TTL), exceeding a full audit year.

## 9.10 Platform settings

### `GET /admin/settings` · `PATCH /admin/settings`

Auth `admin` · **`If-Match` required** · Requires `reason`

Exposes the `platformSettings` singleton (schema §20.4). **Every number quoted in this contract is read from here** — none may be hard-coded in application code.

```json
{
  "dunning": { "gracePeriodDays": 14, "reminderDays": [1, 5, 7, 11, 13], "maxChargeRetries": 3 },
  "retention": {
    "notificationDays": 90,
    "notificationActiveDays": 30,
    "dispatchDays": 180,
    "domainEventDays": 180,
    "webhookDays": 90,
    "attendeeSessionDays": 30,
    "uploadSessionDays": 5
  },
  "face": {
    "activeSpaceKey": "arcface_r100_512",
    "matchLimit": 500,
    "minDetScore": 0.55,
    "exactSearch": true
  },
  "pipeline": {
    "leaseMinutes": 10,
    "maxAttempts": 5,
    "sweepIntervalSeconds": 120,
    "backlogWarnDepth": 5000,
    "backlogWarnAgeMinutes": 15
  },
  "upload": {
    "multipartThresholdBytes": 8388608,
    "maxFileBytes": 104857600,
    "supportedMimeTypes": ["image/jpeg", "..."]
  },
  "notifications": {
    "pollIntervalSeconds": 30,
    "digestQuietMinutes": 15,
    "digestHardFlushHours": 6,
    "maxDigestEmailsPerDay": 3
  },
  "updatedAt": "...",
  "updatedByUserId": "..."
}
```

Validation guards: `gracePeriodDays` 1–60; `reminderDays` strictly increasing and all `< gracePeriodDays`; `leaseMinutes` 1–60; `pollIntervalSeconds` 10–300. `422 setting_out_of_range` otherwise.

---

# Part 10 — Machine-to-machine

## 10.1 Provider webhooks

### `POST /api/v1/webhooks/{provider}`

Auth `provider` · `{provider}` ∈ `cashfree` | `novu` (extend additively) · **Not rate limited**

One generic inbox for **all** inbound provider callbacks — payments, message-delivery receipts, storage events (schema §11.3). The requirements are identical regardless of vendor.

Mandatory handler order — **no step may be skipped or reordered**:

1. Read the **raw body** (never the parsed body) and verify the provider signature. Invalid → `401 invalid_signature`, no write.
2. Verify the timestamp is within ±300 s where the provider supplies one. Stale → `401 stale_signature`.
3. Extract `providerEventId`; if absent, compute `payloadHash = sha256(rawBody)`.
4. `insertOne` into `providerWebhookEvents` with `{provider, env, eventType, providerEventId, payloadHash, signatureValid: true, rawPayload, receivedAt}`. **A duplicate-key error IS the deduplication** — catch it, return `200 {"status":"duplicate_ignored"}`, do nothing else. No application-level "have I seen this?" check.
5. Respond **`200` within 5 seconds**, before any projection work. The response body is `{"status":"received"}`. **Never** make the provider wait on domain logic — a timeout causes a redelivery storm, and a redelivery storm during a payment incident is how wrongful downgrades happen.
6. Project into domain state **after** responding (or in a separate consumer reading `providerWebhookEvents` where `processedAt: null`). Projection is a **transaction**: `billingTransactions` insert + `subscriptions` update together (schema §23 — money and access must move together).
7. Set `processedAt`, `processResult` ∈ `applied` | `ignored` | `error`, and `processError` on the raw row. A projection failure leaves `processedAt: null` and is retried by the sweep (§10.2) — it does **not** cause a non-`200` to the provider.
8. Emit domain events for every state change via `emitDomainEvent()`. The webhook handler itself **never** calls the notification service (schema P4 / §18.3).

### 10.1.1 Non-negotiable webhook rules

| Rule                                                                                                                                                                                                                                     | Why                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **The unique index is the dedupe.** `{provider, providerEventId}` unique; `{provider, payloadHash}` unique partial where `providerEventId: null`. A replayed webhook fails to insert, the handler returns `200`, nothing is reprocessed. | Schema §18.4 — no application-level "have I seen this?" check to get wrong |
| **Never trust a client-side redirect for state.** `returnUrl` is a UX nicety only.                                                                                                                                                       | Billing doc §2.3                                                           |
| **Never trust the parsed body for signature verification.** Verify over raw bytes; JSON re-serialisation breaks HMAC.                                                                                                                    |                                                                            |
| **Provider status strings never leave the adapter.** `normalizeStatus()` and `normalizeFailureCategory()` run before any write.                                                                                                          | Schema §14.4                                                               |
| **`rawPayload` is never returned outside `/admin`.**                                                                                                                                                                                     | §0.15                                                                      |
| **`env` is stored on every row.** A sandbox event must never be projected onto a production subscription → `422 env_mismatch`, `processResult: "ignored"`.                                                                               | Schema §11.1                                                               |

### 10.1.2 Payment provider event mapping

The adapter maps vendor event types onto our normalised taxonomy. **This table is the only place vendor event names appear.**

| Provider event type                                                          | Normalised projection                                                                                                                                                                                               | Emits                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `SUBSCRIPTION_STATUS_CHANGED` → `BANK_APPROVAL_PENDING`                      | `mandateStatus: "pending"`                                                                                                                                                                                          | `billing.mandate.pending`                                                                                                     |
| `SUBSCRIPTION_AUTH_STATUS` success                                           | `status: "active"`, `mandateStatus: "active"`, `currentPeriodStart/End`, `nextChargeAt`; `billingTransactions.kind: "authorization"`, `status: "succeeded"`                                                         | `billing.subscription.activated`                                                                                              |
| `SUBSCRIPTION_AUTH_STATUS` failure                                           | `status` stays `incomplete`; transaction `failed` with `failure.category`                                                                                                                                           | `billing.mandate.failed`                                                                                                      |
| `SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED`                                | log only (`processResult: "ignored"`)                                                                                                                                                                               | — (our own `billing.renewal.upcoming` fires from cron at T-3d)                                                                |
| `SUBSCRIPTION_PAYMENT_SUCCESS`                                               | transaction `charge`/`succeeded`; extend `currentPeriodEnd`; `pendingDueMinor: 0`; `gracePeriodEndsAt: null`; `dunning` reset; if previously `downgraded` → `status: "active"`, `activePlanKey = subscribedPlanKey` | `billing.payment.succeeded`; plus `billing.subscription.reactivated` + `usage.limit.restored` if recovering from `downgraded` |
| `SUBSCRIPTION_PAYMENT_FAILED`                                                | transaction `failed`; `status: "past_due"`; `gracePeriodEndsAt = now + platformSettings.dunning.gracePeriodDays`; `pendingDueMinor = price`; `dunning.attemptCount++`                                               | `billing.payment.failed` (**the highest-value mobile message in the product** — it starts the 14-day clock)                   |
| `SUBSCRIPTION_PAYMENT_CANCELLED`                                             | treated identically to `PAYMENT_FAILED` for dunning; `failure.category: "auth_required"`                                                                                                                            | `billing.payment.failed`                                                                                                      |
| `SUBSCRIPTION_STATUS_CHANGED` → `CUSTOMER_CANCELLED` / `ON_HOLD` / `EXPIRED` | `status: "cancelled"` / `mandateStatus: "paused"` / `"expired"`                                                                                                                                                     | `billing.subscription.cancelled`                                                                                              |
| `SUBSCRIPTION_REFUND_STATUS`                                                 | transaction `refund`                                                                                                                                                                                                | `billing.refund.processed`                                                                                                    |

**`gracePeriodEndsAt` is computed from `platformSettings`, never a hard-coded 14.** An error-spike across these events raises `admin.provider.failing` (always mobile — silent payment-webhook failure means wrongful downgrades).

### 10.1.3 Message transport delivery receipts

| Provider event                     | Projection                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| delivered                          | `notificationDispatches.status: "delivered"`, `deliveredAt`                                                           |
| bounced (hard)                     | `status: "bounced"`; insert `notificationSuppressions` `{channel, contactHash, reason: "hard_bounce", scope: "all"}`  |
| bounced (soft)                     | `status: "failed"`, `attempts++`, retry per policy. **No suppression.**                                               |
| complaint / spam report            | `status: "failed"`; suppression `reason: "complaint"`, `scope: "all"`                                                 |
| unsubscribe (provider-side)        | suppression `reason: "unsubscribe"`, `scope: "marketing"` — **scope matters: an unsubscribe must never block an OTP** |
| DND registry rejection (SMS/India) | suppression `reason: "dnd_registry"`, `scope: "all"`                                                                  |

Lookup is by `{providerRef.provider, providerRef.messageId}` (partial index). An unmatched receipt is `processResult: "ignored"`, never an error.

### 10.1.4 Storage events (optional, phase 2)

`POST /api/v1/webhooks/storage` — object-created notifications used as a belt-and-braces trigger for derivative generation when a client completes a presigned `PUT` but never calls `/complete`. Reconciles `uploadSessions` stuck `in_progress` with bytes present. Idempotent against `{eventId, assetId}` unique.

---

## 10.2 Cron endpoints

All under `/api/v1/internal/cron/**`, auth `internal`. Invoked by Vercel Cron. Every one of them is **idempotent, concurrency-safe and bounded**.

Mandatory implementation rules:

1. **Conditional single-document updates only.** Every transition puts the expected prior state in the filter (`findOneAndUpdate`, never read-then-write). A lost race matches zero documents and is a no-op, not corruption.
2. **Bounded work per invocation.** Every job takes `?limit=` (default per table) and returns `hasMore`, so it completes inside the Vercel function timeout. The scheduler re-invokes; the job never loops indefinitely.
3. **Never emit notifications inline.** Jobs write `domainEvents`; the fan-out consumer delivers.
4. **Structured result body**, always, so runs are observable:

```json
{
  "job": "dunning",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 1840,
  "scanned": 412,
  "affected": 7,
  "skipped": 405,
  "errors": 0,
  "hasMore": false,
  "details": { "downgraded": 7 }
}
```

| Route                                  | Schedule        | Work                                                                                                                                                                                                                                                                                     | Emits                                                                                                                        | Default limit |
| -------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `POST .../dunning`                     | hourly          | `subscriptions` where `status: "past_due"` **and** `gracePeriodEndsAt < now` → `status: "downgraded"`, `activePlanKey: "free"`, append `statusHistory`. **Writes nothing else. Ever.**                                                                                                   | `billing.subscription.downgraded`                                                                                            | 500           |
| `POST .../dunning-reminders`           | 4×/day          | Grace-day schedule from `platformSettings.dunning.reminderDays` `[1,5,7,11,13]`; `dunning.remindersSent[]` makes it idempotent under retries                                                                                                                                             | `billing.grace.reminder` (**mobile only on day 13**)                                                                         | 1000          |
| `POST .../renewal-reminders`           | daily           | `status: "active"`, `nextChargeAt` within 3 days, not already reminded this cycle                                                                                                                                                                                                        | `billing.renewal.upcoming`                                                                                                   | 1000          |
| `POST .../scheduled-plan-changes`      | hourly          | `scheduledChange.effectiveAt <= now` → apply, clear                                                                                                                                                                                                                                      | `billing.plan.downgrade_applied`                                                                                             | 500           |
| `POST .../billing-reconcile`           | every 4 h       | Subscriptions stuck `incomplete` > 1 h, or `past_due` with no resolving webhook; explicit provider status fetch; correct drift. **The webhook-miss safety net.**                                                                                                                         | `admin.billing.manual_review` on mismatch                                                                                    | 200           |
| `POST .../webhook-projection-sweep`    | every 5 min     | `providerWebhookEvents` where `processedAt: null` and `receivedAt < now - 60s` → re-project                                                                                                                                                                                              | `admin.provider.failing` on repeated failure                                                                                 | 500           |
| `POST .../pipeline-sweep`              | **every 2 min** | Four steps, in order: (1) expired leases → `queued` + re-enqueue; (2) `queued` > 5 min with no broker ack → re-enqueue; (3) `attempts >= maxAttempts` → `failed`; (4) profiles where the event has faces newer than `lastMatchRunAt` → enqueue incremental match                         | `pipeline.image.failed` (daily digest), `pipeline.delayed`, `admin.queue.backlog`                                            | 2000          |
| `POST .../pipeline-indexed-check`      | every 5 min     | Events where all queued images reached a terminal state → mark indexed                                                                                                                                                                                                                   | `pipeline.event.indexed` (email on first completion per event only)                                                          | 500           |
| `POST .../upload-session-sweep`        | hourly          | `uploadSessions` `in_progress`, idle > 24 h, parts stored                                                                                                                                                                                                                                | `upload.session.stalled`                                                                                                     | 1000          |
| `POST .../event-window-sweep`          | hourly          | `uploadWindowEndsAt` at T-72h / T-24h / passed; `startAt` at T-24h; `endAt` passed                                                                                                                                                                                                       | `event.upload_window.closing` (**mobile only at T-24h**), `event.upload_window.closed`, `event.starting_soon`, `event.ended` | 1000          |
| `POST .../retention-warnings`          | daily           | `retentionExpiresAt` at T-14d / T-3d (organizer) and T-7d / T-1d (attendee)                                                                                                                                                                                                              | `event.retention.expiring` (mobile at T-3d), `attendee.gallery.expiring` (mobile at T-1d)                                    | 2000          |
| `POST .../retention-purge`             | daily           | `retentionExpiresAt < now`. **Ordered, counted purge:** storage objects → `imageFaces` vectors → `faceMatches` → `eventImages` → `mediaAssets` at `refCount 0`. **Never a TTL** — deletion must be ordered, countable for DSR evidence, and preceded by the warnings above (schema §22). | —                                                                                                                            | 50 events     |
| `POST .../usage-threshold-check`       | hourly          | 80/95/100 % crossings; **latched per threshold per period** so a delete-then-re-cross doesn't re-notify                                                                                                                                                                                  | `usage.storage.threshold`, `usage.events.threshold`                                                                          | 2000          |
| `POST .../invitation-expiry`           | hourly          | `invitations` `pending` with `expiresAt < now` → `expired`; T+3d reminder for still-pending                                                                                                                                                                                              | `collab.invite.expired`, `collab.invite.reminder`                                                                            | 1000          |
| `POST .../notification-digest-flush`   | **every 5 min** | `notificationDigests` `status: "open"` with `flushAt <= now` → render summary, dispatch, `flushed`. Respects `maxDigestEmailsPerDay` (3)                                                                                                                                                 | the digested type                                                                                                            | 1000          |
| `POST .../notification-dispatch-retry` | every 5 min     | `notificationDispatches` `queued` beyond expected latency → re-attempt via transport                                                                                                                                                                                                     | `admin.provider.failing` on spike                                                                                            | 500           |
| `POST .../quiet-hours-release`         | every 15 min    | Dispatches deferred by quiet hours whose window has ended                                                                                                                                                                                                                                | —                                                                                                                            | 1000          |
| `POST .../account-deletion-purge`      | daily           | `userProfiles` `deletion_pending` with `deletionScheduledAt < now`                                                                                                                                                                                                                       | `account.deletion.completed` (email only)                                                                                    | 50            |
| `POST .../dsr-sla-check`               | daily           | Open DSRs within 48 h of `slaDueAt`                                                                                                                                                                                                                                                      | `admin.dsr.sla_risk`                                                                                                         | 500           |
| `POST .../analytics-rollup`            | daily 02:00 IST | Roll `domainEvents` + counts into `analyticsDaily`                                                                                                                                                                                                                                       | —                                                                                                                            | all           |
| `POST .../counter-reconcile`           | daily 02:30 IST | Recompute `tenants.counters`, `events.counters`, `attendeeEventProfiles.matchCount` from source; log deltas                                                                                                                                                                              | `admin.abuse.flagged` on large drift                                                                                         | 200 tenants   |
| `POST .../tenant-isolation-audit`      | nightly         | Documents whose `tenantId` doesn't resolve to a live tenant, or disagrees with the parent event's `tenantId` (schema §10.2 mitigation 3)                                                                                                                                                 | `admin.abuse.flagged`                                                                                                        | all           |
| `POST .../verification-nudge`          | hourly          | Incomplete accounts at T+24h and T+72h, **max 2 ever**, stops permanently once complete                                                                                                                                                                                                  | `account.verification.incomplete`                                                                                            | 1000          |
| `POST .../attendee-no-match-check`     | hourly          | Events whose window closed with attendees at 0 matches                                                                                                                                                                                                                                   | `attendee.matches.none_found`                                                                                                | 1000          |

### 10.2.1 The C6 guard, as a code rule

> The dunning worker module may import **only** the `subscriptions` repository. It may write **only** `subscriptions.status`, `subscriptions.activePlanKey` and `subscriptions.statusHistory`.

Enforce with an ESLint `no-restricted-imports` rule on the dunning module forbidding `events`, `eventImages`, `mediaAssets`, `imageFaces`, `faceMatches` and `selfies` repositories. Billing collections hold **no references** into media/event collections, so no dunning bug _can_ reach user content — but the lint rule makes the intent unforgeable.

---

## 10.3 Worker contract

The Python worker (InsightFace) is a **pull-based consumer**. It never receives HTTP pushes, because it must control its own concurrency to keep download and inference pipelined and never idle.

```
┌──────────────┐  1. insert work item (processing.status = "queued")
│  Next.js API │──────────────────────────────────────────────► MongoDB
└──────┬───────┘  2. enqueue                                     ▲   ▲
       └──────────────────────────────► Upstash (q:selfie ▸ q:image)   │
                                                 │                │   │
┌──────────────┐  3. claim batch                 ▼                │   │
│ Python worker│◄────────────────────────────────────────────────┘   │
└──────┬───────┘  4. lease: queued → processing, leaseExpiresAt      │
       │          5. download bytes (concurrent with inference) ── R2 │
       │          6. write imageFaces / run $vectorSearch ────────────┘
       │          7. processing.status = "done"
       └────────► 8. emitDomainEvent() via internal API OR direct insert
```

### 10.3.1 Database access

The worker connects **directly to MongoDB** and performs the claim, the face writes and the `$vectorSearch` itself. It does **not** proxy these through Next.js — that would add a hop to the hottest path and put a serverless function in front of a long-running batch.

Constraint C3 is binding: **the vector search runs inside MongoDB, not in Python.** The worker issues one `$vectorSearch` aggregation per selfie, pre-filtered by `eventId` and `createdAt > lastMatchRunAt`, with the threshold and quality post-filters in the same pipeline. It receives **decisions, not candidate sets**. A worker that loads vectors into Python to compare them is a contract violation.

**Claim** (atomic, safe with N concurrent workers):

```python
doc = event_images.find_one_and_update(
    {"_id": item_id,
     "processing.status": {"$in": ["queued", "processing"]},
     "$or": [{"processing.leaseExpiresAt": None},
             {"processing.leaseExpiresAt": {"$lt": now}}]},
    {"$set": {"processing.status": "processing",
              "processing.leaseExpiresAt": now + timedelta(minutes=lease_minutes),
              "processing.workerId": worker_id,
              "processing.startedAt": now},
     "$inc": {"processing.attempts": 1}},
    return_document=ReturnDocument.AFTER)
if doc is None:
    return  # someone else holds a live lease — skip silently, not an error
```

**Lease renewal.** For items expected to exceed `leaseMinutes`, the worker extends `leaseExpiresAt` every `leaseMinutes / 3`. A renewal whose filter includes `processing.workerId == self` and matches zero documents means **the lease was reclaimed by the sweep** — the worker must abandon the item immediately without writing results (`lease_lost`). Writing results after losing a lease is how duplicate faces appear.

**Watermark rule.** `lastMatchRunAt` is set to `runStartedAt`, captured **before** the query — never `now()` after it. Otherwise faces created during the query fall into a gap and are never scored.

**Idempotency.** All result writes are upserts on unique keys: `{imageId, faceIndex}` for `imageFaces`, `{profileId, imageId, faceIndex}` for `faceMatches`. Re-processing a claimed-twice item is therefore harmless — which is the entire basis of the incremental design.

### 10.3.2 Internal endpoints the worker calls

The worker does **not** embed a notification client (notification design §1, goal 5). It emits domain events; the Next.js fan-out consumer decides channels.

#### `POST /api/v1/internal/domain-events`

Auth `internal` · Batched, max 100 per call

```json
{
  "events": [
    {
      "eventKey": "pipeline.event.indexed",
      "tenantId": "6702f200...",
      "actorRef": { "kind": "system", "id": "worker" },
      "subjectRef": { "kind": "event", "id": "6702ff..." },
      "payload": {
        "eventId": "6702ff...",
        "eventName": "Rahul & Priya's Wedding",
        "imageCount": 4120
      },
      "occurredAt": "2026-09-25T09:41:00.000Z",
      "dedupeKey": "pipeline.event.indexed:6702ff"
    }
  ]
}
```

`202` → `{ "accepted": 1, "deduped": 0, "rejected": [] }`

- `eventKey` must exist in the §7.6 enumeration → else it lands in `rejected` with `unknown_event_key` and the rest still succeed. A bad key never fails the batch.
- `dedupeKey` is optional; when present, a duplicate is silently dropped (`deduped++`).
- The worker may alternatively insert `domainEvents` directly. The HTTP path exists for validation and because it keeps the worker's write surface to one collection when preferred.

#### `POST /api/v1/internal/worker/heartbeat`

Auth `internal` · Every 30 s

```json
{
  "workerId": "w-3f2a",
  "version": "1.4.2",
  "modelKeys": { "detection": "scrfd_10g_bnkps", "recognition": "insightface-antelopev2-2026-03" },
  "inFlight": 8,
  "capacity": 16,
  "throughputPerMin": 220,
  "queueDepthObserved": { "selfie": 0, "image": 4120 },
  "gpu": { "present": true, "utilizationPercent": 78, "memoryUsedMb": 4120 }
}
```

`200` → `{ "acknowledged": true, "activeSpaceKey": "arcface_r100_512", "leaseMinutes": 10, "maxAttempts": 5, "pauseRequested": false }`

The response is the worker's **configuration channel**. `activeSpaceKey` is how a model promotion reaches the worker without a redeploy. `pauseRequested: true` (set by an admin during an incident) means: finish in-flight items, claim nothing new. Missing heartbeats for > 3 intervals surface in `/admin/pipeline/health` and raise `admin.queue.backlog`.

#### `POST /api/v1/internal/worker/report`

Auth `internal` · Optional — for workers that prefer not to write `processing` directly

```json
{
  "items": [
    {
      "kind": "event_image",
      "id": "6704aa...",
      "outcome": "done",
      "faceCount": 3,
      "durationMs": 3400,
      "modelKeys": {
        "detection": "scrfd_10g_bnkps",
        "recognition": "insightface-antelopev2-2026-03"
      }
    },
    {
      "kind": "event_image",
      "id": "6704ab...",
      "outcome": "failed",
      "error": { "code": "corrupt_image", "message": "truncated JPEG", "retryable": false }
    },
    {
      "kind": "selfie",
      "id": "6706dd...",
      "outcome": "done",
      "quality": { "faceCount": 1, "accepted": true },
      "liveness": { "passed": true, "score": 0.91 },
      "matchesCreated": 38,
      "matchRunStartedAt": "2026-09-25T09:18:00.000Z"
    }
  ]
}
```

`outcome` ∈ `done` | `failed` | `skipped`. `retryable: false` jumps straight to `failed` regardless of remaining `attempts`.

`200` → `{ "applied": 3, "leaseLost": 0, "rejected": [] }`

#### `POST /api/v1/internal/media/derivative-complete`

Auth `internal` — the thumbnail processor reports a generated derivative.

```json
{
  "assetId": "6704bb...",
  "derivative": "thumbnail",
  "objectKeyRef": "<opaque handle>",
  "bytes": 48120,
  "width": 600,
  "height": 900,
  "format": "webp",
  "processorVersion": 3,
  "watermarkVersion": 2,
  "contentHash": "..."
}
```

Writes `mediaAssets.derivatives.thumbnail` and advances `status` to `derivatives_ready`. `200`.

### 10.3.3 Error taxonomy the worker must use

| `error.code`           | `retryable` | Terminal meaning                                                                                     |
| ---------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `download_failed`      | `true`      | Transient storage error                                                                              |
| `corrupt_image`        | `false`     | Unreadable bytes → `pipeline.image.failed`                                                           |
| `unsupported_format`   | `false`     | Should have been caught at upload; log as a validation gap                                           |
| `no_faces_detected`    | `false`     | **`outcome: "done"` with `faceCount: 0`, not `failed`.** Zero faces is a valid result, not an error. |
| `model_load_failed`    | `true`      | Infrastructure → `admin.provider.failing`                                                            |
| `inference_timeout`    | `true`      |                                                                                                      |
| `oom`                  | `true`      | Retry on a different worker                                                                          |
| `vector_search_failed` | `true`      | Atlas index unavailable                                                                              |
| `lease_lost`           | —           | Abandon silently; do not report, do not write results                                                |

---

## 10.4 Queue message envelope

Upstash Redis is **transport only**. MongoDB holds durable job state on the work item itself (constraint C4, schema §18.1). A lost broker message is a non-event: the sweep re-enqueues anything `queued` past its ack window.

Two logical queues, drained strictly in priority order — `q:selfie` before `q:image`, because an attendee is staring at a loading spinner while an organizer's batch can wait.

```json
{
  "v": 1,
  "kind": "event_image" | "selfie" | "match_incremental",
  "id": "6704aa...",
  "tenantId": "6702f200...",
  "eventId": "6702ff...",
  "priority": "high" | "normal",
  "spaceKey": "arcface_r100_512",
  "enqueuedAt": "2026-09-25T09:12:00.000Z",
  "attempt": 1,
  "traceId": "req_01JBQ7X3M2"
}
```

| Field                                | Rule                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                                  | Envelope version. A worker receiving an unknown `v` must nack and alert, never guess.                                                                                                           |
| `kind`                               | `match_incremental` carries `profileId` in place of a media `id` and triggers a re-run of that attendee's `$vectorSearch` against faces newer than their watermark.                             |
| `spaceKey`                           | Snapshot of the active embedding space at enqueue time. If it differs from the worker's configured `activeSpaceKey`, the worker re-reads config before processing (mid-flight model promotion). |
| **No payload beyond identifiers**    | The message is a **pointer**. All state is re-read from MongoDB at claim time, so a message sitting in the queue for an hour is never stale.                                                    |
| **No broker id in any domain field** | The broker's message id lives only in `processing.queueRef.messageId`. Swapping Upstash → SQS changes `queueRef.provider` and one adapter; **zero schema change.**                              |

**Queue-swap surface** (schema §28): implement `enqueue(envelope, queueKey)`, `claim(queueKey, n) → envelope[]`, `ack(messageId)`, `nack(messageId, delaySeconds)`. Nothing else in the system references the broker.

---

# Part 11 — Appendices

## Appendix A — Error code catalogue

Every `error.code` in v1. **Clients branch on `code` only.** Codes are append-only: a new code may appear in `v1`, an existing one never changes meaning.

### A.1 Authentication & authorization

| `code`                     | Status | Retryable | `details`                                         |
| -------------------------- | ------ | --------- | ------------------------------------------------- |
| `authentication_required`  | 401    | no        | `{ loginUrl, inviteePreview? }`                   |
| `session_expired`          | 401    | no        | `{ loginUrl }`                                    |
| `attendee_session_expired` | 401    | no        | `{ recreateUrl }`                                 |
| `invalid_credentials`      | 401    | no        | —                                                 |
| `forbidden`                | 403    | no        | `{ requiredRole? }`                               |
| `account_incomplete`       | 403    | no        | `{ missing: ["phoneNumberVerified"], verifyUrl }` |
| `admin_2fa_required`       | 403    | no        | `{ setupUrl }`                                    |
| `csrf_failed`              | 403    | no        | —                                                 |
| `account_banned`           | 423    | no        | `{ banReason, banExpires }`                       |
| `account_suspended`        | 423    | no        | `{ reason, supportUrl }`                          |
| `tenant_suspended`         | 423    | no        | `{ reason, supportUrl }`                          |
| `internal_auth_failed`     | 401    | no        | —                                                 |
| `invalid_signature`        | 401    | no        | —                                                 |
| `stale_signature`          | 401    | no        | `{ skewSeconds }`                                 |
| `timestamp_skew`           | 400    | yes       | `{ maxSkewSeconds: 300 }`                         |

### A.2 Request shape

| `code`                     | Status | Retryable | `details`                               |
| -------------------------- | ------ | --------- | --------------------------------------- |
| `validation_failed`        | 422    | no        | `{ fields: [{ path, code, message }] }` |
| `malformed_json`           | 400    | no        | —                                       |
| `invalid_cursor`           | 400    | no        | —                                       |
| `unsupported_media_type`   | 415    | no        | `{ supportedMimeTypes }`                |
| `file_too_large`           | 413    | no        | `{ maxBytes, actualBytes }`             |
| `payload_too_large`        | 413    | no        | `{ maxItems, actualItems }`             |
| `range_too_large`          | 422    | no        | `{ maxDays }`                           |
| `unknown_timezone`         | 422    | no        | `{ field }`                             |
| `invalid_datetime`         | 422    | no        | `{ field }`                             |
| `invalid_date_range`       | 422    | no        | `{ startAt, endAt }`                    |
| `confirmation_mismatch`    | 422    | no        | `{ field }`                             |
| `acknowledgement_required` | 422    | no        | `{ consequences: [...] }`               |
| `reason_required`          | 422    | no        | —                                       |
| `forbidden_field`          | 422    | no        | `{ fields: ["eventId"] }`               |
| `setting_out_of_range`     | 422    | no        | `{ key, min, max }`                     |
| `env_mismatch`             | 422    | no        | `{ expected, received }`                |

### A.3 Idempotency & concurrency

| `code`                     | Status | Retryable | `details`                  |
| -------------------------- | ------ | --------- | -------------------------- |
| `idempotency_key_required` | 400    | no        | —                          |
| `idempotency_key_reuse`    | 422    | no        | `{ originalRequestAt }`    |
| `idempotency_in_progress`  | 409    | **yes**   | `{ retryAfterSeconds: 2 }` |
| `precondition_required`    | 428    | no        | `{ header: "If-Match" }`   |
| `etag_mismatch`            | 412    | no        | `{ currentETag }`          |

### A.4 Entitlements & billing

| `code`                        | Status | Retryable | `details`                                                                                                  |
| ----------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| `plan_limit_exceeded`         | 403    | no        | `{ entitlementKey, limit, used, periodKey, scope, reason: "plan_limit", upgradePath, requestedDays? }`     |
| `payment_required`            | 402    | no        | `{ entitlementKey, reason: "payment_downgrade", pendingDueMinor, currency, payNowUrl, gracePeriodEndsAt }` |
| `feature_not_available`       | 403    | no        | `{ entitlementKey, upgradePath }`                                                                          |
| `subscription_already_active` | 409    | no        | `{ subscriptionId, status }`                                                                               |
| `plan_not_self_serve`         | 422    | no        | `{ contactSalesUrl }`                                                                                      |
| `invalid_return_url`          | 422    | no        | `{ allowedOrigins }`                                                                                       |
| `not_an_upgrade`              | 422    | no        | `{ currentTierRank, targetTierRank, downgradeUrl }`                                                        |
| `no_pending_due`              | 409    | no        | —                                                                                                          |
| `mandate_not_chargeable`      | 409    | no        | `{ mandateStatus, recoveryAction: "recreate_mandate", checkoutUrl }`                                       |
| `price_amount_immutable`      | 422    | no        | —                                                                                                          |
| `plan_deletion_forbidden`     | 422    | no        | `{ activeSubscriptionCount }`                                                                              |
| `invalid_billing_contact`     | 422    | no        | —                                                                                                          |

### A.5 Tenancy, events, collaboration

| `code`                               | Status | Retryable | `details`                        |
| ------------------------------------ | ------ | --------- | -------------------------------- |
| `not_found`                          | 404    | no        | —                                |
| `cannot_demote_owner`                | 409    | no        | —                                |
| `cannot_remove_organizer`            | 409    | no        | `{ transferOwnershipUrl }`       |
| `invitation_already_pending`         | 409    | no        | `{ invitationId, expiresAt }`    |
| `invitation_expired`                 | 410    | no        | `{ expiredAt }`                  |
| `invitation_revoked`                 | 410    | no        | `{ revokedAt }`                  |
| `invitation_not_for_you`             | 403    | no        | `{ inviteeMasked }`              |
| `event_deleting`                     | 409    | no        | `{ purgeScheduledAt }`           |
| `event_gone`                         | 410    | no        | —                                |
| `access_link_revoked`                | 410    | no        | `{ message }`                    |
| `retention_would_expire_immediately` | 422    | no        | `{ computedRetentionExpiresAt }` |

### A.6 Uploads & media

| `code`                    | Status | Retryable | `details`                                       |
| ------------------------- | ------ | --------- | ----------------------------------------------- |
| `upload_window_closed`    | 409    | no        | `{ uploadWindowEndsAt, canExtend, extendUrl? }` |
| `size_mismatch`           | 409    | no        | `{ declaredBytes, actualBytes }`                |
| `parts_missing`           | 409    | no        | `{ missingPartNumbers }`                        |
| `upload_expired`          | 409    | no        | `{ restartFrom: "batch-resolve" }`              |
| `not_failed`              | 409    | no        | `{ currentStatus }`                             |
| `media_signature_invalid` | 403    | no        | — (raised by the Worker, not JSON)              |

### A.7 Attendee flow

| `code`                          | Status | Retryable | `details`                                           |
| ------------------------------- | ------ | --------- | --------------------------------------------------- |
| `consent_required`              | 412    | no        | `{ purpose, requiredPolicyVersion, policyUrl }`     |
| `policy_version_stale`          | 422    | no        | `{ currentPolicyVersion, policyUrl }`               |
| `liveness_challenge_invalid`    | 409    | no        | `{ reason: "expired"\|"already_used"\|"mismatch" }` |
| `gallery_closed`                | 409    | no        | `{ closedAt }`                                      |
| `gallery_expired`               | 410    | no        | `{ expiredAt }`                                     |
| `download_expired`              | 410    | no        | `{ rerequestUrl }`                                  |
| `session_claimed_by_other_user` | 409    | no        | —                                                   |

### A.8 Notifications

| `code`                       | Status | Retryable | `details`                                            |
| ---------------------------- | ------ | --------- | ---------------------------------------------------- |
| `unknown_type_key`           | 422    | no        | `{ typeKey }`                                        |
| `opt_out_not_allowed`        | 422    | no        | `{ typeKey, channelGroup, reason: "transactional" }` |
| `template_variable_mismatch` | 422    | no        | `{ missing: [], unused: [] }`                        |
| `test_send_self_only`        | 422    | no        | —                                                    |
| `unknown_event_key`          | 422    | no        | `{ eventKey }`                                       |

### A.9 Platform & infrastructure

| `code`                 | Status | Retryable | `details`                              |
| ---------------------- | ------ | --------- | -------------------------------------- |
| `rate_limited`         | 429    | **yes**   | `{ retryAfterSeconds, limit, window }` |
| `backfill_incomplete`  | 409    | no        | `{ coveragePercent, required: 99.9 }`  |
| `lease_lost`           | 409    | no        | — (worker-internal)                    |
| `internal_error`       | 500    | no        | —                                      |
| `service_unavailable`  | 503    | **yes**   | `{ retryAfterSeconds }`                |
| `upstream_unavailable` | 502    | **yes**   | `{ provider, retryAfterSeconds }`      |

---

## Appendix B — TypeScript DTOs

Single shared module. Backend route handlers and frontend clients import from here; drift between them becomes a type error.

```ts
// packages/contracts/src/index.ts
// OpenPic API contract v1.0.0 — generated from the API contract document.
// DO NOT hand-edit response shapes without bumping the contract version.

/* ─────────────────────────── primitives ─────────────────────────── */

export type Id = string; // 24-hex ObjectId
export type IsoDateTime = string; // RFC 3339 UTC, ms, "Z"
export type DateKey = string; // "YYYY-MM-DD"
export type PeriodKey = string; // "YYYY-MM" | "YYYY" | "lifetime"
export type IanaTimeZone = string;
export type Sha256Hex = string; // 64 lowercase hex
export type Locale = "en-IN";

export interface Money {
  amountMinor: number;
  currency: "INR";
}

/* ─────────────────────────── envelopes ─────────────────────────── */

export interface Page {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  total?: number;
}
export interface Collection<T> {
  data: T[];
  page: Page;
}

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    retryable: boolean;
  };
}

export interface Accepted {
  status: "accepted";
  jobRef?: { kind: string; id: Id };
  pollUrl?: string;
  pollIntervalMs?: number;
}

export type ErrorCode =
  | "authentication_required"
  | "session_expired"
  | "attendee_session_expired"
  | "forbidden"
  | "account_incomplete"
  | "admin_2fa_required"
  | "csrf_failed"
  | "account_banned"
  | "account_suspended"
  | "tenant_suspended"
  | "validation_failed"
  | "malformed_json"
  | "invalid_cursor"
  | "unsupported_media_type"
  | "file_too_large"
  | "payload_too_large"
  | "range_too_large"
  | "unknown_timezone"
  | "invalid_datetime"
  | "invalid_date_range"
  | "confirmation_mismatch"
  | "acknowledgement_required"
  | "reason_required"
  | "forbidden_field"
  | "setting_out_of_range"
  | "env_mismatch"
  | "idempotency_key_required"
  | "idempotency_key_reuse"
  | "idempotency_in_progress"
  | "precondition_required"
  | "etag_mismatch"
  | "plan_limit_exceeded"
  | "payment_required"
  | "feature_not_available"
  | "subscription_already_active"
  | "plan_not_self_serve"
  | "invalid_return_url"
  | "not_an_upgrade"
  | "no_pending_due"
  | "mandate_not_chargeable"
  | "price_amount_immutable"
  | "plan_deletion_forbidden"
  | "invalid_billing_contact"
  | "not_found"
  | "cannot_demote_owner"
  | "cannot_remove_organizer"
  | "invitation_already_pending"
  | "invitation_expired"
  | "invitation_revoked"
  | "invitation_not_for_you"
  | "event_deleting"
  | "event_gone"
  | "access_link_revoked"
  | "retention_would_expire_immediately"
  | "upload_window_closed"
  | "size_mismatch"
  | "parts_missing"
  | "upload_expired"
  | "not_failed"
  | "consent_required"
  | "policy_version_stale"
  | "liveness_challenge_invalid"
  | "gallery_closed"
  | "gallery_expired"
  | "download_expired"
  | "session_claimed_by_other_user"
  | "unknown_type_key"
  | "opt_out_not_allowed"
  | "template_variable_mismatch"
  | "test_send_self_only"
  | "unknown_event_key"
  | "rate_limited"
  | "backfill_incomplete"
  | "internal_error"
  | "service_unavailable"
  | "upstream_unavailable"
  | (string & {}); // forward-compatible: unknown codes must not break the build

/* ─────────────────────────── identity ─────────────────────────── */

export type PlatformRole = "client" | "admin";
export type UserStatus = "active" | "suspended" | "deletion_pending" | "deleted";
export type TenantRole = "owner" | "admin" | "member";

export interface TenantRef {
  id: Id;
  slug: string;
  name: string;
  role: TenantRole;
  status: "active" | "suspended" | "closed";
}

export interface Me {
  id: Id;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  twoFactorEnabled: boolean;
  accountCompletedAt: IsoDateTime | null;
  displayName: string | null;
  avatarUrl: string | null;
  locale: Locale;
  timeZone: IanaTimeZone;
  platformRole: PlatformRole;
  status: UserStatus;
  marketingOptIn: boolean;
  contactCapabilities: { whatsappCapable: boolean | null; whatsappCheckedAt: IsoDateTime | null };
  primaryTenant: TenantRef | null; // null is NORMAL for a pure attendee
  tenants: TenantRef[];
  capabilities: { canCreateEvent: boolean; canPurchase: boolean; isAdmin: boolean };
  unreadNotificationCount: number;
  pendingInvitationCount: number;
  deletionScheduledAt: IsoDateTime | null;
}

export interface AttendeeSessionCreated {
  sessionToken: string; // RAW — returned exactly once
  expiresAt: IsoDateTime;
  issuedAt: IsoDateTime;
}

/* ─────────────────────────── invitations ─────────────────────────── */

export type InvitationStatus = "pending" | "accepted" | "rejected" | "revoked" | "expired";
export type InvitationKind = "event_co_organizer" | "platform_admin" | "tenant_member";
export type ResolvedVia = "in_app" | "email" | "sms" | "whatsapp" | "api";

export interface Invitation {
  id: Id;
  kind: InvitationKind;
  status: InvitationStatus;
  role: string;
  eventId: Id | null;
  event?: { id: Id; name: string; startAt: IsoDateTime; displayTimeZone: IanaTimeZone };
  tenant?: { id: Id; name: string };
  invitedBy?: { displayName: string };
  inviteeMasked: string;
  message?: string | null;
  channelsNotified?: string[];
  expiresAt: IsoDateTime;
  resolvedAt?: IsoDateTime | null;
  resolvedVia?: ResolvedVia | null;
  createdAt: IsoDateTime;
}

/** Returned by BOTH the first call and every replay. Never a 409. */
export interface InvitationDecision {
  id: Id;
  status: InvitationStatus;
  resolvedAt: IsoDateTime;
  resolvedVia: ResolvedVia;
  alreadyResolved: boolean;
  membership?: { eventId: Id; role: string };
  redirectUrl?: string;
}

/* ─────────────────────────── billing ─────────────────────────── */

export type EntitlementScope = "tenant" | "event" | "attendee";
export type ResetPeriod = "monthly" | "yearly" | "lifetime" | "none";
export type Enforcement = "hard" | "soft" | "policy" | "feature";

export interface EntitlementSpec {
  limit: number | null; // null = unlimited (hard) or boolean gate (feature)
  resetPeriod: ResetPeriod;
  scope: EntitlementScope;
  enforcement: Enforcement;
  enabled?: boolean; // only when enforcement === "feature"
  display: string;
}

export interface PlanPrice {
  priceKey: string;
  billingCycle: "monthly" | "yearly";
  amountMinor: number;
  currency: "INR";
  taxBehavior: "inclusive" | "exclusive";
  trialDays: number;
  active: boolean;
}

export interface Plan {
  key: "free" | "starter" | "professional" | "enterprise" | (string & {});
  name: string;
  description?: string;
  tierRank: number;
  selfServe: boolean;
  salesAssisted: boolean;
  marketingFeatures: string[];
  prices: PlanPrice[];
  entitlements: Record<string, EntitlementSpec>; // render generically — never switch on keys
  contactSalesUrl?: string;
  version: number;
}

export type SubscriptionStatus =
  "none" | "incomplete" | "active" | "past_due" | "downgraded" | "cancelled" | "expired";
export type MandateStatus = "pending" | "active" | "paused" | "revoked" | "expired";
export type PaymentMethodKind =
  "mandate_upi" | "mandate_bank_debit" | "card" | "invoice" | "manual";

export interface Subscription {
  tenantId: Id;
  exists: boolean;
  status: SubscriptionStatus;
  subscribedPlanKey: string;
  subscribedPlanVersion?: number;
  activePlanKey: string;
  priceKey?: string;
  billingCycle?: "monthly" | "yearly";
  paymentMethodKind?: PaymentMethodKind;
  mandateStatus?: MandateStatus | null; // INDEPENDENT of status
  currentPeriodStart?: IsoDateTime;
  currentPeriodEnd?: IsoDateTime;
  nextChargeAt?: IsoDateTime;
  gracePeriodEndsAt?: IsoDateTime | null;
  pendingDue: Money | null;
  dunning?: {
    attemptCount: number;
    lastAttemptAt: IsoDateTime | null;
    remindersSent: string[];
    nextReminderAt: IsoDateTime | null;
  };
  scheduledChange: { toPlanKey: string; effectiveAt: IsoDateTime; reason: string } | null;
  cancelAt?: IsoDateTime | null;
  actions: {
    canUpgrade: boolean;
    canDowngrade: boolean;
    canCancel: boolean;
    canRetryCharge: boolean;
    mustCompleteMandate: boolean;
  };
  banner: {
    kind: "past_due" | "downgraded" | "mandate_pending" | "mandate_revoked" | "cancelling";
    severity: "critical" | "important" | "informational";
    daysRemaining?: number;
    downgradeOn?: IsoDateTime;
    /** MANDATORY on past_due / downgraded. Notification §4.3. */
    reassurance?: string;
  } | null;
  updatedAt?: IsoDateTime;
}

export interface CheckoutEnvelope {
  subscriptionId: Id;
  status: "incomplete";
  checkout: { kind: "redirect"; url: string; expiresAt: IsoDateTime };
  paymentMethodKind: PaymentMethodKind;
  amountMinor: number;
  currency: "INR";
  requiresReauthorization?: boolean;
  notice?: string;
}

export type TransactionKind =
  "authorization" | "charge" | "refund" | "chargeback" | "credit" | "adjustment";
export type FailureCategory =
  "insufficient_funds" | "mandate_revoked" | "auth_required" | "technical";

export interface BillingTransaction {
  id: Id;
  kind: TransactionKind;
  status: "initiated" | "pending" | "succeeded" | "failed" | "cancelled" | "refunded";
  amountMinor: number;
  currency: "INR";
  occurredAt: IsoDateTime;
  settledAt: IsoDateTime | null;
  periodCovered: { start: IsoDateTime; end: IsoDateTime } | null;
  invoiceNumber: string | null;
  /** Branch on `category` ONLY. providerCode is never exposed. */
  failure: { category: FailureCategory; message: string; retryable: boolean } | null;
}

export interface EntitlementState {
  key: string;
  limit: number | null;
  effectiveLimit: number | null;
  used?: number;
  remaining?: number;
  enabled?: boolean;
  periodKey?: PeriodKey;
  resetPeriod: ResetPeriod;
  resetsAt: IsoDateTime | null;
  scope: EntitlementScope;
  enforcement: Enforcement;
  unlimited: boolean;
  grants?: { delta: number; source: string; validUntil: IsoDateTime | null }[];
  thresholdCrossed: 80 | 95 | 100 | null;
  display: string;
}

export interface Entitlements {
  activePlanKey: string;
  subscribedPlanKey: string;
  subscriptionStatus: SubscriptionStatus;
  blockReason: "plan_limit" | "payment_downgrade" | null;
  entitlements: EntitlementState[];
  computedAt: IsoDateTime;
}

/* ─────────────────────────── events ─────────────────────────── */

export type EventStatus = "draft" | "published" | "live" | "ended" | "archived" | "deleting";
export type EventRole = "organizer" | "co_organizer";

export interface EventCounters {
  imageCount: number;
  processedImageCount: number;
  failedImageCount: number;
  attendeeCount: number;
  matchCount: number;
  storageBytes: number;
  approximate: true; // always true — $inc caches, reconciled nightly
}

export interface AccessLink {
  slug: string;
  active: boolean;
  shareUrl: string;
  qrUrl: string | null;
  scanCount: number;
  createdAt: IsoDateTime;
  revokedAt: IsoDateTime | null;
}

export interface EventSummary {
  id: Id;
  name: string;
  status: EventStatus;
  startAt: IsoDateTime;
  endAt: IsoDateTime;
  displayTimeZone: IanaTimeZone;
  uploadWindowEndsAt: IsoDateTime;
  retentionExpiresAt: IsoDateTime;
  coverThumbnailUrl: string | null;
  counters: EventCounters;
  myRole: EventRole;
  shareUrl: string;
  createdAt: IsoDateTime;
}

export type PipelineStatus = "idle" | "indexing" | "indexed" | "delayed" | "partial_failure";

export interface EventDetail extends EventSummary {
  description: string | null;
  logoUrl: string | null;
  watermarkUrl: string | null;
  thumbnailPreset: string;
  accessLinks: AccessLink[];
  members: { userId: Id; displayName: string; role: EventRole; status: "active" | "removed" }[];
  windows: {
    uploadOpen: boolean;
    uploadClosesAt: IsoDateTime;
    uploadClosesInHours: number;
    galleryExpiresAt: IsoDateTime;
    canExtendUploadWindow: boolean;
  };
  entitlementUsage: { key: string; limit: number | null; used: number; remaining: number | null }[];
  pipeline: {
    status: PipelineStatus;
    queuedCount: number;
    processingCount: number;
    failedCount: number;
    percentComplete: number;
    lastIndexedAt: IsoDateTime | null;
    delayed: boolean;
  };
  createdByUserId: Id;
  updatedAt: IsoDateTime;
  schemaVersion: number;
}

/* ─────────────────────────── uploads & media ─────────────────────────── */

export interface UploadConfig {
  multipartThresholdBytes: number;
  partSizeBytes: number;
  maxFileBytes: number;
  maxBatchSize: number;
  supportedMimeTypes: string[];
  presignTtlSeconds: number;
  maxConcurrentParts: number;
  hashAlgorithm: "sha256";
}

export type ResolutionState = "completed" | "in_progress" | "not_found" | "rejected";

export type BatchResolution =
  | { state: "completed"; assetId: Id; eventImageId: Id | null; linked: boolean; bytes: number }
  | {
      state: "in_progress";
      uploadId: string;
      mode: "single" | "multipart";
      uploadedPartNumbers: number[];
      uploadedBytes: number;
    }
  | { state: "not_found"; mode: "single" | "multipart" }
  | { state: "rejected"; reason: string; message: string };

export interface BatchResolveResponse {
  batchId: string;
  uploadWindowOpen: boolean;
  resolutions: Record<Sha256Hex, BatchResolution>;
  quota: {
    storage: { remainingBytes: number; requestedBytes: number; sufficient: boolean };
    images: { remaining: number; requested: number; sufficient: boolean };
  };
}

export interface PresignEnvelope {
  uploadSessionId: Id;
  method: "PUT";
  url: string; // opaque — never contains bucket/key
  headers: Record<string, string>;
  expiresAt: IsoDateTime;
  completeUrl: string;
}

export interface MultipartCreated {
  uploadSessionId: Id;
  uploadId: string;
  key: string; // OPAQUE server handle, not the R2 key
  partSizeBytes: number;
  partCount: number;
  resumed: boolean;
}

/** S3-shaped on purpose — Uppy consumes these verbatim. */
export interface UploadedPart {
  PartNumber: number;
  ETag: string;
  Size?: number;
}

export type ProcessingStatus = "queued" | "processing" | "done" | "failed" | "skipped";

export interface EventImage {
  id: Id;
  sequence: number;
  thumbnailUrl: string;
  thumbnailUrlExpiresAt: IsoDateTime;
  width: number;
  height: number;
  orientation: number;
  bytes: number;
  contentType: string;
  faceCount: number;
  visibility: "visible" | "hidden";
  processing: {
    status: ProcessingStatus;
    attempts: number;
    finishedAt: IsoDateTime | null;
    durationMs: number | null;
    lastError: { code: string; message: string; retryable: boolean } | null;
  };
  uploadedByUserId: Id;
  uploadBatchId: string;
  createdAt: IsoDateTime;
}

export interface BatchStatus {
  batchId: string;
  phase: "uploading" | "processing" | "complete" | "complete_with_errors";
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  files: {
    total: number;
    uploaded: number;
    duplicatesSkipped: number;
    rejected: number;
    failedUpload: number;
  };
  pipeline: { queued: number; processing: number; done: number; failed: number };
  failures: {
    eventImageId: Id;
    fileName: string;
    code: string;
    message: string;
    retryable: boolean;
  }[];
  stalledSessions: {
    uploadSessionId: Id;
    fileName: string;
    uploadedBytes: number;
    totalBytes: number;
    abortDeadline: IsoDateTime;
  }[];
}

export interface SignedMediaUrl {
  imageId: Id;
  kind: "thumbnail" | "original";
  url: string;
  expiresAt: IsoDateTime;
}
export interface SignedUrlsResponse {
  urls: SignedMediaUrl[];
  denied: { imageId: Id; kind: "thumbnail" | "original"; code: ErrorCode }[];
}

/* ─────────────────────────── attendee ─────────────────────────── */

export interface PublicEvent {
  slug: string;
  event: {
    id: Id;
    name: string;
    startAt: IsoDateTime;
    endAt: IsoDateTime;
    displayTimeZone: IanaTimeZone;
    startAtLocal: string;
    logoUrl: string | null;
    organizerDisplayName: string;
    status: EventStatus;
  };
  gallery: {
    open: boolean;
    expiresAt: IsoDateTime | null;
    expiredAt?: IsoDateTime;
    imageCount: number;
    indexingComplete: boolean;
  };
  selfie: {
    acceptedMimeTypes: string[];
    maxBytes: number;
    livenessRequired: boolean;
    attemptsAllowed: number;
    attemptsUsed: number;
  };
  consent: {
    required: boolean;
    purpose: string;
    policyVersion: string;
    policyUrl: string;
    granted: boolean;
  };
  session: { kind: "anonymous" | "user"; hasProfile: boolean; canClaimByLogin: boolean };
}

export type ParticipationStatus =
  "no_selfie" | "selfie_pending" | "processing" | "ready" | "no_match" | "failed" | "withdrawn";

export interface Participation {
  profileId: Id;
  subject: { kind: "anonymous" | "user"; canClaimByLogin: boolean };
  status: ParticipationStatus;
  statusDetail: { code: string; message: string; remedy: string; canRetry: boolean } | null;
  selfie: {
    id: Id;
    accepted: boolean;
    previewUrl: string | null;
    liveness: { required: boolean; passed: boolean | null };
    quality: { accepted: boolean | null; rejectionReason: string | null };
    attemptsUsed: number;
    attemptsRemaining: number;
  } | null;
  matchCount: number;
  newMatchCount: number;
  lastMatchRunAt: IsoDateTime | null;
  indexingComplete: boolean;
  galleryUrl: string;
  galleryExpiresAt: IsoDateTime;
  /** Client MUST honour this. 2000 processing / 15000 ready / 60000 indexed. */
  pollIntervalMs: number;
  nextPollAfter: IsoDateTime;
}

export interface GalleryItem {
  matchId: Id;
  imageId: Id;
  thumbnailUrl: string;
  thumbnailUrlExpiresAt: IsoDateTime;
  width: number;
  height: number;
  orientation: number;
  aspectRatio: number;
  isNew: boolean;
  confidence: "strong" | "normal"; // raw similarity is NEVER exposed
  originalAvailable: boolean;
  createdAt: IsoDateTime;
}

export interface GalleryResponse extends Collection<GalleryItem> {
  summary: {
    matchCount: number;
    newMatchCount: number;
    hiddenCount: number;
    galleryExpiresAt: IsoDateTime;
    indexingComplete: boolean;
  };
}

export interface MyEvent {
  eventId: Id;
  eventName: string;
  organizerDisplayName: string;
  startAt: IsoDateTime;
  displayTimeZone: IanaTimeZone;
  slug: string;
  galleryUrl: string;
  coverThumbnailUrl: string | null;
  matchCount: number;
  newMatchCount: number;
  status: ParticipationStatus;
  galleryExpiresAt: IsoDateTime;
  expiringSoon: boolean;
}

/* ─────────────────────────── notifications ─────────────────────────── */

export type NotificationCategory =
  | "authentication"
  | "account"
  | "billing"
  | "usage"
  | "event"
  | "collaboration"
  | "pipeline"
  | "matching"
  | "compliance"
  | "platform_ops";

export type Severity = "critical" | "important" | "informational";
export type ChannelGroup = "in_app" | "email" | "mobile";
export type ResolvedChannel = "in_app" | "email" | "sms" | "whatsapp" | "push";
export type ActionState = "available" | "unavailable";

export interface NotificationAction {
  key: string;
  label: string;
  style: "primary" | "secondary" | "danger";
  state: ActionState; // may be briefly stale — always POST and trust the reply
}

export interface AppNotification {
  id: Id;
  typeKey: string;
  category: NotificationCategory | (string & {});
  severity: Severity | (string & {});
  /** PRE-RENDERED. Display verbatim. Do NOT re-render from typeKey + data. */
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  groupKey: string | null;
  groupCount: number; // live rolling counter, not a history
  actionTarget: { kind: string; id: Id; state: "open" | "resolved" } | null;
  actions: NotificationAction[];
  actionResolvedVia?: ResolvedVia | null;
  actionResolvedAt?: IsoDateTime | null;
  readAt: IsoDateTime | null;
  eventId: Id | null;
  tenantId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface NotificationFeed extends Collection<AppNotification> {
  summary: { unreadCount: number; unreadByCategory: Record<string, number> };
}

export interface UnreadCount {
  unreadCount: number;
  byCategory: Record<string, number>;
  highestSeverity: Severity | null;
  pollIntervalSeconds: number; // from platformSettings — honour it
  serverTime: IsoDateTime;
}

export interface NotificationActionResult {
  notificationId: Id;
  actionKey: string;
  outcome: "applied" | "already_resolved" | "unavailable";
  alreadyResolved: boolean;
  resolvedVia: ResolvedVia;
  targetState: string;
  actions: NotificationAction[];
  redirectUrl?: string;
  message?: string;
}

export type PreferenceValue = "on" | "off";
export type DigestCadence = "instant" | "quiet_period" | "daily" | "off";
export type PreferenceSource = "default" | "global" | "type" | "event" | "transactional";

export interface NotificationPreferences {
  global: Partial<Record<ChannelGroup, PreferenceValue>>;
  quietHours: { enabled: boolean; start: string; end: string; timeZone: IanaTimeZone };
  digest: Record<string, DigestCadence>;
  locale: Locale;
  byType: Record<string, Partial<Record<ChannelGroup, PreferenceValue>>>;
  byEvent: Record<Id, Partial<Record<ChannelGroup, PreferenceValue>>>;
  resolved: {
    category: NotificationCategory;
    label: string;
    types: {
      typeKey: string;
      label: string;
      channels: Partial<
        Record<
          ChannelGroup,
          {
            effective: PreferenceValue;
            optOutAllowed: boolean;
            source: PreferenceSource;
            resolvesTo?: ResolvedChannel;
            resolvesToReason?: string;
          }
        >
      >;
      transactional: boolean;
      severity: Severity;
    }[];
  }[];
  updatedAt: IsoDateTime;
}

export interface NotificationType {
  typeKey: string;
  category: NotificationCategory;
  label: string;
  description: string;
  audiences: string[];
  channelGroups: {
    group: ChannelGroup;
    enabled: boolean;
    optOutAllowed: boolean;
    candidates?: ResolvedChannel[];
    strategy?: "first_eligible";
  }[];
  transactional: boolean;
  severity: Severity;
  respectQuietHours: boolean;
  throttle: { strategy: "none" | "rate_limit" | "digest"; [k: string]: unknown };
  dedupe: { keyTemplate: string | null; windowHours: number | null };
  actionable: boolean;
  enabled: boolean;
  version: number;
}

export type SkipReason =
  | "user_opt_out"
  | "no_verified_contact"
  | "suppressed"
  | "throttled"
  | "deduped"
  | "type_disabled"
  | "quiet_hours_deferred";

export interface NotificationDispatch {
  id: Id;
  userId: Id;
  typeKey: string;
  channelGroup: ChannelGroup;
  channel: ResolvedChannel;
  status: "queued" | "sent" | "delivered" | "failed" | "skipped" | "bounced";
  skipReason: SkipReason | null;
  contactHashPrefix: string;
  templateVersion: number | null;
  dedupeKey: string | null;
  providerRef: { provider: string; env: string; messageId: string } | null;
  attempts: number;
  lastError: { code: string; message: string } | null;
  queuedAt: IsoDateTime;
  sentAt: IsoDateTime | null;
  deliveredAt: IsoDateTime | null;
  failedAt: IsoDateTime | null;
  notificationId: Id | null;
  eventId: Id | null;
}

/* ─────────────────────────── compliance ─────────────────────────── */

export interface DataSubjectRequest {
  id: Id;
  requestType: "access" | "erasure" | "rectification" | "portability" | "consent_withdrawal";
  regulation: "gdpr" | "dpdpa";
  status: "received" | "verifying" | "in_progress" | "completed" | "rejected";
  slaDueAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  acknowledgement?: string;
  /** The evidence. Counts are mandatory. */
  executionLog: { step: string; count: number; at: IsoDateTime }[];
  export: {
    url: string;
    expiresAt: IsoDateTime;
    downloadsRemaining: number;
    bytes: number;
    format: string;
  } | null;
  rejectionReason?: string | null;
}

/* ─────────────────────────── machine-to-machine ─────────────────────────── */

export interface DomainEventInput {
  eventKey: string;
  tenantId: Id | null;
  actorRef: { kind: "user" | "admin" | "system"; id: string };
  subjectRef: { kind: string; id: string };
  payload: Record<string, unknown>; // identifiers only — never contacts, tokens or vectors
  occurredAt: IsoDateTime;
  dedupeKey?: string;
}

export interface QueueEnvelope {
  v: 1;
  kind: "event_image" | "selfie" | "match_incremental";
  id: Id;
  tenantId: Id;
  eventId: Id;
  priority: "high" | "normal";
  spaceKey: string;
  enqueuedAt: IsoDateTime;
  attempt: number;
  traceId: string;
}

export interface CronResult {
  job: string;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  durationMs: number;
  scanned: number;
  affected: number;
  skipped: number;
  errors: number;
  hasMore: boolean;
  details?: Record<string, unknown>;
}
```

---

## Appendix C — Route → collection/index map

Every read path must be served by an existing index. If a route here has no matching index, the route is wrong — not the schema.

| Route                                     | Collections                                                             | Index used                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /me`                                 | `user`, `userProfiles`, `tenantMembers`, `notifications`, `invitations` | `{userId:1}` unique · `{userId:1, status:1}` · `idx_user_unread` · `{"invitee.userId":1, status:1, createdAt:-1}` |
| `GET /me/notifications`                   | `notifications`                                                         | `{userId:1, createdAt:-1}`                                                                                        |
| `GET /me/notifications/unread-count`      | `notifications`                                                         | **`idx_user_unread`** partial on `readAt: null`                                                                   |
| `GET /me/notification-preferences`        | `notificationPreferences`, `notificationTypes`                          | `{userId:1}` unique · `{typeKey:1}` unique                                                                        |
| `POST /me/notifications/{id}/actions/{k}` | `notifications`, `invitations`                                          | `{"actionTarget.kind":1,"actionTarget.id":1}`                                                                     |
| `GET /me/invitations`                     | `invitations`                                                           | `{"invitee.userId":1, status:1, createdAt:-1}`                                                                    |
| `POST /invitations/{token}/accept`        | `invitations`                                                           | `{tokenHash:1}` unique                                                                                            |
| `GET /me/events`                          | `attendeeEventProfiles`                                                 | **`{"subject.userId":1, updatedAt:-1}`** (the one whitelisted cross-tenant read)                                  |
| `GET /tenants/{t}`                        | `tenants`                                                               | `_id`                                                                                                             |
| `GET /tenants/{t}/members`                | `tenantMembers`                                                         | `{tenantId:1, userId:1}` unique                                                                                   |
| `GET /tenants/{t}/subscription`           | `subscriptions`                                                         | **`{tenantId:1}` unique partial** on `status ∉ {cancelled,expired}`                                               |
| `GET /tenants/{t}/billing/transactions`   | `billingTransactions`                                                   | `{tenantId:1, occurredAt:-1}`                                                                                     |
| `GET /tenants/{t}/entitlements`           | `subscriptions`, `plans`, `usageCounters`, `entitlementGrants`          | `{tenantId:1, entitlementKey:1, periodKey:1}` unique · `{tenantId:1, entitlementKey:1, validFrom:1}`              |
| `GET /tenants/{t}/events`                 | `events`                                                                | `{tenantId:1, status:1, startAt:-1}`                                                                              |
| `GET /tenants/{t}/events/{e}/images`      | `eventImages`, `mediaAssets`                                            | **`{eventId:1, sequence:-1}`**                                                                                    |
| `GET .../images?status=failed`            | `eventImages`                                                           | `{eventId:1, "processing.status":1}`                                                                              |
| `GET .../uploads/batches/{b}`             | `uploadSessions`, `eventImages`                                         | `{eventId:1, batchId:1, status:1}`                                                                                |
| `POST .../uploads/batch-resolve`          | `mediaAssets`, `uploadSessions`                                         | **`{tenantId:1, contentHash:1}` unique** · `{tenantId:1, createdByUserId:1, contentHash:1}`                       |
| `POST .../uploads/.../complete`           | `mediaAssets`, `eventImages`, `usageCounters`                           | **`{eventId:1, assetId:1}` unique** (dedupe race guard)                                                           |
| `GET /p/events/{slug}`                    | `events`                                                                | **`{"accessLinks.slug":1}` unique partial** on `active: true`                                                     |
| `GET /p/events/{slug}/me`                 | `attendeeEventProfiles`, `selfies`                                      | `{eventId:1,"subject.userId":1}` / `{eventId:1,"subject.attendeeSessionId":1}` unique partial                     |
| `GET /p/events/{slug}/gallery`            | `faceMatches`, `eventImages`, `mediaAssets`                             | **`{profileId:1, createdAt:-1}`**                                                                                 |
| gallery "New" badge                       | `faceMatches`                                                           | `{profileId:1, seenAt:1, createdAt:-1}` partial on `seenAt: null`                                                 |
| `POST /p/events/{slug}/selfies`           | `selfies`, `attendeeEventProfiles`, `consents`                          | `{profileId:1, isActive:1}`                                                                                       |
| worker match query                        | `imageFaces`                                                            | **`$vectorSearch`** on `vectors.<space>`, filters `eventId` + `createdAt`                                         |
| worker match write                        | `faceMatches`                                                           | **`{profileId:1, imageId:1, faceIndex:1}` unique** (idempotency)                                                  |
| worker claim                              | `eventImages` / `selfies`                                               | `{"processing.status":1,"processing.leaseExpiresAt":1}`                                                           |
| pipeline sweep step 4                     | `attendeeEventProfiles`                                                 | `{eventId:1, status:1, lastMatchRunAt:1}`                                                                         |
| notification fan-out                      | `domainEvents`                                                          | `{"dispatch.notifications":1, occurredAt:1}` partial on `pending`                                                 |
| digest flush cron                         | `notificationDigests`                                                   | `{status:1, flushAt:1}` partial on `open`                                                                         |
| dedupe enforcement                        | `notificationDispatches`                                                | **`{dedupeKey:1}` unique partial** on `dedupeKey != null`                                                         |
| delivery receipt webhook                  | `notificationDispatches`                                                | `{"providerRef.provider":1,"providerRef.messageId":1}`                                                            |
| payment webhook                           | `providerWebhookEvents`, `subscriptions`                                | **`{provider:1, providerEventId:1}` unique** · `{"externalRefs.provider":1,"externalRefs.id":1}`                  |
| dunning cron                              | `subscriptions`                                                         | `{status:1, gracePeriodEndsAt:1}` partial on `past_due`                                                           |
| renewal reminders                         | `subscriptions`                                                         | `{status:1, nextChargeAt:1}`                                                                                      |
| window/retention crons                    | `events`                                                                | `{status:1, uploadWindowEndsAt:1}` · `{status:1, retentionExpiresAt:1}`                                           |
| invitation expiry cron                    | `invitations`                                                           | `{status:1, expiresAt:1}` partial on `pending`                                                                    |
| `GET /admin/notification-dispatches`      | `notificationDispatches`                                                | `{userId:1, queuedAt:-1}` · `{typeKey:1, channel:1, queuedAt:-1}`                                                 |
| `GET /admin/audit-logs`                   | `auditLogs`                                                             | `{tenantId:1, at:-1}` · `{"actor.id":1, at:-1}` · `{action:1, at:-1}`                                             |
| `GET /tenants/{t}/analytics`              | `analyticsDaily`                                                        | `{"scope.kind":1,"scope.id":1, dateKey:-1}` unique                                                                |

---

## Appendix D — Authorization matrix

Rows are the **derived** role for the resource in question. Roles are re-read from `eventMembers` / `tenantMembers` on every request — never cached in the session, never stored on a notification type (notification §2).

| Capability                      | organizer | co_organizer | tenant owner/admin | tenant member | attendee (identified) | attendee (anon) |  platform admin  |
| ------------------------------- | :-------: | :----------: | :----------------: | :-----------: | :-------------------: | :-------------: | :--------------: |
| View tenant dashboard           |    ✅     |      —       |         ✅         |      ✅       |           —           |        —        |    ✅ (read)     |
| Edit tenant settings            |     —     |      —       |         ✅         |       —       |           —           |        —        |        ✅        |
| **View billing / invoices**     |    ✅¹    |    **❌**    |         ✅         |       —       |           —           |        —        |        ✅        |
| **Purchase / upgrade / cancel** |    ✅¹    |    **❌**    |     ✅ (owner)     |       —       |           —           |        —        |       ❌²        |
| Create event                    |    ✅     |      —       |         ✅         |      ✅       |           —           |        —        |       ❌²        |
| Edit event details              |    ✅     |      ✅      |         —          |       —       |           —           |        —        |        ✅        |
| Publish event                   |    ✅     |      ✅      |         —          |       —       |           —           |        —        |        —         |
| Rotate access link              |    ✅     |    **❌**    |         —          |       —       |           —           |        —        |        ✅        |
| Delete / archive event          |    ✅     |    **❌**    |         —          |       —       |           —           |        —        | ✅ (with reason) |
| Extend upload window            |    ✅     |      ❌      |         —          |       —       |           —           |        —        |        ✅        |
| Upload images                   |    ✅     |      ✅      |         —          |       —       |           —           |        —        |        ❌        |
| Hide / delete an image          |    ✅     |      ✅      |         —          |       —       |           —           |        —        |        ✅        |
| Invite co-organizer             |    ✅     |    **❌**    |         —          |       —       |           —           |        —        |        —         |
| Remove co-organizer             |    ✅     |      ❌      |         —          |       —       |           —           |        —        |        ✅        |
| View event images (full)        |    ✅     |      ✅      |         —          |       —       |          ❌           |       ❌        |        ✅        |
| Upload selfie                   |     —     |      —       |         —          |       —       |          ✅           |       ✅        |        —         |
| View own gallery                |     —     |      —       |         —          |       —       |          ✅           |       ✅        |        —         |
| Download own originals          |     —     |      —       |         —          |       —       |          ✅³          |       ✅³       |        —         |
| Claim anonymous session         |     —     |      —       |         —          |       —       |          ✅           |        —        |        —         |
| Manage own notification prefs   |    ✅     |      ✅      |         ✅         |      ✅       |          ✅           |     **❌**⁴     |        ✅        |
| File a DSR                      |    ✅     |      ✅      |         ✅         |      ✅       |          ✅           |       ✅⁵       |        ✅        |
| Edit plans / prices             |     —     |      —       |         —          |       —       |           —           |        —        |        ✅        |
| Edit notification catalogue     |     —     |      —       |         —          |       —       |           —           |        —        |        ✅        |
| View dispatch forensics         |     —     |      —       |         —          |       —       |           —           |        —        |        ✅        |
| Promote a face model            |     —     |      —       |         —          |       —       |           —           |        —        |        ✅        |

¹ Only when the organizer is also the tenant's `billingContactUserId` (they are the same person today).
² Platform admins may create manual/Enterprise subscriptions via `/admin`, but never transact on a tenant's behalf through the self-serve endpoints.
³ Subject to the event's plan granting `originals.download`.
⁴ Anonymous attendees have no verified contact and are deliberately unreachable by notifications (notification §2) — there is nothing to configure.
⁵ Scoped to the attendee session's `eventIds`, verified by the session token.

**Billing is never visible to co-organizers.** Notification §2 and §4.3: it is not their plan and not their money. Any endpoint under `/tenants/{t}/billing/**` must check `tenantMembers` role, not `eventMembers`.

---

## Appendix E — Polling & cache policy

The system has **no realtime transport** (Vercel → no long-lived connections). Polling is the transport, and its cadence is server-controlled so it can be tuned without a client deploy.

| Surface                           | Endpoint                             | Interval          | Stop condition                             | Server field          |
| --------------------------------- | ------------------------------------ | ----------------- | ------------------------------------------ | --------------------- |
| Notification badge                | `GET /me/notifications/unread-count` | **30 s**          | tab hidden                                 | `pollIntervalSeconds` |
| Notification panel (open)         | `GET /me/notifications`              | 15 s              | panel closed                               | —                     |
| Attendee status (processing)      | `GET /p/events/{slug}/me`            | **2 s**           | `status != "processing"`                   | `pollIntervalMs`      |
| Attendee status (ready, indexing) | same                                 | 15 s              | `indexingComplete: true`                   | `pollIntervalMs`      |
| Attendee status (settled)         | same                                 | 60 s              | page unmount                               | `pollIntervalMs`      |
| Upload batch progress             | `GET .../uploads/batches/{id}`       | 3 s               | `phase ∈ {complete, complete_with_errors}` | —                     |
| Event pipeline                    | `GET .../events/{id}`                | 10 s              | `pipeline.status ∈ {indexed, idle}`        | —                     |
| Checkout return                   | `GET /tenants/{t}/subscription`      | 2 s, ceiling 60 s | `status != "incomplete"`                   | —                     |
| Download job                      | `GET /p/downloads/{id}`              | 3 s               | `status ∈ {ready, failed, expired}`        | `pollIntervalMs`      |
| Admin pipeline health             | `GET /admin/pipeline/health`         | 30 s              | tab hidden                                 | —                     |

**Mandatory client behaviour**

1. **Pause on `document.visibilityState !== "visible"`.** Non-negotiable.
2. **Honour the server-supplied interval** where one is returned. Hard-coded intervals are a contract violation.
3. **Exponential backoff on `5xx`** — ×2 up to 5 minutes, reset on success.
4. **On `429`, obey `Retry-After` exactly.** Never retry sooner.
5. **Use `If-None-Match` on `unread-count`** and treat `304` as "no change, no re-render".
6. **Single shared poller per surface per tab.** Two components polling the same endpoint is a bug; use one subscription with fan-out.

**Cache-Control by endpoint**

| Endpoint                      | Header                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /plans`                  | `public, max-age=300` + `ETag`                                                                                                                       |
| `GET /legal/policies/current` | `public, max-age=3600`                                                                                                                               |
| `GET /notification-types`     | `private, max-age=600`                                                                                                                               |
| `GET /uploads/config`         | `private, max-age=300`                                                                                                                               |
| `GET /p/events/{slug}`        | `private, max-age=30`                                                                                                                                |
| **everything else**           | `no-store`                                                                                                                                           |
| `pic.openpic.in/t/*`          | `Cloudflare-CDN-Cache-Control: public, max-age=2678400, stale-while-revalidate=86400, stale-if-error=604800` · `Cache-Control: public, max-age=3600` |
| `pic.openpic.in/o/*`          | `Cloudflare-CDN-Cache-Control: public, max-age=604800, stale-while-revalidate=21600, stale-if-error=86400` · `Cache-Control: public, max-age=300`    |

> A future SSE/Pusher transport changes only _how the client learns to refetch_. The endpoints, indexes, DTOs and components above stay identical (notification §19.4). Do not design around WebSockets.

---

## Appendix F — Implementation checklist

Ordered so that each phase is independently shippable and testable.

<details open>
<summary><strong>Phase 0 — Foundations (blocks everything)</strong></summary>

- [ ] Seed `plans` (4 tiers, self-describing `entitlements`, embedded `prices`).
- [ ] Seed `platformSettings` singleton. **Audit the codebase for hard-coded numbers and replace every one with a settings read.**
- [ ] **Seed `notificationTypes` — all 81 keys from §7.6, with `channelGroups` transcribed verbatim from notification §4.** This _is_ the routing implementation; there is no routing code to write.
- [ ] Seed `notificationTemplates` for every `(typeKey, channel, locale)` where the channel is enabled, with `variables[]` populated.
- [ ] Create every index in schema §21, **including the partial and unique ones** (`idx_user_unread`, `{dedupeKey:1}` unique partial, one-organizer-per-event, one-live-subscription-per-tenant, `{eventId:1, assetId:1}`, `{profileId:1, imageId:1, faceIndex:1}`, `{provider:1, providerEventId:1}`, `{"accessLinks.slug":1}` active-only).
- [ ] Create the Atlas `vectorSearch` index with `quantization: "scalar"` and **both** filter fields (`eventId`, `createdAt`).
- [ ] Implement the repository layer: `repo(tenantId).collection(x)` injecting `tenantId` into every filter and document.
- [ ] Add the **lint rule** blocking direct `db.collection(...)` on tenant-scoped collections.
- [ ] Whitelist and unit-test the single cross-tenant read (`attendeeEventProfiles` by `subject.userId`).
- [ ] Implement the error envelope, `requestId` propagation, and the `code` catalogue from Appendix A.
- [ ] Implement `idempotencyKeys` middleware with all five semantics from §0.9.
- [ ] Implement rate limiting per §0.11.
- [ ] **Add the three CI assertions:** exactly 3 transport workflows with 1 step each; response-schema tests asserting the §0.15 never-return rules; `no-restricted-imports` on the dunning module.

</details>

<details>
<summary><strong>Phase 1 — Identity, tenancy, notifications</strong></summary>

- [ ] Configure Better Auth plugins (`emailOTP`, `phoneNumber`, `twoFactor`, `admin`).
- [ ] Implement **all seven** Better Auth hooks from §1.1, including the lazy-invite hook.
- [ ] `emitDomainEvent()` + the `domainEvents` outbox consumer with per-consumer `dispatch.*` flags.
- [ ] `resolveChannel()` as a **pure function** of (type row, preference doc, user profile, suppression list) — unit-tested with zero network, covering all seven `skipReason` values.
- [ ] Notification fan-out worker: resolve recipients from `eventMembers`/`tenants` **at send time**, render, dispatch, **persist every skip**.
- [ ] Dedupe via the unique index (not application logic). Digest buckets with `flushAt` push-forward capped at `firstItemAt + hardFlushHours`.
- [ ] In-app aggregation upsert with **`readAt: null` in the filter** (so a read row never resurrects).
- [ ] `MessageTransport` adapter + three pass-through Novu workflows. **Nothing else in Novu.**
- [ ] `/me/*`, `/tenants/*`, invitations (all six routes), `/me/notifications/*`, preferences, unsubscribe.
- [ ] Test the cross-channel idempotency matrix: email×2, email-then-in-app, revoked-then-accept, expired-then-accept. All must be `200`/`410`, never `409`.

</details>

<details>
<summary><strong>Phase 2 — Billing</strong></summary>

- [ ] Payment adapter: `createMandate`, `chargeOnce`, `cancelMandate`, `fetchStatus`, `verifyWebhook`, `normalizeStatus`, `normalizeFailureCategory`.
- [ ] Webhook inbox with the 8-step order from §10.1. **Verify signature over raw bytes.**
- [ ] Generic `checkEntitlement()` — zero plan-name branches anywhere in domain code.
- [ ] Transactional entitlement-check + write + `$inc` (schema §23).
- [ ] Dunning + reminders + reconciliation crons.
- [ ] Verify the C6 invariant by test: run the dunning worker against a tenant with content, assert **zero** writes outside `subscriptions`.
- [ ] Verify `banner.reassurance` is present on every `past_due`/`downgraded` response.

</details>

<details>
<summary><strong>Phase 3 — Events, uploads, media</strong></summary>

- [ ] Event CRUD with materialised `uploadWindowEndsAt` / `retentionExpiresAt`.
- [ ] Access links + QR generation stored as `mediaAssets`.
- [ ] `batch-resolve` with correct scoping: tenant-wide for completed, per-user for in-progress.
- [ ] All six Uppy hook endpoints. **No Companion server.** `listParts` proxies R2 `ListParts` — **no `upload_parts` collection.**
- [ ] Opaque `key` handle mapping (never expose object keys).
- [ ] Cloudflare Worker: gateway (cache off) → `CachedMedia` (cache on) via `ctx.exports`, canonical cache key with `exp`/`sig` stripped.
- [ ] HMAC signer in Next.js with `CURRENT` + `PREVIOUS` secret support.
- [ ] Thumbnail processor: orientation-preserving resize, watermark, adaptive WebP quality, `processorVersion`/`watermarkVersion` metadata.
- [ ] Batch status endpoint + the five `upload.*` notification triggers.

</details>

<details>
<summary><strong>Phase 4 — Faces & attendee experience</strong></summary>

- [ ] `faceModels` registry seeded with the active recognition model, `spaceKey`, `vectorPath`, `thresholds`.
- [ ] Python worker: claim with lease, lease renewal, **abandon on `lease_lost`**, heartbeat, `/internal/domain-events`.
- [ ] `$vectorSearch` **inside MongoDB** — `exact: true`, `eventId` + `createdAt` filters, threshold and quality post-filters in the same pipeline. Assert by test that no candidate set is materialised in Python.
- [ ] `lastMatchRunAt = runStartedAt` (captured before the query). Test the gap case explicitly.
- [ ] Idempotent match upserts on `{profileId, imageId, faceIndex}`.
- [ ] Pipeline sweep, all four steps.
- [ ] Attendee surface: public event, consent gate, liveness, selfie, `/me` polling with adaptive interval, gallery with dimensions, seen, hide, claim, `/me/events`.
- [ ] `firstMatchNotifiedAt` guarantees `attendee.matches.ready` (and its SMS) fires **exactly once** per attendee+event.
- [ ] Assert `similarity` never appears in any attendee-facing response.

</details>

<details>
<summary><strong>Phase 5 — Admin & compliance</strong></summary>

- [ ] Admin 2FA gate; `auditLogs` on every admin mutation with required `reason`.
- [ ] Notification catalogue editor with `If-Match`, `version` bump, and the `/impact` pre-read.
- [ ] Dispatch forensics endpoint (the "why didn't they get it?" screen).
- [ ] Queue/pipeline health + model promotion with backfill-coverage guard.
- [ ] Admin subscription `PATCH` with the `forbidden_field` validator.
- [ ] DSR intake, execution with **counted** `executionLog`, export links.
- [ ] Retention purge job: ordered, counted, warning-preceded. **Never a TTL on media collections.**
- [ ] Tenant-isolation nightly audit.

</details>

---

## Appendix G — Open questions

Deliberately unresolved. Each has a **default the implementation should assume** so nothing blocks; revisit when the marked signal appears.

| #   | Question                                                                                   | Default for v1                                                                                                         | Revisit when                                                                                                               |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| G1  | Should attendees be able to download originals on the Free tier?                           | `originals.download.enabled: true` on `free`, `true` from `starter`.                                                   | Attendee-side conversion data exists.                                                                                      |
| G2  | Attendee gallery pagination size — 40 is a guess balancing thumbnail bytes against scroll. | 40, max 100.                                                                                                           | Real p95 gallery sizes are measured.                                                                                       |
| G3  | Does `attendee.matches.new` digest cadence default to `quiet_period` or `daily`?           | `quiet_period` (15 min quiet, 6 h hard flush, ≤3 emails/day/event).                                                    | Email complaint or unsubscribe rate on the type rises.                                                                     |
| G4  | Should the organizer get a per-attendee view (who matched, how many)?                      | **No** — privacy default. Aggregate counts only.                                                                       | An organizer explicitly requests it _and_ legal signs off.                                                                 |
| G5  | Proration credit on upgrade.                                                               | None. Full new-plan charge immediately (billing §4.5).                                                                 | Upgrade abandonment correlates with the charge.                                                                            |
| G6  | Yearly billing.                                                                            | Deferred. Schema and API already support it — one `prices[]` push.                                                     | Pricing decides.                                                                                                           |
| G7  | WhatsApp (phase 2).                                                                        | `whatsappCapable: null` for everyone, so `mobile` resolves to `sms`. No routing or preference change needed to enable. | Meta template approval is in hand.                                                                                         |
| G8  | Push notifications (phase 3).                                                              | `push` reserved in the channel enum; `pushTokens` endpoints stubbed.                                                   | A mobile client exists.                                                                                                    |
| G9  | Multi-seat tenants / ownership transfer.                                                   | `tenantMembers` exists with one member; `POST /tenants` reserved for v2.                                               | An agency customer appears.                                                                                                |
| G10 | `exact: true` vs ANN for vector search.                                                    | ENN (`exact: true`), 100 % recall, no `numCandidates` tuning. Switch is one `platformSettings.face.exactSearch` flag.  | Per-event face counts approach the high hundreds of thousands.                                                             |
| G11 | Realtime transport.                                                                        | 30 s polling.                                                                                                          | Users complain about badge latency. Endpoints and DTOs do not change.                                                      |
| G12 | Per-tenant notification policy (an admin muting a type for their whole workspace).         | Not supported. Preferences are per-user at three scopes.                                                               | A workspace customer asks. Would be a **new** collection, not a change to `notificationPreferences`.                       |
| G13 | Localisation beyond `en-IN`.                                                               | Single locale; `locale` plumbed end-to-end so adding one is a `notificationTemplates` insert.                          | A non-English market is targeted.                                                                                          |
| G14 | Immediate media-URL revocation (currently signed URLs live until expiry).                  | Short TTLs (24 h thumbnail, 15 min original) are the revocation window.                                                | A legal or abuse case demands sub-minute revocation → add a version field to the signed token and validate it at the edge. |

---

## Contract change log

| Version | Date       | Change                                                                                                                                                                                  |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0   | 2026-09-25 | Initial contract. Derived from Notification Design & MongoDB Schema Design v2.0 (final), Subscription Billing Architecture, R2/Cloudflare Media Delivery, and Resumable Upload Spec v2. |

## Authority reminder

> This contract is **derived from** the notification design and MongoDB schema design. Those documents are final and take precedence. If an implementer finds a conflict — a field name, an enum value, an index, a channel routing rule, a `typeKey` — **the schema and notification design win, and this contract is amended to match.** Do not amend the schema to match this document.
