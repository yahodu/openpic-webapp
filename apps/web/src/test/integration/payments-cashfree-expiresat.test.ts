import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createCashfreeProvider } from "@/server/adapters/cashfree/cashfree-provider";
import { UpstreamContractError } from "@/server/adapters/transport-error";

import {
  makeCashfreeCreateSubscriptionResponse,
  makeCreateMandateInput,
  makePaymentProviderConfig,
} from "../factories/payment";
import { server } from "./setup";

/**
 * I1–I2 — `createMandate().expiresAt` is canonicalized at the adapter boundary
 * (OP-105 follow-up, review finding F1).
 *
 * The contract fixes one shape for every `Timestamp`: `docs/API Contract.md`
 * §0.13 (line 360) is `RFC 3339 UTC, ms precision, Z` and §3.3 (line 1088)
 * serves `checkout.expiresAt` in that exact form. The OP-107 checkout route
 * projects `checkout.expiresAt` straight from `createMandate().expiresAt`, so a
 * verbatim passthrough would put the vendor's IST offset on our wire.
 *
 * Cashfree answers `subscription_expiry_time` as ISO 8601 with an explicit
 * `+05:30` offset, second precision, no ms and no `Z` ("We store timestamps in
 * IST", `.../subscription/create-subscription`). The adapter — the one module
 * that speaks Cashfree and already normalizes statuses, failure categories,
 * amounts and events at this boundary — converts it, so the port stays
 * provider-neutral and every downstream route is a pure projection.
 *
 * I1: a vendor IST-offset expiry comes back as the RFC 3339 UTC ms `Z` value.
 * I2: a value that cannot be parsed is refused, never returned as garbage.
 */

/**
 * The canonical form §0.13 mandates: RFC 3339, UTC, millisecond precision, `Z`.
 */
const RFC_3339_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The vendor's wire shape: an explicit IST offset. Cashfree's `string<ISO8601>`
 * `subscription_expiry_time` is second-precision and carries no `Z`.
 */
const VENDOR_IST_OFFSET = /[+-]\d{2}:\d{2}$/;

/** The sandbox subscriptions endpoint the adapter posts a mandate to. */
const CREATE_URL = "https://sandbox.cashfree.com/pg/subscriptions";

/** Answer the next `createMandate` with a response carrying `subscriptionExpiryTime` verbatim. */
function answerCreateWith(subscriptionExpiryTime: string): void {
  server.use(
    http.post(CREATE_URL, () =>
      HttpResponse.json(
        makeCashfreeCreateSubscriptionResponse({
          subscription_expiry_time: subscriptionExpiryTime,
        })
      )
    )
  );
}

describe("Cashfree createMandate expiry normalization (MSW)", () => {
  it.each([
    // The vendor docs' own example.
    ["2025-06-01T10:20:12+05:30", "2025-06-01T04:50:12.000Z"],
    // Crosses both the day and the year boundary (and the 2100 leap-rule edge).
    ["2100-01-01T23:00:08+05:30", "2100-01-01T17:30:08.000Z"],
    // The shared factory default, so the fixture itself stays vendor-shaped.
    ["2026-11-01T10:30:46+05:30", "2026-11-01T05:00:46.000Z"],
  ])(
    "I1: returns the vendor expiry %s as the RFC 3339 UTC ms `Z` value %s",
    async (vendorExpiry, expected) => {
      // Arrange — the input must be the vendor's shape (offset-bearing, no ms, no
      // `Z`), or the pin would pass vacuously against a verbatim passthrough.
      expect(vendorExpiry).toMatch(VENDOR_IST_OFFSET);
      expect(vendorExpiry).not.toMatch(/\.\d/);
      expect(vendorExpiry).not.toMatch(/Z$/);
      answerCreateWith(vendorExpiry);
      const provider = createCashfreeProvider(makePaymentProviderConfig());

      // Act
      const result = await provider.createMandate(makeCreateMandateInput());

      // Assert — the offset is consumed rather than carried, and the result is
      // exactly what §0.13 admits.
      expect(result.expiresAt).toBe(expected);
      expect(result.expiresAt).toMatch(RFC_3339_UTC_MS);
    }
  );

  it("I2: refuses an unparseable vendor expiry instead of returning it verbatim", async () => {
    // Arrange
    answerCreateWith("not-a-timestamp");
    const provider = createCashfreeProvider(makePaymentProviderConfig());

    // Act & Assert — a value that cannot become RFC 3339 must not reach a caller
    // as `Invalid Date` or as a raw vendor string.
    await expect(provider.createMandate(makeCreateMandateInput())).rejects.toBeInstanceOf(
      UpstreamContractError
    );
  });
});
