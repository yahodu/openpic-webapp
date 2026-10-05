import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeEnv, makeProductionEnv, type EnvInput } from "../../test/factories/env";

/**
 * Contract under test — `src/server/config/env.ts`.
 *
 * The module is read once from the environment and validated with Zod. It must
 * export `getConfig(): AppConfig`, which:
 *
 *   - parses `process.env` on FIRST call, caches the result, and returns the
 *     SAME deep-frozen reference on every later call;
 *   - throws an `Error` (idea: a `ConfigError`) whose `message` lists the
 *     offending environment variable KEY NAMES ONLY — never their values;
 *   - importing the module itself must be side-effect free (validation happens
 *     inside `getConfig`, so a broken env is only fatal when config is read).
 *
 * Shape returned by `getConfig()` (grouped by concern):
 *
 *   app:       { env, baseUrl, port, allowedOrigins }
 *   mongo:     { uri }
 *   auth:      { secret }
 *   internal:  { apiSecret }
 *   cron:      { secret }
 *   rateLimit: { provider }
 *   storage:   { provider }
 *   queue:     { provider }
 *   payments:  { provider }
 *   transport: { provider, unsubscribeSigningSecret, timeoutMs }
 *   logging:   { level, transports, pretty }
 *   media:     { signingSecretCurrent, signingSecretPrevious? }
 *
 * Environment variables and their rules:
 *
 *   APP_ENV                      development | test | e2e | staging | production (required)
 *   APP_BASE_URL                 absolute URL (required)
 *   PORT                         coerced number, default 3000
 *   ALLOWED_ORIGINS              comma list -> string[], each a valid origin (required)
 *   MONGODB_URI                  mongodb:// or mongodb+srv:// URI (required)
 *   BETTER_AUTH_SECRET           secret; >= 32 chars in staging/production (required)
 *   INTERNAL_API_SECRET          secret; >= 32 chars in staging/production (required)
 *   CRON_SECRET                  secret; >= 32 chars in staging/production (required)
 *   UNSUBSCRIBE_SIGNING_SECRET   secret; >= 32 chars in staging/production (required)
 *   MEDIA_SIGNING_SECRET_CURRENT secret; >= 32 chars in staging/production (required)
 *   MEDIA_SIGNING_SECRET_PREVIOUS optional secret; >= 32 chars in staging/production when set
 *   LOG_LEVEL                    fatal | error | warn | info | debug | trace (default info)
 *   LOG_TRANSPORTS               comma list -> string[] (default ["stdout"])
 *   LOG_PRETTY                   coerced boolean (default false)
 *   RATE_LIMIT_PROVIDER          memory | redis            (default memory)
 *   STORAGE_PROVIDER             memory | s3               (default memory)
 *   QUEUE_PROVIDER               memory | mongo            (default memory)
 *   PAYMENT_PROVIDER             memory | stripe           (default memory)
 *   MESSAGE_TRANSPORT            memory | ses              (default memory)
 *   NOVU_TIMEOUT_MS              positive integer ms       (default 10000)
 *   TRUSTED_CLIENT_IP_HEADER     trusted edge header name; REQUIRED in
 *                                production (unset/blank refused — OP-85
 *                                follow-up, ADR-0032)
 *
 * `memory` is accepted for every provider selector EXCEPT when
 * `APP_ENV=production`.
 */

type EnvModule = typeof import("./env");

const ORIGINAL_ENV = process.env;

/**
 * Import a fresh copy of the config module with `process.env` replaced by the
 * fixture, so the module's "parse once" cache cannot leak between tests.
 */
async function loadEnvConfig(env: EnvInput): Promise<EnvModule> {
  vi.resetModules();

  const clean = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  // `ProcessEnv` is augmented by Next with a required `NODE_ENV`, so the plain
  // `string -> string` fixture needs a cast to be assigned here.
  process.env = { ...clean } as unknown as NodeJS.ProcessEnv;

  return import("./env");
}

