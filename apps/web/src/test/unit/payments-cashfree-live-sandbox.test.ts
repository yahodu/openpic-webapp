/**
 * The `CASHFREE_LIVE_TEST=1`-gated live sandbox contract test (OP-105, ADR-0382).
 *
 * The MSW spec (`test/integration/payments-cashfree-adapter.test.ts`) pins the
 * adapter against payloads **we** wrote, so it cannot notice Cashfree renaming
 * a field or dropping one the pinned request/response schemas require. This spec
 * drives the real sandbox (`https://sandbox.cashfree.com`) through
 * `createCashfreeProvider` and asserts what a caller observes: the responses
 * project onto the pinned neutral shapes and carry **no vendor field**
 * (contract §3.2), and neither the client secret nor the webhook secret nor a
 * raw vendor payload reaches a log line (CONVENTIONS §5.3).
 *
 * The suite never runs in CI: it is skipped unless `CASHFREE_LIVE_TEST === "1"`
 * (`describe.skipIf`), a skipped Vitest suite executes neither its hooks nor its
 * test bodies, and this file performs no I/O outside that suite. With the gate
 * on but a credential missing the run **fails closed** rather than skipping —
 * a requested live run that silently skips is worse than no live run at all.
 *
 * The second `describe` is deliberately **not** gated: it pins the gate and the
 * fail-closed credential guard itself, so the contract of the gate is exercised
 * on every CI run even though the live round trip never is.
 *
 * Requires `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`,
 * `CASHFREE_WEBHOOK_SECRET` and `CASHFREE_LIVE_PLAN_ID` (a plan that exists in
 * the sandbox account) in the environment, plus `CASHFREE_LIVE_TEST=1`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { createLogger, memoryTransport, type Logger, type MemoryTransport } from "@/server/logging";
import type {
  CreateMandateResult,
  FetchStatusResult,
  MandateStatus,
  PaymentProvider,
  ProviderRef,
  SubscriptionStatus,
} from "@/server/payments/payment-provider";

import {
  isLiveSandboxEnabled,
  LIVE_SANDBOX_GATE,
  LIVE_SANDBOX_VARS,
  resolveLiveSandboxCredentials,
  type LiveSandboxCredentials,
} from "../helpers/cashfree-live-sandbox";
import { expectNoSecretsInLogs } from "../helpers/log-assertions";

/** Whether this run was asked for explicitly; computed once, performs no I/O. */
const LIVE_REQUESTED = isLiveSandboxEnabled(process.env);

/** The pinned Cashfree API version the adapter must send (ADR-0380 §5). */
const PINNED_API_VERSION = "2025-01-01";

/** A bounded per-request timeout for a live call (the adapter default is 15 s). */
const LIVE_TIMEOUT_MS = 30_000;

/** The fixed sandbox customer the live mandate is created for. */
const LIVE_CUSTOMER = {
  name: "OpenPic Live Sandbox",
  email: "sandbox@openpic.in",
  phone: "9900000000",
} as const;

/** The §3.3 `returnUrl` the live mandate is created with (an allow-listed origin). */
const LIVE_RETURN_URL = "https://openpic.in/billing/return";

/** Every value `SubscriptionStatus` may take (contract §14.3). */
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "incomplete",
  "active",
  "past_due",
  "downgraded",
  "cancelled",
  "expired",
];

/** Every value `MandateStatus` may take (contract §14.3). */
const MANDATE_STATUSES: readonly MandateStatus[] = [
  "pending",
  "active",
  "paused",
  "revoked",
  "expired",
];

/** A complete live environment, used only to prove the guard's happy path. */
const FULL_LIVE_ENV: Record<string, string | undefined> = {
  [LIVE_SANDBOX_GATE]: "1",
  CASHFREE_CLIENT_ID: "live-sandbox-client-id",
  CASHFREE_CLIENT_SECRET: "live-sandbox-client-secret",
  CASHFREE_WEBHOOK_SECRET: "live-sandbox-webhook-secret",
  CASHFREE_LIVE_PLAN_ID: "live-sandbox-plan-ref",
};

/**
 * Read the subscription ref `createMandate` answered with.
 *
 * The adapter returns exactly one ref, but the port types `externalRefs` as a
 * list, so the first element is narrowed here rather than asserted in a test.
 *
 * @param result - The `createMandate` result.
 * @returns Its first provider ref.
 */
function firstRef(result: CreateMandateResult): ProviderRef {
  const ref = result.externalRefs[0];
  if (ref === undefined) {
    throw new Error("createMandate answered with no external ref to read a status with.");
  }
  return ref;
}

