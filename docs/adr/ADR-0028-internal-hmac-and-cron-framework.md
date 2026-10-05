# ADR-0028 — Internal HMAC auth and the bounded cron job framework

- **Status:** Accepted · **Date:** 2026-10-05
- **Card:** OP-87 `t_50e5932b` (phase 1-Identity, epic M2M Auth, RED) ·
  **Implements:** contract §0.3 (`internal` label) and §10.2 (cron endpoints) ·
  **Depends on:** OP-86 (auth guards)
- **Supersedes / amends:** nothing. Pins the contract the OP-87 GREEN
  implementer must satisfy.

## Context

OP-86 landed one uniform enforcement point per auth label, but deliberately left
the `internal` label unimplemented (`requireAuth("internal", …)` throws
`not_implemented`). Contract §0.3 defines `internal` as a shared secret plus an
HMAC over the raw body with a ±300 s timestamp window, and §10.2 defines every
cron endpoint as idempotent, concurrency-safe, bounded (a `?limit=` clamped to a
per-job maximum) and observable (a structured `CronResult`).

OP-87 closes both: authentication for machine-to-machine callers (cron jobs and
the Python worker), and a framework so each cron job cannot forget the limit,
the timing or the summary log.

## Decision

### 1. Two pure modules, no HTTP required to test the policy

**`@/server/auth/internal-hmac`**

```ts
type InternalAuthCode = "internal_auth_failed" | "invalid_signature" | "stale_signature";
type InternalAuthResult = { ok: true } | { ok: false; code: InternalAuthCode };

verifyInternalSignature(input: {
  secret: string;
  body: string;
  signature: string | null;   // raw X-Signature, "sha256=<hex>"
  timestamp: string | null;   // raw X-Timestamp, epoch SECONDS as a string
  now: Date;
  maxSkewSeconds?: number;    // default 300
}): InternalAuthResult;

authorizeInternalRequest(input: {
  method: string;
  path: string;
  authorization: string | null;
  signature: string | null;
  timestamp: string | null;
  body: string;
  now: Date;
  internalApiSecret: string;
  cronSecret: string;
  maxSkewSeconds?: number;
}): InternalAuthResult;

internalAuthStage(options: {
  internalApiSecret: string;
  cronSecret: string;
  clock?: Clock;              // injected so replay/skew tests are deterministic
  maxSkewSeconds?: number;    // default 300
}): RouteStage;
```

`verifyInternalSignature` is the crypto: constant-time compare of
HMAC-SHA256(secret, raw body) against the `sha256=<hex>` header, plus the ±300 s
timestamp window. It never throws; every failure is a stable code.

`authorizeInternalRequest` adds the bearer check and the cron exception:
`GET` under `/api/v1/internal/cron/**` may carry `Authorization: Bearer <CRON_SECRET>`
with an empty, unsigned body (Vercel Cron issues GETs and cannot sign a body).
A `CRON_SECRET` bearer outside the cron prefix is refused, so the exception
cannot be replayed against `/internal/domain-events` or `/internal/worker/*`.
Everything else needs `Bearer <INTERNAL_API_SECRET>` plus a valid signature.

`internalAuthStage` is the `defineRoute` pipeline stage that reads the raw body
once (`request.clone().text()`), calls `authorizeInternalRequest` with the
configured secrets and the injected clock, and on denial logs one `warn` line
(never the secret or the signature) and throws the catalogue `AppError`
(`401` for all three codes).

**`@/server/jobs/cron-job`**

```ts
clampLimit(
  requested: string | number | null | undefined,
  bounds: { defaultLimit: number; maxLimit: number }
): number;

interface CronJobContext { limit: number; clock: Clock; logger: Logger }
interface CronRunOutcome {
  scanned: number; affected: number; skipped: number;
  errors: number; hasMore: boolean; details?: Record<string, unknown>;
}
interface CronJob {
  name: string; defaultLimit: number; maxLimit: number;
  run(options: {
    requestedLimit?: string | number | null;
    clock: Clock;
    logger: Logger;
  }): Promise<CronResult>;
}
defineCronJob(definition: {
  name: string; defaultLimit: number; maxLimit: number;
  run(ctx: CronJobContext): Promise<CronRunOutcome>;
}): CronJob;
```

`run` clamps `requestedLimit` to `maxLimit` (falling back to `defaultLimit` for
absent/invalid/`<= 0` values), times the run through the **injected** `Clock`
(`startedAt` / `finishedAt` / `durationMs`), wraps the outcome in the §10.2
`CronResult` shape, and logs one `cron.<name>.completed` summary at `info` —
`error` when `errors > 0`.

### 2. `X-Timestamp` is epoch seconds

The contract says "±300 s" but not the encoding. Epoch **seconds** as a decimal
string is pinned because it is the Vercel/Cron-friendly form and is what the
known-answer vector is built against. ISO-8601 would work equally well; a future
story can accept both, but OP-87 accepts one form so the boundary is exact.

