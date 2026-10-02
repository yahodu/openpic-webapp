// E2E server launcher.
//
// The readiness probe (E1) pings a real MongoDB, so the e2e runtime needs a
// reachable database. Next.js starts its web server *before* Playwright's
// globalSetup runs, so the database must be provisioned by the command that
// starts the server rather than by a globalSetup hook.
//
// This script boots a single-node MongoDB replica set (transactions supported,
// mirroring the integration harness), exports a complete valid environment,
// and then starts the Next standalone server in-process.
import { randomBytes } from "node:crypto";

import { MongoMemoryReplSet } from "mongodb-memory-server";

const port = process.env.PORT ?? "3000";
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const origin = `http://${hostname}:${port}`;

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });

process.env.APP_ENV = "e2e";
process.env.APP_BASE_URL = origin;
process.env.ALLOWED_ORIGINS = origin;
process.env.PORT = port;
process.env.HOSTNAME = hostname;
process.env.MONGODB_URI = replSet.getUri();
// e2e is not a strict-secret environment, but the config schema still requires
// these to be present. Generate throwaway values so no secret-shaped literal is
// ever committed.
const throwawaySecret = () => randomBytes(32).toString("base64url");
process.env.BETTER_AUTH_SECRET = throwawaySecret();
process.env.INTERNAL_API_SECRET = throwawaySecret();
process.env.CRON_SECRET = throwawaySecret();
process.env.UNSUBSCRIBE_SIGNING_SECRET = throwawaySecret();
process.env.MEDIA_SIGNING_SECRET_CURRENT = throwawaySecret();
process.env.LOG_TRANSPORTS = "stdout";

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
