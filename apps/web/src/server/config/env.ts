import { z } from "zod";

/**
 * Zod-validated environment configuration, read from `process.env` exactly once
 * and exposed as a deep-frozen object through `getConfig()`.
 *
 * Design notes (OP-70):
 *   - Importing this module is side-effect free; validation only happens the
 *     first time `getConfig()` is called.
 *   - A parse failure throws a `ConfigError` whose message lists the offending
 *     environment variable KEY NAMES ONLY — never their values.
 *   - Deploy configuration (this module) is distinct from runtime tunables
 *     (platformSettings, US-015).
 */

const APP_ENVS = ["development", "test", "e2e", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The environments in which secrets must be at least `SECRET_MIN_LENGTH`. */
const STRICT_SECRET_ENVS: readonly string[] = ["staging", "production"];
const SECRET_MIN_LENGTH = 32;

/** Default provider selection when the variable is absent. */
const DEFAULT_PROVIDER = "memory";

/** Public shape returned by `getConfig()`. */
export interface AppConfig {
  readonly app: {
    readonly env: AppEnv;
    readonly baseUrl: string;
    readonly port: number;
    readonly allowedOrigins: readonly string[];
  };
  readonly mongo: { readonly uri: string };
  readonly auth: { readonly secret: string };
  readonly internal: { readonly apiSecret: string };
  readonly cron: { readonly secret: string };
  readonly rateLimit: { readonly provider: string };
  readonly storage: { readonly provider: string };
  readonly queue: { readonly provider: string };
  readonly payments: { readonly provider: string };
  readonly transport: {
    readonly provider: string;
    readonly unsubscribeSigningSecret: string;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly transports: readonly string[];
    readonly pretty: boolean;
    readonly betterStackSourceToken: string | undefined;
    readonly betterStackIngestHost: string | undefined;
  };
  readonly media: {
    readonly signingSecretCurrent: string;
    readonly signingSecretPrevious?: string;
  };
}

/**
 * Connection-pool tunables for the Mongo client (OP-75, §1).
 *
 * These are deliberately *not* part of {@link AppConfig}: the validated
 * configuration shape is a frozen contract asserted by its own specs, whereas
 * pool sizing is an operational tuning knob with sane defaults. Every value is
 * still read from the environment, with a positive-integer guard so a typo in a
 * deployed value degrades to the default rather than breaking the pool.
 */
export interface MongoPoolConfig {
  readonly maxPoolSize: number;
  readonly serverSelectionTimeoutMS: number;
  readonly connectTimeoutMS: number;
  readonly socketTimeoutMS: number;
}

const DEFAULT_MONGO_POOL: MongoPoolConfig = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
};

/** Parse a positive integer, falling back to `fallback` for absent/invalid values. */
function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read the Mongo pool tunables from the environment.
 *
 * @returns The pool size and timeouts, each defaulted when unset or invalid.
 */
export function getMongoPoolConfig(): MongoPoolConfig {
  return {
    maxPoolSize: positiveInteger(process.env.MONGODB_MAX_POOL_SIZE, DEFAULT_MONGO_POOL.maxPoolSize),
    serverSelectionTimeoutMS: positiveInteger(
      process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      DEFAULT_MONGO_POOL.serverSelectionTimeoutMS
    ),
    connectTimeoutMS: positiveInteger(
      process.env.MONGODB_CONNECT_TIMEOUT_MS,
      DEFAULT_MONGO_POOL.connectTimeoutMS
    ),
    socketTimeoutMS: positiveInteger(
      process.env.MONGODB_SOCKET_TIMEOUT_MS,
      DEFAULT_MONGO_POOL.socketTimeoutMS
    ),
  };
}

interface ProviderSpec {
  readonly key: string;
  readonly values: readonly string[];
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { key: "RATE_LIMIT_PROVIDER", values: ["memory", "redis"] },
  { key: "STORAGE_PROVIDER", values: ["memory", "s3"] },
  { key: "QUEUE_PROVIDER", values: ["memory", "mongo"] },
  { key: "PAYMENT_PROVIDER", values: ["memory", "stripe"] },
  { key: "MESSAGE_TRANSPORT", values: ["memory", "ses"] },
];

