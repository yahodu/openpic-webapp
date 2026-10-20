/**
 * The config-driven `MessageTransport` factory (OP-95, design §8.2, ADR-0096;
 * extended by OP-94 §1 follow-up, ADR-0105).
 *
 * `createAuth` and the notification-fanout cron route both need a transport to
 * hand rendered messages to. The vendor-neutral `MessageTransport` port is the
 * only contract callers know (`docs/CONVENTIONS.md` §7 / ADR-0001), so this
 * module maps the validated `MESSAGE_TRANSPORT` selector onto a concrete
 * adapter:
 *
 *   - `memory` — the in-memory outbox (`memoryMessageTransport`), the documented
 *     default and the only provider legal in `test`/`e2e`/`development`;
 *   - any other provider — the Novu adapter, built from `getNovuRuntimeConfig()`.
 *     `MESSAGE_TRANSPORT=memory` is refused by `getConfig()` in production, so a
 *     deployed app can never silently drop messages into a process-local outbox.
 *
 * A non-memory provider selected without a usable `NOVU_API_KEY` fails closed at
 * selection time (`ConfigError` naming the key, never its value) — the deploy
 * posture of `getRateLimitConfig()` (refuses `redis` without Upstash
 * credentials) and `getConfig()` (refuses `memory` in production). A transport
 * that cannot send must not be constructed (OP-94 §1 follow-up, ADR-0108).
 *
 * Importing this module is side-effect free.
 */
import { memoryMessageTransport } from "@/server/adapters/memory-message-transport";
import { novuTransport } from "@/server/adapters/novu/novu-transport";
import { ConfigError, getConfig, getNovuRuntimeConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import type { MessageTransport } from "@/server/notifications/message-transport";

/**
 * Build the transport named by the validated `MESSAGE_TRANSPORT` config.
 *
 * @returns A `MessageTransport` for the configured provider.
 */
export function getMessageTransport(): MessageTransport {
  const config = getConfig();

  if (config.transport.provider === "memory") {
    return memoryMessageTransport();
  }

  const novu = getNovuRuntimeConfig();
  // `getNovuRuntimeConfig()` types `apiKey` as a string, defaulting an unset
  // `NOVU_API_KEY` to `""`, so "missing" and "blank" collapse to the blank
  // check here (a `=== undefined` arm would be dead code the linter rejects).
  if (novu.apiKey.trim() === "") {
    throw new ConfigError(["NOVU_API_KEY"]);
  }
  return novuTransport({
    baseUrl: novu.baseUrl,
    apiKey: novu.apiKey,
    logger: getLogger(),
  });
}
