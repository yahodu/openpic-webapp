/**
 * The config-driven `PaymentProvider` composition root (OP-105 follow-up,
 * ADR-0382 / ADR-0383).
 *
 * `getPaymentProvider()` maps the validated `PAYMENT_PROVIDER` selection onto a
 * concrete `PaymentProvider`, exactly as `getMessageTransport()` maps
 * `MESSAGE_TRANSPORT` onto a concrete `MessageTransport`:
 *
 *   - `memory` — the in-process adapter an e2e drives (`APP_ENV=e2e`; the
 *     documented default, and exactly what `e2e/start-server.mjs` selects by
 *     setting only `APP_ENV`);
 *   - any other selection — there is no Stripe adapter and the Cashfree adapter
 *     needs `CASHFREE_*` runtime wiring that does not exist yet, so selection
 *     **fails closed** with a `ConfigError` naming the key, mirroring
 *     `getRateLimitConfig()` (refuses `redis` without Upstash credentials) and
 *     `getMessageTransport()` (refuses a non-memory transport without a
 *     `NOVU_API_KEY`). OP-107 owns the production wiring.
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
import { memoryPaymentProvider } from "@/server/adapters/memory-payment-provider";
import { ConfigError, getConfig } from "@/server/config/env";
import type { PaymentEnvironment, PaymentProvider } from "@/server/payments/payment-provider";

/**
 * The environment the memory provider's refs belong to.
 *
 * `getConfig()` refuses `memory` in production, so a memory provider is only
 * ever built for a non-production process — where the vendor-side distinction
 * is `sandbox`.
 */
const MEMORY_ENV: PaymentEnvironment = "sandbox";

/**
 * Build the provider named by the validated `PAYMENT_PROVIDER` config.
 *
 * @returns A `PaymentProvider` for the configured selection.
 * @throws {ConfigError} When a non-memory provider is selected (no adapter is
 *   wired yet) or when `getConfig()` refuses the selection itself.
 */
export function getPaymentProvider(): PaymentProvider {
  const config = getConfig();

  if (config.payments.provider === "memory") {
    return memoryPaymentProvider({ env: MEMORY_ENV });
  }

  throw new ConfigError(["PAYMENT_PROVIDER"]);
}
