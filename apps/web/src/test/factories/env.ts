/**
 * Environment fixture factory for the Zod-validated config module
 * (`src/server/config/env.ts`).
 *
 * Builds a complete, valid set of environment variables so each test only has
 * to state the keys it cares about. The defaults are valid in every
 * environment: every secret is at least 32 characters long and providers
 * default to `memory`, which is only legal outside production.
 *
 * Keys are the raw environment variable names; a key mapped to `undefined` is
 * treated as absent (mirroring how a missing variable reaches the process).
 */
export type EnvInput = Partial<Record<string, string>>;

/** Provider selections that are legal in production (no `memory`). */
const NON_MEMORY_PROVIDERS: Record<string, string> = {
  RATE_LIMIT_PROVIDER: "redis",
  STORAGE_PROVIDER: "s3",
  QUEUE_PROVIDER: "mongo",
  PAYMENT_PROVIDER: "stripe",
  MESSAGE_TRANSPORT: "ses",
};

const DEFAULTS: Record<string, string> = {
  APP_ENV: "development",
  APP_BASE_URL: "http://localhost:3000",
  PORT: "3000",
  ALLOWED_ORIGINS: "http://localhost:3000",
  MONGODB_URI: "mongodb://localhost:27017/openpic",
  BETTER_AUTH_SECRET: "dev-better-auth-secret-0123456789abcdef",
  INTERNAL_API_SECRET: "dev-internal-api-secret-0123456789abcdef",
  CRON_SECRET: "dev-cron-secret-0123456789abcdefghijklmnop",
  UNSUBSCRIBE_SIGNING_SECRET: "dev-unsubscribe-signing-secret-0123456789ab",
  MEDIA_SIGNING_SECRET_CURRENT: "dev-media-signing-secret-0123456789abcdef",
  MEDIA_SIGNING_SECRET_PREVIOUS: "dev-media-signing-secret-previous-0123456789",
  LOG_LEVEL: "info",
  LOG_TRANSPORTS: "stdout",
  LOG_PRETTY: "false",
  RATE_LIMIT_PROVIDER: "memory",
  STORAGE_PROVIDER: "memory",
  QUEUE_PROVIDER: "memory",
  PAYMENT_PROVIDER: "memory",
  MESSAGE_TRANSPORT: "memory",
};

/**
 * Build a valid development/test environment.
 *
 * @param overrides - Keys to override (or set to `undefined` to omit).
 * @returns A complete environment fixture.
 */
export function makeEnv(overrides: EnvInput = {}): EnvInput {
  return { ...DEFAULTS, ...overrides };
}

/**
 * Build a valid production environment: `APP_ENV=production`, non-memory
 * providers and 32+ character secrets. Override a single key to make exactly
 * one thing invalid.
 *
 * @param overrides - Keys to override.
 * @returns A production environment fixture.
 */
export function makeProductionEnv(overrides: EnvInput = {}): EnvInput {
  return makeEnv({ APP_ENV: "production", ...NON_MEMORY_PROVIDERS, ...overrides });
}

/**
 * Materialise a fixture into the plain `string -> string` record a child
 * process needs, dropping keys whose value is `undefined`.
 *
 * @param env - Environment fixture.
 * @returns A record safe to pass to `spawnSync`'s `env` option.
 */
export function toProcessEnv(env: EnvInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
