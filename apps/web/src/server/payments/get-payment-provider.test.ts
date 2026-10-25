import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeCreateMandateInput } from "@/test/factories/payment";
import { makeEnv, makeProductionEnv, type EnvInput } from "@/test/factories/env";

/**
 * Unit contract — the payment composition root (OP-105 GREEN §9; the
 * `getPaymentProvider` config selector of OP-107's checkout route).
 *
 * `getPaymentProvider()` maps the validated `PAYMENT_PROVIDER` selection onto a
 * concrete `PaymentProvider`, exactly as `getMessageTransport()` maps
 * `MESSAGE_TRANSPORT` onto a concrete `MessageTransport`:
 *
 *   - `memory` — the in-process provider an e2e drives (`APP_ENV=e2e`, and the
 *     documented default everywhere `memory` is legal);
 *   - any other selection — **not** the memory provider (the production path).
 *
 * The production refusal is doubly pinned. `getConfig()` already rejects
 * `PAYMENT_PROVIDER=memory` under `APP_ENV=production` (kept green in
 * `config/env.test.ts`); this spec adds the selector-level property that
 * matters for honesty: the selector must obtain its selection through
 * `getConfig()` and therefore **cannot** hand a memory provider to a production
 * process that read `process.env` behind the validator's back.
 */

const ORIGINAL_ENV = process.env;

/**
 * Import a fresh copy of the selector under a given environment, so the config
 * module's "parse once" cache cannot leak between cases.
 *
 * @param overrides - Environment overrides on top of a valid development env.
 * @returns The selector plus the `ConfigError` class the same env module raises.
 */
async function loadSelector(overrides: EnvInput): Promise<{
  readonly getPaymentProvider: () => import("@/server/payments/payment-provider").PaymentProvider;
  readonly ConfigError: new (keys: readonly string[]) => Error;
}> {
  const env = makeEnv(overrides);
  const clean = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  process.env = { ...clean } as unknown as NodeJS.ProcessEnv;

  vi.resetModules();
  const envModule = await import("@/server/config/env");
  const { getPaymentProvider } = await import("@/server/payments/get-payment-provider");
  return { getPaymentProvider, ConfigError: envModule.ConfigError };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.resetModules();
});

describe("getPaymentProvider — the memory provider under e2e", () => {
  it("returns the memory provider when PAYMENT_PROVIDER=memory", async () => {
    // Arrange
    const { getPaymentProvider } = await loadSelector({
      APP_ENV: "e2e",
      PAYMENT_PROVIDER: "memory",
    });

    // Act
    const provider = getPaymentProvider();
    const result = await provider.createMandate(makeCreateMandateInput());

    // Assert
    expect(result.externalRefs[0]).toMatchObject({ provider: "memory", kind: "subscription" });
  });

  it("returns the memory provider when PAYMENT_PROVIDER is unset (the documented default)", async () => {
    // Arrange — the e2e launcher sets only APP_ENV=e2e.
    const { getPaymentProvider } = await loadSelector({
      APP_ENV: "e2e",
      PAYMENT_PROVIDER: undefined,
    });

    // Act
    const provider = getPaymentProvider();
    const result = await provider.createMandate(makeCreateMandateInput());

    // Assert
    expect(result.externalRefs[0]).toMatchObject({ provider: "memory", kind: "subscription" });
  });

  it("returns the memory provider in development", async () => {
    // Arrange
    const { getPaymentProvider } = await loadSelector({
      APP_ENV: "development",
      PAYMENT_PROVIDER: "memory",
    });

    // Act
    const provider = getPaymentProvider();
    const result = await provider.createMandate(makeCreateMandateInput());

    // Assert
    expect(result.externalRefs[0]).toMatchObject({ provider: "memory" });
  });
});

describe("getPaymentProvider — the production path keeps refusing memory", () => {
  it("refuses to build a provider when memory is selected in production", async () => {
    // Arrange
    const env = makeProductionEnv({ PAYMENT_PROVIDER: "memory" });
    const clean = Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    process.env = { ...clean } as unknown as NodeJS.ProcessEnv;

    vi.resetModules();
    const { ConfigError } = await import("@/server/config/env");
    const { getPaymentProvider } = await import("@/server/payments/get-payment-provider");

    // Act
    let thrown: unknown;
    try {
      getPaymentProvider();
    } catch (error) {
      thrown = error;
    }

    // Assert
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toMatch(/PAYMENT_PROVIDER/);
  });
});