/** Capture the message thrown by `getConfig()` for inspection. */
function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected getConfig() to throw, but it returned a value");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("getConfig — valid environment", () => {
  it("parses a valid environment into the typed configuration shape", async () => {
    const env = makeEnv({
      PORT: "8080",
      LOG_LEVEL: "debug",
      LOG_TRANSPORTS: "stdout",
      LOG_PRETTY: "false",
      ALLOWED_ORIGINS: "http://localhost:3000",
    });
    const { getConfig } = await loadEnvConfig(env);

    expect(getConfig()).toEqual({
      app: {
        env: "development",
        baseUrl: "http://localhost:3000",
        port: 8080,
        allowedOrigins: ["http://localhost:3000"],
      },
      mongo: { uri: "mongodb://localhost:27017/openpic" },
      auth: { secret: env.BETTER_AUTH_SECRET },
      internal: { apiSecret: env.INTERNAL_API_SECRET },
      cron: { secret: env.CRON_SECRET },
      rateLimit: { provider: "memory" },
      storage: { provider: "memory" },
      queue: { provider: "memory" },
      payments: { provider: "memory" },
      transport: {
        provider: "memory",
        unsubscribeSigningSecret: env.UNSUBSCRIBE_SIGNING_SECRET,
        timeoutMs: 10_000,
      },
      logging: { level: "debug", transports: ["stdout"], pretty: false },
      media: {
        signingSecretCurrent: env.MEDIA_SIGNING_SECRET_CURRENT,
        signingSecretPrevious: env.MEDIA_SIGNING_SECRET_PREVIOUS,
      },
    });
  });

  it("omits an optional secret that was not supplied", async () => {
    const env = makeEnv({ MEDIA_SIGNING_SECRET_PREVIOUS: undefined });
    const { getConfig } = await loadEnvConfig(env);

    expect(getConfig().media.signingSecretPrevious).toBeUndefined();
  });
});

describe("getConfig — missing required keys", () => {
  it("throws an error naming a missing key", async () => {
    const env = makeEnv({ MONGODB_URI: undefined });
    const { getConfig } = await loadEnvConfig(env);

    expect(() => getConfig()).toThrow(/MONGODB_URI/);
  });

  it("throws an error naming every missing key", async () => {
    const env = makeEnv({ APP_ENV: undefined, APP_BASE_URL: undefined });
    const { getConfig } = await loadEnvConfig(env);

    const message = captureError(() => getConfig());

    expect(message).toMatch(/APP_ENV/);
    expect(message).toMatch(/APP_BASE_URL/);
  });
});

describe("getConfig — secrets are never echoed", () => {
  it("never includes the invalid secret value in the error message", async () => {
    const leaked = "leaky-better-auth-secret-value";
    const env = makeProductionEnv({ BETTER_AUTH_SECRET: leaked });
    const { getConfig } = await loadEnvConfig(env);

    const message = captureError(() => getConfig());

    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).not.toContain(leaked);
  });

  it("reports only the key name for an invalid ALLOWED_ORIGINS entry", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "not-a-valid-origin" });
    const { getConfig } = await loadEnvConfig(env);

    const message = captureError(() => getConfig());

    expect(message).toMatch(/ALLOWED_ORIGINS/);
    expect(message).not.toContain("not-a-valid-origin");
  });
});

describe("getConfig — coercion", () => {
  it.each([
    ["8080", 8080],
    ["3001", 3001],
  ])("coerces PORT=%s to the number %i", async (raw, expected) => {
    const { getConfig } = await loadEnvConfig(makeEnv({ PORT: raw }));

    expect(getConfig().app.port).toBe(expected);
  });

  it.each([
    ["false", false],
    ["true", true],
  ])("coerces LOG_PRETTY=%s to the boolean %s", async (raw, expected) => {
    const { getConfig } = await loadEnvConfig(makeEnv({ LOG_PRETTY: raw }));

    expect(getConfig().logging.pretty).toBe(expected);
  });
});

describe("getConfig — comma lists", () => {
  it("splits ALLOWED_ORIGINS on commas and trims surrounding whitespace", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "http://a.test , https://b.test:8443" });
    const { getConfig } = await loadEnvConfig(env);

    expect(getConfig().app.allowedOrigins).toEqual(["http://a.test", "https://b.test:8443"]);
  });

  it("splits LOG_TRANSPORTS on commas into an array", async () => {
    const env = makeEnv({ LOG_TRANSPORTS: "stdout,file" });
    const { getConfig } = await loadEnvConfig(env);

    expect(getConfig().logging.transports).toEqual(["stdout", "file"]);
  });

  it("rejects an ALLOWED_ORIGINS entry that is not a valid origin", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ ALLOWED_ORIGINS: "not-a-url" }));

    expect(() => getConfig()).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe("getConfig — secret length policy", () => {
  const REQUIRED_SECRETS = [
    "BETTER_AUTH_SECRET",
    "INTERNAL_API_SECRET",
    "CRON_SECRET",
    "UNSUBSCRIBE_SIGNING_SECRET",
    "MEDIA_SIGNING_SECRET_CURRENT",
  ] as const;

  it.each(REQUIRED_SECRETS)(
    "rejects a %s shorter than 32 characters in production",
    async (key) => {
      const { getConfig } = await loadEnvConfig(makeProductionEnv({ [key]: "too-short" }));

      expect(() => getConfig()).toThrow(new RegExp(key));
    }
  );

  it("accepts a short secret in development", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ BETTER_AUTH_SECRET: "short" }));

    expect(getConfig().auth.secret).toBe("short");
  });
});

