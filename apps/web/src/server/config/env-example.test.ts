import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Section 7 of OP-70: `.env.example` is the operator-facing documentation of
 * the configuration contract, so every key the schema reads must be present
 * there (commented, with a value). This test keeps the example from drifting
 * behind the schema.
 */
const ENV_EXAMPLE_PATH = fileURLToPath(new URL("../../../../../.env.example", import.meta.url));

const REQUIRED_KEYS = [
  "APP_ENV",
  "APP_BASE_URL",
  "PORT",
  "ALLOWED_ORIGINS",
  "MONGODB_URI",
  "BETTER_AUTH_SECRET",
  "INTERNAL_API_SECRET",
  "CRON_SECRET",
  "UNSUBSCRIBE_SIGNING_SECRET",
  "MEDIA_SIGNING_SECRET_CURRENT",
  "MEDIA_SIGNING_SECRET_PREVIOUS",
  "LOG_LEVEL",
  "LOG_TRANSPORTS",
  "LOG_PRETTY",
  "RATE_LIMIT_PROVIDER",
  "STORAGE_PROVIDER",
  "QUEUE_PROVIDER",
  "PAYMENT_PROVIDER",
  "MESSAGE_TRANSPORT",
  "NOVU_TIMEOUT_MS",
  "TRUSTED_CLIENT_IP_HEADER",
] as const;

describe(".env.example", () => {
  it.each(REQUIRED_KEYS)("documents the %s key", (key) => {
    const contents = readFileSync(ENV_EXAMPLE_PATH, "utf8");

    expect(contents).toMatch(new RegExp(`^${key}=`, "m"));
  });
});