/** Required secrets subject to the >= 32 character rule in staging/production. */
const REQUIRED_SECRETS: readonly string[] = [
  "BETTER_AUTH_SECRET",
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
  "UNSUBSCRIBE_SIGNING_SECRET",
  "MEDIA_SIGNING_SECRET_CURRENT",
];

/** The raw (still string) environment as it reaches the process. */
interface RawEnv {
  readonly APP_ENV: string | undefined;
  readonly APP_BASE_URL: string | undefined;
  readonly PORT: string | undefined;
  readonly ALLOWED_ORIGINS: string | undefined;
  readonly MONGODB_URI: string | undefined;
  readonly BETTER_AUTH_SECRET: string | undefined;
  readonly INTERNAL_API_SECRET: string | undefined;
  readonly CRON_SECRET: string | undefined;
  readonly UNSUBSCRIBE_SIGNING_SECRET: string | undefined;
  readonly MEDIA_SIGNING_SECRET_CURRENT: string | undefined;
  readonly MEDIA_SIGNING_SECRET_PREVIOUS: string | undefined;
  readonly LOG_LEVEL: string | undefined;
  readonly LOG_TRANSPORTS: string | undefined;
  readonly LOG_PRETTY: string | undefined;
  readonly BETTERSTACK_SOURCE_TOKEN: string | undefined;
  readonly BETTERSTACK_INGEST_HOST: string | undefined;
  readonly RATE_LIMIT_PROVIDER: string | undefined;
  readonly UPSTASH_REDIS_REST_URL: string | undefined;
  readonly UPSTASH_REDIS_REST_TOKEN: string | undefined;
  readonly RATE_LIMIT_SALT: string | undefined;
  readonly STORAGE_PROVIDER: string | undefined;
  readonly QUEUE_PROVIDER: string | undefined;
  readonly PAYMENT_PROVIDER: string | undefined;
  readonly MESSAGE_TRANSPORT: string | undefined;
}