describe("getConfig — provider selectors", () => {
  const PROVIDER_KEYS = [
    "RATE_LIMIT_PROVIDER",
    "STORAGE_PROVIDER",
    "QUEUE_PROVIDER",
    "PAYMENT_PROVIDER",
    "MESSAGE_TRANSPORT",
  ] as const;

  it.each(PROVIDER_KEYS)("rejects %s=memory in production", async (key) => {
    const { getConfig } = await loadEnvConfig(makeProductionEnv({ [key]: "memory" }));

    expect(() => getConfig()).toThrow(new RegExp(key));
  });

  it("accepts non-memory providers in production", async () => {
    const { getConfig } = await loadEnvConfig(makeProductionEnv());

    expect(getConfig().app.env).toBe("production");
    expect(getConfig().queue.provider).toBe("mongo");
  });

  it.each(["development", "test", "e2e", "staging"] as const)(
    "accepts memory providers when APP_ENV=%s",
    async (appEnv) => {
      const { getConfig } = await loadEnvConfig(makeEnv({ APP_ENV: appEnv }));

      expect(getConfig().storage.provider).toBe("memory");
    }
  );
});

describe("getConfig — frozen result", () => {
  it("returns a deep-frozen configuration object", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv());
    const config = getConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
    expect(Object.isFrozen(config.mongo)).toBe(true);
    expect(Object.isFrozen(config.logging)).toBe(true);
    expect(Object.isFrozen(config.logging.transports)).toBe(true);
  });

  it("throws when a caller mutates the returned configuration in strict mode", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv());
    const config = getConfig();

    expect(() => {
      (config.app as unknown as { env: string }).env = "production";
    }).toThrow(TypeError);

    expect(() => {
      (config.mongo as unknown as { uri: string }).uri = "mongodb://evil";
    }).toThrow(TypeError);

    expect(() => {
      (config.logging.transports as string[]).push("file");
    }).toThrow(TypeError);
  });
});

describe("getConfig — APP_ENV validation", () => {
  it.each(["staging2", "", "PRODUCTION", "prod"])(
    "rejects the unknown APP_ENV %j",
    async (value) => {
      const { getConfig } = await loadEnvConfig(makeEnv({ APP_ENV: value }));

      expect(() => getConfig()).toThrow(/APP_ENV/);
    }
  );
});

describe("getConfig — parse once", () => {
  it("returns the same frozen reference on every call", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv());
    const first = getConfig();

    process.env.APP_ENV = "production";

    const second = getConfig();

    expect(second).toBe(first);
  });
});

describe("getConfig — URL validation", () => {
  it("rejects an APP_BASE_URL that is not an absolute URL, naming only the key", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ APP_BASE_URL: "not-a-url" }));

    const message = captureError(() => getConfig());

    expect(message).toMatch(/APP_BASE_URL/);
    expect(message).not.toContain("not-a-url");
  });

  it("rejects an empty ALLOWED_ORIGINS list", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ ALLOWED_ORIGINS: "" }));

    expect(() => getConfig()).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe("getConfig — enum validation", () => {
  it.each(["dropbox", "local"] as const)(
    "rejects the unknown STORAGE_PROVIDER %j, naming only the key",
    async (value) => {
      const { getConfig } = await loadEnvConfig(makeEnv({ STORAGE_PROVIDER: value }));

      const message = captureError(() => getConfig());

      expect(message).toMatch(/STORAGE_PROVIDER/);
      expect(message).not.toContain(value);
    }
  );

  it("rejects an unknown LOG_LEVEL", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ LOG_LEVEL: "verbose" }));

    const message = captureError(() => getConfig());

    expect(message).toMatch(/LOG_LEVEL/);
    expect(message).not.toContain("verbose");
  });
});