### 3. Three new client-facing error codes

`internal_auth_failed`, `invalid_signature`, `stale_signature` are appended to
`API_ERROR_CODES` in `@openpic/contracts` (a new append-only
`INTERNAL_ERROR_CODES` set, mirroring the `AUTH_ERROR_CODES` split OP-86 chose in
ADR-0025 §A) and transported as `401` (non-retryable) from the server catalogue.
They are appended, never inserted, so the closed enum stays backward compatible.

### 4. The sample cron route is `/api/v1/internal/cron/sample`

No cron endpoint exists yet, so E1 needs one real guarded route to prove the
stage is wired into Next.js (an unbuilt route answers `404`, not `401`).
OP-87 GREEN must add `apps/web/src/app/api/v1/internal/cron/sample/route.ts`
exporting `GET` and `POST`, guarded by `internalAuthStage` and running a `sample`
job defined with `defineCronJob`. It is a framework proving-ground, not a
contract §10.2 domain job; domain jobs land in their own stories and extend the
same `defineCronJob` call. E1 only exercises the unauthenticated branch (the
per-run `CRON_SECRET` is generated by the e2e launcher and unavailable to the
spec).

## Consequences

- The policy is testable without an HTTP server, a clock or a database: U1–U4
  drive the pure functions, U5–U6 drive the framework with `fixedClock` and a
  memory logger, I1–I3 drive the real `defineRoute` pipeline in-process, and E1
  drives the deployed route.
- The RED suite fails for the right reason today: `@/server/auth/internal-hmac`
  and `@/server/jobs/cron-job` do not exist (module-resolution failure) and
  `/api/v1/internal/cron/sample` is `404`.
- Cron jobs cannot emit notifications inline: the `defineCronJob` contract has
  no notification dependency, and the import-boundary lint on
  `src/server/jobs/**` enforces it. Jobs write `domainEvents`; the fan-out
  consumer delivers.
- The `internal` label stays a dedicated stage rather than a new branch inside
  `requireAuth`: `requireAuth`'s options carry no secrets, and the ban / 2FA /
  completion policy in `@/server/auth/guards` is irrelevant to a machine caller.

## Alternatives considered

- **Implement `internal` inside `requireAuth`.** Rejected: it would force secrets
  into `RequireAuthOptions` and mix the machine-caller crypto with the
  user-policy decision table OP-86 deliberately kept pure.
- **HMAC over `method + path + timestamp + body`.** Rejected for OP-87: the
  contract explicitly signs "the raw body"; binding the path is a stronger
  scheme but would break the documented `sha256=<hex of raw body>` vector.
- **ISO-8601 `X-Timestamp`.** Viable, but epoch seconds is the cron-native form
  and one encoding keeps the ±300 s boundary unambiguous.
- **Let each job clamp its own limit.** Rejected: §10.2's bound must be
  structural, not a rule each of ~25 jobs can forget.

## GREEN implementation notes (OP-87, card `t_723d932e`)

- **Modules landed.** `@/server/auth/internal-hmac` exports
  `verifyInternalSignature`, `authorizeInternalRequest`, `internalAuthStage`,
  `InternalAuthCode` and `InternalAuthResult`; `@/server/jobs/cron-job` exports
  `clampLimit`, `defineCronJob`, `cronResultSchema`, `CronResult`,
  `CronJobContext`, `CronRunOutcome`, `CronJob` and the run/definition option
  types. `INTERNAL_ERROR_CODES` was appended to `@openpic/contracts` and
  `INTERNAL_ERROR_TRANSPORT` (all `401`, non-retryable) to the server catalogue.
- **Cron exception is GET-only and malformed inputs are coded.** The bearer
  exemption requires `method === "GET"` under `/api/v1/internal/cron/`;
  a `CRON_SECRET` bearer on any other method/path is `internal_auth_failed`.
  A missing or non-numeric `X-Timestamp` is `stale_signature`; a missing or
  malformed `X-Signature` (no `sha256=`, wrong length, non-hex) is
  `invalid_signature`. The stage emits exactly one redacting `warn`
  (`internal.auth.denied`, reason code only) per denial.
- **Proving-ground route.** `apps/web/src/app/api/v1/internal/cron/sample/route.ts`
  exports `GET` and `POST`, both behind `internalAuthStage` and running a `sample`
  job declared with `defineCronJob`. It parses `?limit=` per request.
- **`vercel.json` is deliberately not added yet.** The sample route is a
  framework proving-ground that does no work, so scheduling it would burn
  invocations for nothing. The `crons` list is generated when the first real
  §10.2 domain job lands in its own story; the entry shape is
  `{ "path": "/api/v1/internal/cron/<job>", "schedule": "<cron>" }` under the
  Vercel project root.
- **Job import boundary registered.** The ESLint config now restricts
  `apps/web/src/server/jobs/**` from importing `@/server/notifications/**` and
  `@/server/adapters/**`, enforcing the domainEvents-only rule recorded in the
  consequences above.
