import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { UpstreamContractError } from "@/server/adapters/transport-error";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import type { ProviderRef } from "@/server/payments/payment-provider";

import {
  makeCashfreeSubscriptionStatusResponse,
  makeCashfreeWebhookBody,
  makePaymentProviderConfig,
} from "../factories/payment";
import { server } from "./setup";

/**
 * F2 — the drift log for a vendor `subscription_status` outside the pinned table
 * (OP-105, ADR-0380 §1/§6, ADR-0382).
 *
 * ADR-0380 §1 makes "a new vendor status Cashfree adds tomorrow" exactly the
 * case the pinned drift signal exists for, and §6 pins
 * `payments.upstream_contract_violation` as "the signal an on-call engineer is
 * paged on" for a response that breaks the pinned contract. The wire schemas are
 * deliberately non-strict on the status string (`schemas.ts`), so a brand-new
 * vendor status parses cleanly and is detected only by the status-table lookup —
 * the one detection path that did not log.
 *
 * These pins fix the **observable** behaviour of that path: an unknown status on
 * either entry point raises `UpstreamContractError` **and** emits exactly one
 * drift entry carrying the vendor and the operation; a known status on either
 * path emits none. `operation` is pinned per path (`parseWebhook` /
 * `fetchStatus`) so the signal names the surface that drifted.
 *
 * RED against the adapter as merged in PR #292 (`d3b6bdc`): `parseWebhook` logs
 * nothing at all for an unknown status, and `fetchStatus` logs only the `info`
 * `payments.call` line. No assertion here reaches inside the adapter.
 *
 * The local `installLogger()` is a deliberate copy of the helper in
 * `payments-cashfree-adapter.test.ts`: that spec is a frozen deliverable of the
 * RED card and must not be edited, and the helper is not exported.
 */

/** The sandbox origin the adapter derives from `env: "sandbox"`. */
const SANDBOX_ORIGIN = "https://sandbox.cashfree.com";

/** The vendor subscription id every read test addresses. */
const REF_ID = "sub_test_001";

/** The vendor ref the status read addresses. */
const REF: ProviderRef = {
  provider: "cashfree",
  env: "sandbox",
  kind: "subscription",
  id: REF_ID,
};

/** The status-read URL for {@link REF}. */
const STATUS_URL = `${SANDBOX_ORIGIN}/pg/subscriptions/${REF_ID}`;

/** The log event emitted for a response that breaks the pinned wire contract. */
const DRIFT_EVENT = "payments.upstream_contract_violation";

/** A vendor status the adapter's 12-row table does not know. */
const UNKNOWN_STATUS = "SOME_NEW_VENDOR_STATUS";

/** Build a logger wired to a memory sink so a test can inspect emitted entries. */
function installLogger(): { readonly logger: Logger; readonly sink: MemoryTransport } {
  const sink = memoryTransport();
  const logger = createLogger({
    level: "trace",
    transports: [sink],
    service: "openpic-web",
    env: "test",
    version: "test-sha",
    base: { requestId: "req-payments-drift-test" },
  });
  return { logger, sink };
}

/** The drift entries a sink recorded (the log must stay a drift signal, not a per-call line). */
function driftEntries(sink: MemoryTransport): readonly unknown[] {
  return sink.entries.filter((entry) => entry.event === DRIFT_EVENT);
}

describe("Cashfree adapter drift log — vendor status outside the pinned table (F2)", () => {
  it("parseWebhook raises UpstreamContractError and logs one drift entry naming the parseWebhook operation", () => {
    // Arrange
    const { logger, sink } = installLogger();
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED", {
      subscriptionDetails: { subscription_status: UNKNOWN_STATUS },
    });

    // Act + Assert — `parseWebhook` is synchronous and throws on the table miss.
    expect(() => provider.parseWebhook(body)).toThrow(UpstreamContractError);

    const drift = driftEntries(sink);
    expect(drift).toHaveLength(1);
    const entry = drift[0] as Record<string, unknown> | undefined;
    expect(entry?.event).toBe(DRIFT_EVENT);
    expect(entry?.level).toBe("error");
    expect(entry?.provider).toBe("cashfree");
    expect(entry?.operation).toBe("parseWebhook");
  });

  it("fetchStatus raises UpstreamContractError and logs one drift entry naming the fetchStatus operation", async () => {
    // Arrange
    const { logger, sink } = installLogger();
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json(
          makeCashfreeSubscriptionStatusResponse({ subscription_status: UNKNOWN_STATUS })
        )
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));

    // Act
    const fetchStatus = provider.fetchStatus(REF);

    // Assert
    await expect(fetchStatus).rejects.toBeInstanceOf(UpstreamContractError);

    const drift = driftEntries(sink);
    expect(drift).toHaveLength(1);
    const entry = drift[0] as Record<string, unknown> | undefined;
    expect(entry?.event).toBe(DRIFT_EVENT);
    expect(entry?.level).toBe("error");
    expect(entry?.provider).toBe("cashfree");
    expect(entry?.operation).toBe("fetchStatus");
  });

  it("parseWebhook with a known status emits no drift entry", () => {
    // Arrange
    const { logger, sink } = installLogger();
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));
    const body = makeCashfreeWebhookBody("SUBSCRIPTION_STATUS_CHANGED", {
      subscriptionDetails: { subscription_status: "ACTIVE" },
    });

    // Act
    const event = provider.parseWebhook(body);

    // Assert
    expect(event.status).toBe("active");
    expect(driftEntries(sink)).toHaveLength(0);
  });

  it("fetchStatus with a known status emits no drift entry", async () => {
    // Arrange
    const { logger, sink } = installLogger();
    server.use(
      http.get(STATUS_URL, () =>
        HttpResponse.json(makeCashfreeSubscriptionStatusResponse({ subscription_status: "ACTIVE" }))
      )
    );
    const provider = createCashfreeProvider(makePaymentProviderConfig({ logger }));

    // Act
    const status = await provider.fetchStatus(REF);

    // Assert
    expect(status).toEqual({ status: "active", mandateStatus: "active" });
    expect(driftEntries(sink)).toHaveLength(0);
  });
});