describe("getConfig — multiple failures", () => {
  it("lists every invalid key rather than only the first", async () => {
    const env = makeProductionEnv({ BETTER_AUTH_SECRET: "short", CRON_SECRET: "short" });
    const { getConfig } = await loadEnvConfig(env);

    const message = captureError(() => getConfig());

    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).toMatch(/CRON_SECRET/);
  });
});

describe("getConfig — secret length boundary", () => {
  it("rejects a 31-character secret in production", async () => {
    const { getConfig } = await loadEnvConfig(
      makeProductionEnv({ BETTER_AUTH_SECRET: "a".repeat(31) })
    );

    expect(() => getConfig()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("accepts a secret of exactly 32 characters in production", async () => {
    const boundary = "a".repeat(32);
    const { getConfig } = await loadEnvConfig(makeProductionEnv({ BETTER_AUTH_SECRET: boundary }));

    expect(getConfig().auth.secret).toBe(boundary);
  });

  it("rejects a short MEDIA_SIGNING_SECRET_PREVIOUS when set in production", async () => {
    const { getConfig } = await loadEnvConfig(
      makeProductionEnv({ MEDIA_SIGNING_SECRET_PREVIOUS: "too-short" })
    );

    expect(() => getConfig()).toThrow(/MEDIA_SIGNING_SECRET_PREVIOUS/);
  });
});

describe("getConfig — production requires TRUSTED_CLIENT_IP_HEADER (ADR-0032)", () => {
  it("refuses to start when the knob is unset in production, naming the key", async () => {
    const { getConfig, ConfigError } = await loadEnvConfig(
      makeProductionEnv({ TRUSTED_CLIENT_IP_HEADER: undefined })
    );

    expect(() => getConfig()).toThrow(ConfigError);
    expect(() => getConfig()).toThrow(/TRUSTED_CLIENT_IP_HEADER/);
  });

  it.each(["", "   "])(
    "refuses to start when the knob is blank (%j) in production, naming the key",
    async (blank) => {
      const { getConfig } = await loadEnvConfig(
        makeProductionEnv({ TRUSTED_CLIENT_IP_HEADER: blank })
      );

      expect(() => getConfig()).toThrow(/TRUSTED_CLIENT_IP_HEADER/);
    }
  );

  it.each(["x-real-ip", "cf-connecting-ip", "  x-real-ip  "])(
    "parses a production environment when the knob is the non-blank value %j",
    async (header) => {
      const { getConfig } = await loadEnvConfig(
        makeProductionEnv({ TRUSTED_CLIENT_IP_HEADER: header })
      );

      expect(getConfig().app.env).toBe("production");
    }
  );

  it.each(["development", "test", "e2e", "staging"] as const)(
    "keeps the knob optional when APP_ENV=%s",
    async (appEnv) => {
      const { getConfig } = await loadEnvConfig(
        makeEnv({ APP_ENV: appEnv, TRUSTED_CLIENT_IP_HEADER: undefined })
      );

      expect(getConfig().app.env).toBe(appEnv);
    }
  );

  it("reports only the key name, never the offending value", async () => {
    const { getConfig } = await loadEnvConfig(
      makeProductionEnv({ TRUSTED_CLIENT_IP_HEADER: undefined })
    );

    const message = captureError(() => getConfig());

    expect(message).toBe("Invalid application configuration: TRUSTED_CLIENT_IP_HEADER");
  });
});

describe("getConfig — Novu transport timeout (OP-92, ADR-0074)", () => {
  it("defaults transport.timeoutMs to 10000 when NOVU_TIMEOUT_MS is unset", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ NOVU_TIMEOUT_MS: undefined }));

    expect(getConfig().transport.timeoutMs).toBe(10_000);
  });

  it("coerces NOVU_TIMEOUT_MS into the transport timeout in milliseconds", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ NOVU_TIMEOUT_MS: "2500" }));

    expect(getConfig().transport.timeoutMs).toBe(2500);
  });

  it("falls back to the 10000 ms default for a non-positive or non-numeric NOVU_TIMEOUT_MS", async () => {
    const { getConfig } = await loadEnvConfig(makeEnv({ NOVU_TIMEOUT_MS: "not-a-number" }));

    expect(getConfig().transport.timeoutMs).toBe(10_000);
  });
});