describe.skipIf(!LIVE_REQUESTED)("Cashfree live sandbox contract", () => {
  let credentials: LiveSandboxCredentials;
  let sink: MemoryTransport;
  let provider: PaymentProvider;
  let mandate: CreateMandateResult;
  let status: FetchStatusResult;

  beforeAll(async () => {
    credentials = resolveLiveSandboxCredentials(process.env);

    sink = memoryTransport();
    const logger: Logger = createLogger({
      level: "trace",
      transports: [sink],
      service: "openpic-web",
      env: "sandbox",
      version: "live-sandbox",
    });

    provider = createCashfreeProvider({
      env: "sandbox",
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      apiVersion: PINNED_API_VERSION,
      webhookSecret: credentials.webhookSecret,
      logger,
      timeoutMs: LIVE_TIMEOUT_MS,
    });

    mandate = await provider.createMandate({
      planRef: credentials.planRef,
      customer: LIVE_CUSTOMER,
      returnUrl: LIVE_RETURN_URL,
      paymentMethodKind: "mandate_upi",
    });
    status = await provider.fetchStatus(firstRef(mandate));
  });

  it("createMandate projects the sandbox response onto the pinned neutral shape", () => {
    expect(Object.keys(mandate).sort()).toEqual(["checkoutUrl", "expiresAt", "externalRefs"]);
    expect(mandate.externalRefs).toHaveLength(1);
    expect(mandate.externalRefs[0]).toEqual({
      provider: "cashfree",
      env: "sandbox",
      kind: "subscription",
      id: expect.any(String),
    });
    expect(firstRef(mandate).id.length).toBeGreaterThan(0);
    expect(mandate.checkoutUrl).toMatch(/^https:\/\//);
    expect(mandate.expiresAt.length).toBeGreaterThan(0);
  });

  it("fetchStatus projects the live mandate onto the pinned {status, mandateStatus} pair", () => {
    expect(Object.keys(status).sort()).toEqual(["mandateStatus", "status"]);
    expect(SUBSCRIPTION_STATUSES).toContain(status.status);
    expect(MANDATE_STATUSES).toContain(status.mandateStatus);
  });

  it("logs no secret, signature or raw payload during the live round trip", () => {
    expect(sink.entries.length).toBeGreaterThan(0);
    expectNoSecretsInLogs(sink);

    const serialized = JSON.stringify(sink.entries);
    expect(serialized).not.toContain(credentials.clientId);
    expect(serialized).not.toContain(credentials.clientSecret);
    expect(serialized).not.toContain(credentials.webhookSecret);
  });
});

describe("the live sandbox gate and its credential guard", () => {
  it('asks for a live run only when CASHFREE_LIVE_TEST is exactly "1"', () => {
    expect(isLiveSandboxEnabled({})).toBe(false);
    expect(isLiveSandboxEnabled({ [LIVE_SANDBOX_GATE]: "" })).toBe(false);
    expect(isLiveSandboxEnabled({ [LIVE_SANDBOX_GATE]: "0" })).toBe(false);
    expect(isLiveSandboxEnabled({ [LIVE_SANDBOX_GATE]: "true" })).toBe(false);
    expect(isLiveSandboxEnabled({ [LIVE_SANDBOX_GATE]: "1" })).toBe(true);
  });

  it("returns every credential the live run needs", () => {
    expect(resolveLiveSandboxCredentials(FULL_LIVE_ENV)).toEqual({
      clientId: "live-sandbox-client-id",
      clientSecret: "live-sandbox-client-secret",
      webhookSecret: "live-sandbox-webhook-secret",
      planRef: "live-sandbox-plan-ref",
    });
  });

  it("fails closed, naming the gate and every missing credential, when nothing is configured", () => {
    expect(() => resolveLiveSandboxCredentials({ [LIVE_SANDBOX_GATE]: "1" })).toThrow(
      `CASHFREE_LIVE_TEST=1 requested a live Cashfree sandbox run but ${LIVE_SANDBOX_VARS.join(
        ", "
      )} are unset.`
    );
  });

  it.each([...LIVE_SANDBOX_VARS])(
    "fails closed and names %s when the gate is on but it is unset",
    (missingName) => {
      const incomplete = Object.fromEntries(
        Object.entries(FULL_LIVE_ENV).filter(([name]) => name !== missingName)
      );

      expect(() => resolveLiveSandboxCredentials(incomplete)).toThrow(missingName);
    }
  );

  it.each([...LIVE_SANDBOX_VARS])(
    "treats a whitespace-only %s as missing rather than accepting it",
    (blankName) => {
      expect(() => resolveLiveSandboxCredentials({ ...FULL_LIVE_ENV, [blankName]: "   " })).toThrow(
        blankName
      );
    }
  );
});
