// Production-flavoured E2E server launcher (OP-85, E2).
//
// Mirrors `start-server.mjs` but boots the standalone server with
// `APP_ENV=production` on its own port, so the Playwright `api-production`
// project can prove the test-only OTP route is 404 under a real production
// configuration.
//
// Production is a strict-secret environment and rejects the in-memory
// providers, so this launcher must supply non-memory providers and 32+
// character secrets. The Upstash credentials are dummy values: nothing in this
// project's single request path reaches Redis (the guard 404s first).
import { randomBytes } from "node:crypto";

import { MongoMemoryReplSet } from "mongodb-memory-server";

const port = process.env.PORT ?? "3001";
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const origin = `http://${hostname}:${port}`;

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

process.env.APP_ENV = "production";
process.env.APP_BASE_URL = origin;
process.env.ALLOWED_ORIGINS = origin;
process.env.PORT = port;
process.env.HOSTNAME = hostname;
process.env.MONGODB_URI = replSet.getUri();

const throwawaySecret = () => randomBytes(32).toString("base64url");
process.env.BETTER_AUTH_SECRET = throwawaySecret();
process.env.INTERNAL_API_SECRET = throwawaySecret();
process.env.CRON_SECRET = throwawaySecret();
process.env.UNSUBSCRIBE_SIGNING_SECRET = throwawaySecret();
process.env.MEDIA_SIGNING_SECRET_CURRENT = throwawaySecret();

// Non-memory providers (production rejects `memory`).
process.env.RATE_LIMIT_PROVIDER = "redis";
process.env.UPSTASH_REDIS_REST_URL = "https://dummy.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "dummy-token";
process.env.STORAGE_PROVIDER = "s3";
process.env.QUEUE_PROVIDER = "mongo";
process.env.PAYMENT_PROVIDER = "stripe";
process.env.MESSAGE_TRANSPORT = "ses";
process.env.LOG_TRANSPORTS = "stdout";

// Production now requires the trusted client-IP header to be named
// (ADR-0024/ADR-0031), so the auth IP leg keys on an edge header the trusted
// fronting layer overwrites rather than the client-writable `x-forwarded-for`.
// This standalone server sits behind no proxy, so name `x-real-ip`; requests
// that do not carry it lose the IP leg (fail-safe), which is what the E2 guard
// spec exercises.
process.env.TRUSTED_CLIENT_IP_HEADER = "x-real-ip";

let stopping = false;
const shutdown = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  await replSet.stop();
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

await import(new URL("../.next/standalone/apps/web/server.js", import.meta.url).href);