/** A missing/invalid configuration error naming only the offending keys. */
export class ConfigError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid application configuration: ${keys.join(", ")}`);
    this.name = "ConfigError";
    this.keys = keys;
  }
}

const optionalString = z.string().optional();

const rawSchema = z.object({
  APP_ENV: z.string(),
  APP_BASE_URL: z.string(),
  PORT: optionalString,
  ALLOWED_ORIGINS: z.string(),
  MONGODB_URI: z.string(),
  BETTER_AUTH_SECRET: z.string(),
  INTERNAL_API_SECRET: z.string(),
  CRON_SECRET: z.string(),
  UNSUBSCRIBE_SIGNING_SECRET: z.string(),
  MEDIA_SIGNING_SECRET_CURRENT: z.string(),
  MEDIA_SIGNING_SECRET_PREVIOUS: optionalString,
  LOG_LEVEL: optionalString,
  LOG_TRANSPORTS: optionalString,
  LOG_PRETTY: optionalString,
  BETTERSTACK_SOURCE_TOKEN: optionalString,
  BETTERSTACK_INGEST_HOST: optionalString,
  RATE_LIMIT_PROVIDER: optionalString,
  UPSTASH_REDIS_REST_URL: optionalString,
  UPSTASH_REDIS_REST_TOKEN: optionalString,
  RATE_LIMIT_SALT: optionalString,
  STORAGE_PROVIDER: optionalString,
  QUEUE_PROVIDER: optionalString,
  PAYMENT_PROVIDER: optionalString,
  MESSAGE_TRANSPORT: optionalString,
});

/** True for absolute http(s) URLs, which is what a base URL / origin must be. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Split a comma-separated list, trimming whitespace and dropping empties. */
function splitList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true";
}

function isStrictSecretEnv(appEnv: string | undefined): boolean {
  return appEnv !== undefined && STRICT_SECRET_ENVS.includes(appEnv);
}

const configSchema = rawSchema
  .superRefine((raw, ctx) => {
    const addIssue = (key: string): void => {
      ctx.addIssue({ code: "custom", message: key, path: [key] });
    };

    if (!(APP_ENVS as readonly string[]).includes(raw.APP_ENV)) {
      addIssue("APP_ENV");
    }

    if (!isAbsoluteHttpUrl(raw.APP_BASE_URL)) {
      addIssue("APP_BASE_URL");
    }

    const origins = splitList(raw.ALLOWED_ORIGINS);
    if (origins.length === 0 || !origins.every(isAbsoluteHttpUrl)) {
      addIssue("ALLOWED_ORIGINS");
    }

    if (
      !raw.MONGODB_URI.startsWith("mongodb://") &&
      !raw.MONGODB_URI.startsWith("mongodb+srv://")
    ) {
      addIssue("MONGODB_URI");
    }

    if (raw.LOG_LEVEL !== undefined && !(LOG_LEVELS as readonly string[]).includes(raw.LOG_LEVEL)) {
      addIssue("LOG_LEVEL");
    }

    if (
      raw.LOG_PRETTY !== undefined &&
      raw.LOG_PRETTY !== "" &&
      raw.LOG_PRETTY !== "true" &&
      raw.LOG_PRETTY !== "false"
    ) {
      addIssue("LOG_PRETTY");
    }

    if (raw.PORT !== undefined && !/^\d+$/.test(raw.PORT)) {
      addIssue("PORT");
    }

    const strict = isStrictSecretEnv(raw.APP_ENV);
    if (strict) {
      for (const key of REQUIRED_SECRETS) {
        const value = raw[key as keyof RawEnv];
        if (value !== undefined && value.length < SECRET_MIN_LENGTH) {
          addIssue(key);
        }
      }
      const previous = raw.MEDIA_SIGNING_SECRET_PREVIOUS;
      if (previous !== undefined && previous.length < SECRET_MIN_LENGTH) {
        addIssue("MEDIA_SIGNING_SECRET_PREVIOUS");
      }
    }

    for (const spec of PROVIDER_SPECS) {
      const value = raw[spec.key as keyof RawEnv] ?? DEFAULT_PROVIDER;
      if (!spec.values.includes(value)) {
        addIssue(spec.key);
      } else if (value === DEFAULT_PROVIDER && raw.APP_ENV === "production") {
        addIssue(spec.key);
      }
    }
  })
  .transform((raw): AppConfig => {
    const provider = (key: string): string => raw[key as keyof RawEnv] ?? DEFAULT_PROVIDER;

    return deepFreeze({
      app: {
        env: raw.APP_ENV as AppEnv,
        baseUrl: raw.APP_BASE_URL,
        port: raw.PORT === undefined || raw.PORT === "" ? 3000 : Number(raw.PORT),
        allowedOrigins: splitList(raw.ALLOWED_ORIGINS),
      },
      mongo: { uri: raw.MONGODB_URI },
      auth: { secret: raw.BETTER_AUTH_SECRET },
      internal: { apiSecret: raw.INTERNAL_API_SECRET },
      cron: { secret: raw.CRON_SECRET },
      rateLimit: { provider: provider("RATE_LIMIT_PROVIDER") },
      storage: { provider: provider("STORAGE_PROVIDER") },
      queue: { provider: provider("QUEUE_PROVIDER") },
      payments: { provider: provider("PAYMENT_PROVIDER") },
      transport: {
        provider: provider("MESSAGE_TRANSPORT"),
        unsubscribeSigningSecret: raw.UNSUBSCRIBE_SIGNING_SECRET,
      },
      logging: {
        level: (raw.LOG_LEVEL ?? "info") as LogLevel,
        transports: raw.LOG_TRANSPORTS === undefined ? ["stdout"] : splitList(raw.LOG_TRANSPORTS),
        pretty: parseBoolean(raw.LOG_PRETTY, false),
        betterStackSourceToken: raw.BETTERSTACK_SOURCE_TOKEN,
        betterStackIngestHost: raw.BETTERSTACK_INGEST_HOST,
      },
      media: {
        signingSecretCurrent: raw.MEDIA_SIGNING_SECRET_CURRENT,
        ...(raw.MEDIA_SIGNING_SECRET_PREVIOUS === undefined
          ? {}
          : { signingSecretPrevious: raw.MEDIA_SIGNING_SECRET_PREVIOUS }),
      },
    });
  });

/**
 * Resolve the current application environment without requiring the full
 * configuration to be valid.
 *
 * The HTTP pipeline must not turn a request into a 500 merely because the
 * process env is incomplete (e.g. in unit tests); this reads `APP_ENV`
 * directly and degrades to `development` for a missing or unknown value.
 *
 * @returns The app env name, never throwing.
 */
export function getAppEnv(): AppEnv {
  const raw = process.env.APP_ENV;
  return raw !== undefined && (APP_ENVS as readonly string[]).includes(raw)
    ? (raw as AppEnv)
    : "development";
}

/**
 * Whether Atlas vector search is enabled for this deployment (OP-76, §3).
 *
 * Atlas Search indexes are an opt-in, deployment-specific capability: the
 * bootstrap script reads this switch and skips vector-index creation unless it
 * is explicitly `true`. Like {@link getAppEnv} it is deliberately outside the
 * frozen {@link AppConfig} shape (which is asserted by its own specs) and reads
 * `process.env` directly, never throwing.
 *
 * @returns True only when `ATLAS_SEARCH_ENABLED` is exactly `"true"`.
 */
export function getAtlasSearchEnabled(): boolean {
  return parseBoolean(process.env.ATLAS_SEARCH_ENABLED, false);
}

/**
 * Runtime configuration for the rate-limit port (OP-79, contract §0.11).
 *
 * Kept outside the frozen {@link AppConfig} shape because it is operational
 * wiring (an Upstash URL/token pair and the identity-hashing salt) rather than
 * a deploy contract. The salt is required in production so an operator can
 * rotate it independently of code; outside production it degrades to a stable
 * development default so local/e2e runs behave deterministically.
 */
export interface RateLimitRuntimeConfig {
  /** The selected backend: `memory` or `redis`. */
  readonly provider: string;
  /** The Upstash REST URL, when the `redis` provider is selected. */
  readonly upstashUrl: string | undefined;
  /** The Upstash REST token, when the `redis` provider is selected. */
  readonly upstashToken: string | undefined;
  /** The salt mixed into every hashed rate-limit identity. */
  readonly salt: string;
}

/** Stable dev/e2e salt; production must set `RATE_LIMIT_SALT` explicitly. */
const DEFAULT_RATE_LIMIT_SALT = "openpic-dev-rate-limit-salt";

/** Default Better Auth session lifetime (7 days) when the env does not set one. */
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Read the Better Auth session lifetime from the environment (OP-85 §3).
 *
 * Kept outside the frozen {@link AppConfig} shape (which is asserted by its own
 * specs) because it is an operational tuneable, not a deploy contract.
 *
 * @returns The session lifetime in seconds, defaulted when unset or invalid.
 */
export function getSessionTtlSeconds(): number {
  return positiveInteger(process.env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS);
}

/**
 * Read the rate-limit runtime wiring from the environment.
 *
 * Fails closed: when the `redis` provider is selected, both Upstash REST
 * credentials must be present and non-blank. A misconfigured deployment must
 * never silently degrade to the per-process memory limiter, which cannot
 * enforce abuse protection across serverless instances.
 *
 * @returns The provider selection, Upstash credentials and the hashing salt.
 * @throws {ConfigError} When `redis` is selected without its credentials.
 */
export function getRateLimitConfig(): RateLimitRuntimeConfig {
  const provider = process.env.RATE_LIMIT_PROVIDER ?? DEFAULT_PROVIDER;
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (provider === "redis") {
    const missing: string[] = [];
    if (upstashUrl === undefined || upstashUrl.trim() === "") {
      missing.push("UPSTASH_REDIS_REST_URL");
    }
    if (upstashToken === undefined || upstashToken.trim() === "") {
      missing.push("UPSTASH_REDIS_REST_TOKEN");
    }
    if (missing.length > 0) {
      throw new ConfigError(missing);
    }
  }

  return {
    provider,
    upstashUrl,
    upstashToken,
    salt: process.env.RATE_LIMIT_SALT ?? DEFAULT_RATE_LIMIT_SALT,
  };
}

/** Recursively freeze an object graph so callers cannot mutate configuration. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

let cached: AppConfig | undefined;

/**
 * Read, validate and cache the application configuration.
 *
 * The environment is parsed on the first call only; later calls return the same
 * deep-frozen reference regardless of subsequent changes to `process.env`.
 *
 * @throws {ConfigError} when the environment is missing or invalid. The error
 *   message lists the offending KEY NAMES only, never their values.
 */
export function getConfig(): AppConfig {
  if (cached !== undefined) {
    return cached;
  }

  const result = configSchema.safeParse({ ...process.env });

  if (!result.success) {
    const keys = Array.from(
      new Set(
        result.error.issues
          .map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : undefined))
          .filter((key): key is string => key !== undefined)
      )
    );
    throw new ConfigError(keys);
  }

  cached = result.data;
  return cached;
}
