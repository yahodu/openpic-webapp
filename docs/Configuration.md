# Configuration

Every OpenPic setting comes from the environment. There are no config files and
no hard-coded values: the process validates `process.env` once, in
`apps/web/src/server/config/env.ts`, and fails fast with the **names** of the
offending keys (never their values). Runtime tunables — rate-limit numbers,
upload windows, feature switches — are **not** environment variables; they live
in the `platformSettings` document (see the
[API contract](API%20Contract.md)).

[`.env.example`](../.env.example) is the copy-paste template and carries one
line per variable:

```bash
cp .env.example .env      # .env is git-ignored — never commit a real secret
```

- `pnpm dev` / `pnpm build` + `pnpm start` load `.env` themselves (Next.js).
- The one-off scripts (`pnpm db:ensure-indexes`, `pnpm novu:*`) read
  `process.env` only, so export the file first:
  `set -a; . ./.env; set +a`.
- Quote a value that contains `&`, `#` or spaces, or the shell truncates it when
  the file is sourced — e.g. `MONGODB_URI="mongodb+srv://…?retryWrites=true"`.
- The test and e2e processes need no `.env` at all (see
  [Test and e2e processes](#test-and-e2e-processes)).

## Core

Always required. A missing or malformed value refuses to start.

| Variable                   | Local value in `.env.example` | Notes                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_ENV`                  | `development`                 | `development` / `test` / `e2e` / `staging` / `production`. Selects the strictness below.                                                                                                                                                               |
| `APP_BASE_URL`             | `http://localhost:3000`       | Absolute http(s) URL the server uses for its own links. No trailing slash.                                                                                                                                                                             |
| `PORT`                     | `3000`                        | HTTP port. Defaults to `3000` when unset.                                                                                                                                                                                                              |
| `ALLOWED_ORIGINS`          | `http://localhost:3000`       | Comma-separated browser origins allowed to call the API. At least one absolute http(s).                                                                                                                                                                |
| `TRUSTED_CLIENT_IP_HEADER` | —                             | **Required when `APP_ENV=production`.** Header a trusted edge overwrites with the client IP (`x-real-ip` on Vercel, `cf-connecting-ip` behind Cloudflare). Unset outside production keeps the fallback (`x-forwarded-for` leftmost, then `x-real-ip`). |

## Database

| Variable                              | Local value in `.env.example`       | Notes                                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URI`                         | `mongodb://localhost:27017/openpic` | Always required; must start with `mongodb://` or `mongodb+srv://`. **A replica set is required** — several paths use multi-document transactions, so a standalone `mongod` is not enough. The README has a Docker recipe. |
| `MONGODB_MAX_POOL_SIZE`               | `10`                                | Size of the shared connection pool.                                                                                                                                                                                       |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `5000`                              | Server-selection timeout.                                                                                                                                                                                                 |
| `MONGODB_CONNECT_TIMEOUT_MS`          | `10000`                             | Connection-establishment timeout.                                                                                                                                                                                         |
| `MONGODB_SOCKET_TIMEOUT_MS`           | `45000`                             | Socket inactivity timeout.                                                                                                                                                                                                |
| `ATLAS_SEARCH_ENABLED`                | `false`                             | `true` makes `pnpm db:ensure-indexes` create the Atlas vector-search index. Only meaningful on Atlas.                                                                                                                     |

## Authentication and signing secrets

`BETTER_AUTH_SECRET`, `INTERNAL_API_SECRET`, `CRON_SECRET`,
`UNSUBSCRIBE_SIGNING_SECRET` and `MEDIA_SIGNING_SECRET_CURRENT` are always
required. In `staging` and `production` each must be **at least 32 characters**;
`MEDIA_SIGNING_SECRET_PREVIOUS`, when set, must be too.

| Variable                        | Local value in `.env.example`                  | Notes                                                                           |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`            | `dev-better-auth-secret-0123456789abcdef`      | Session and auth signing.                                                       |
| `SESSION_TTL_SECONDS`           | `604800`                                       | Better Auth session lifetime. Defaults to 7 days.                               |
| `INTERNAL_API_SECRET`           | `dev-internal-api-secret-0123456789abcdef`     | HMAC for the internal `/api/v1/internal/*` surface.                             |
| `CRON_SECRET`                   | `dev-cron-secret-0123456789abcdefghijklmnop`   | Guards the scheduled/cron endpoints.                                            |
| `UNSUBSCRIBE_SIGNING_SECRET`    | `dev-unsubscribe-signing-secret-0123456789ab`  | Signs one-click unsubscribe links.                                              |
| `MEDIA_SIGNING_SECRET_CURRENT`  | `dev-media-signing-secret-0123456789abcdef`    | Signs media URLs.                                                               |
| `MEDIA_SIGNING_SECRET_PREVIOUS` | `dev-media-signing-secret-previous-0123456789` | Optional; keep the retired key here during a rotation so old URLs still verify. |

The development values in `.env.example` exist so a fresh clone boots. They are
public, not secrets — never reuse them in staging or production.

## Logging

| Variable                   | Local value in `.env.example`     | Notes                                                    |
| -------------------------- | --------------------------------- | -------------------------------------------------------- |
| `LOG_LEVEL`                | `info`                            | `fatal` / `error` / `warn` / `info` / `debug` / `trace`. |
| `LOG_TRANSPORTS`           | `stdout`                          | Comma-separated: `stdout`, `betterstack`.                |
| `LOG_PRETTY`               | `false`                           | `true` pretty-prints (development only).                 |
| `BETTERSTACK_SOURCE_TOKEN` | —                                 | Required when `LOG_TRANSPORTS` includes `betterstack`.   |
| `BETTERSTACK_INGEST_HOST`  | `https://in.logs.betterstack.com` | Ingest endpoint.                                         |

## Provider selection

Each provider defaults to `memory`, which is an in-process double: the app boots
and every route works with no vendor account. Select a real backend with the
variable below; the deployment then **fails closed** if that backend's
credentials are missing or blank.

| Variable              | Local value | Allowed values                   | Credentials required with a non-memory value                                                                                                                     |
| --------------------- | ----------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_PROVIDER` | `memory`    | `memory` / `redis`               | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                             |
| `STORAGE_PROVIDER`    | `memory`    | `memory` / `s3`                  | `R2_ENDPOINT`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_ORIGINALS`, `R2_BUCKET_THUMBNAILS`, `R2_BUCKET_EXPORTS`, `R2_BUCKET_BRANDING` |
| `QUEUE_PROVIDER`      | `memory`    | `memory` / `mongo`               | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`                                                                                                             |
| `PAYMENT_PROVIDER`    | `memory`    | `memory` / `stripe` / `cashfree` | Cashfree: the four `CASHFREE_*` values below. `stripe` has no adapter and refuses at boot.                                                                       |
| `MESSAGE_TRANSPORT`   | `memory`    | `memory` / `ses`                 | —                                                                                                                                                                |

In `production` a `memory` selection is refused for all five: a production
deployment must name a real backend.

### Provider credentials

| Variable                   | Notes                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | Upstash REST URL. Used by `redis` rate limiting and by a non-`memory` queue.                                                                      |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token, same two consumers.                                                                                                           |
| `RATE_LIMIT_SALT`          | Salt mixed into hashed rate-limit identities. Defaults to a development constant; set a strong value in production.                               |
| `R2_ENDPOINT`              | S3-compatible endpoint (Cloudflare R2 or any S3 API).                                                                                             |
| `R2_REGION`                | Bucket region (`auto` on R2).                                                                                                                     |
| `R2_ACCESS_KEY_ID`         | Access key id.                                                                                                                                    |
| `R2_SECRET_ACCESS_KEY`     | Secret access key.                                                                                                                                |
| `R2_BUCKET_ORIGINALS`      | Bucket for uploaded originals.                                                                                                                    |
| `R2_BUCKET_THUMBNAILS`     | Bucket for derivatives.                                                                                                                           |
| `R2_BUCKET_EXPORTS`        | Bucket for generated exports.                                                                                                                     |
| `R2_BUCKET_BRANDING`       | Bucket for branding assets.                                                                                                                       |
| `CASHFREE_CLIENT_ID`       | Cashfree client id.                                                                                                                               |
| `CASHFREE_CLIENT_SECRET`   | Cashfree client secret.                                                                                                                           |
| `CASHFREE_API_VERSION`     | Cashfree API version sent as the pinned `x-api-version` header.                                                                                   |
| `CASHFREE_WEBHOOK_SECRET`  | Verifies Cashfree webhook signatures.                                                                                                             |
| `CASHFREE_LIVE_PLAN_ID`    | Only for the `CASHFREE_LIVE_TEST=1`-gated sandbox contract test (OP-105, ADR-0382). The runtime never reads it.                                   |
| `NOVU_BASE_URL`            | Novu API origin. Defaults to `https://api.novu.co`.                                                                                               |
| `NOVU_API_KEY`             | Novu API key for the transport adapter and the `pnpm novu:*` scripts.                                                                             |
| `NOVU_WEBHOOK_SECRET`      | Svix signing secret for `POST /api/v1/webhooks/novu`. Blank refuses every receipt (fail-closed), so set it wherever message receipts are enabled. |
| `NOVU_TIMEOUT_MS`          | Novu request timeout. Defaults to `10000`.                                                                                                        |

## Test and e2e processes

Neither suite reads `.env`, so a fresh clone can run both with no configuration.

| Variable          | Set by                                          | Purpose                                                                                               |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MONGO_TEST_URI`  | `apps/web/src/test/integration/global-setup.ts` | Connection string of the in-memory replica set the integration suite starts. Never set it by hand.    |
| `E2E_PORT`        | optional, `pnpm test:e2e`                       | Port of the `APP_ENV=e2e` server. Defaults to `3000`; set it in the shell to run beside a dev server. |
| `PRODUCTION_PORT` | optional, `pnpm test:e2e`                       | Port of the second, `APP_ENV=production` server the route-guard spec drives. Defaults to `3001`.      |
| `HOSTNAME`        | the e2e launchers                               | Bind address of the standalone server. Defaults to `127.0.0.1`.                                       |
| `CI`              | the CI runner                                   | Turns on Playwright retries and the GitHub reporter.                                                  |

## Production checklist

- `APP_ENV=production` and a real backend for all five providers. (`staging`
  keeps `memory` providers; only its secrets are strict.)
- `TRUSTED_CLIENT_IP_HEADER` named after the header your edge actually
  overwrites.
- All five required secrets at 32+ characters, generated per environment.
- `APP_BASE_URL` and `ALLOWED_ORIGINS` set to the deployed https origins.
- `NOVU_WEBHOOK_SECRET` set wherever receipts are enabled.
