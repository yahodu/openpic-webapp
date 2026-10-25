/**
 * The config-driven `PaymentProvider` composition root (OP-105 follow-up,
 * ADR-0383 / ADR-0384; extended by OP-107, ADR-0421).
 *
 * `getPaymentProvider()` maps the validated `PAYMENT_PROVIDER` selection onto a
 * concrete `PaymentProvider`, exactly as `getMessageTransport()` maps
 * `MESSAGE_TRANSPORT` onto a concrete `MessageTransport`:
 *
 *   - `memory` — the in-process adapter an e2e drives (`APP_ENV=e2e`; the
 *     documented default, and exactly what `e2e/start-server.mjs` selects by
 *     setting only `APP_ENV`);
 *   - `cashfree` — the vendor adapter, built from the `CASHFREE_*` runtime
 *     wiring `getPaymentsRuntimeConfig()` reads (OP-107's production wiring: the
 *     checkout route must be drivable against the real adapter behind MSW, and
 *     an e2e must get the memory one);
 *   - any other selection (`stripe`, a future PSP) — no adapter exists, so it
 *     **fails closed** with a `ConfigError` naming the key, mirroring
 *     `getRateLimitConfig()` (refuses `redis` without Upstash credentials) and
 *     `getMessageTransport()` (refuses a non-memory transport without a
 *     `NOVU_API_KEY`).
 *
 * The selection is read through `getConfig()` and never from `process.env`, and
 * `getConfig()` already refuses `PAYMENT_PROVIDER=memory` under
 * `APP_ENV=production`. Together those two facts are the honesty property this
 * root exists to guarantee: no implementation that read `process.env` behind
 * the validator's back can hand a process-local provider to a production
 * deploy.
 *
 * Importing this module is side-effect free.
 */
import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { memoryPaymentProvider } from "@/server/adapters/memory-payment-provider";
import { ConfigError, getConfig, getPaymentsRuntimeConfig } from "@/server/config/env";
import { getLogger } from "@/server/logging";
import type { PaymentEnvironment, PaymentProvider } from "@/server/payments/payment-provider";

/**
 * The vendor environment this process's provider calls belong to (§11.1).
 *
 * A production process talks to the vendor's production API; every other
 * process — and `getConfig()` refuses `memory` in production, so a memory
 * provider only ever exists off production — is the vendor's sandbox, which is
 * what MSW intercepts in the integration suite.
 *
 * @param appEnv - The validated `APP_ENV`.
 * @returns `production` only for a production process, `sandbox` otherwise.
 */
function vendorEnvironment(appEnv: string): PaymentEnvironment {
  return appEnv === "production" ? "production" : "sandbox";
}

/**
 * Build the provider named by the validated `PAYMENT_PROVIDER` config.
 *
 * @returns A `PaymentProvider` for the configured selection.
 * @throws {ConfigError} When a selection with no adapter (`stripe`) is
 *   configured, when a `cashfree` selection is missing its `CASHFREE_*`
 *   credentials, or when `getConfig()` refuses the selection itself.
 */
export function getPaymentProvider(): PaymentProvider {
  const config = getConfig();
  const env = vendorEnvironment(config.app.env);

  if (config.payments.provider === "memory") {
    return memoryPaymentProvider({ env });
  }

  const payments = getPaymentsRuntimeConfig();
  if (payments.cashfree !== null) {
    return createCashfreeProvider({ env, ...payments.cashfree, logger: getLogger() });
  }

  throw new ConfigError(["PAYMENT_PROVIDER"]);
}
