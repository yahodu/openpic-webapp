import { describe, expect, it } from "vitest";

/**
 * I1 — sentinel proving the integration harness fails closed on unknown
 * outbound HTTP. The integration setup starts MSW `setupServer` with
 * `onUnhandledRequest: 'error'`; an unmocked request must therefore reject
 * instead of silently hitting the network.
 *
 * MSW surfaces the `error` strategy as an InternalError whose message is
 * "Cannot bypass a request when using the \"error\" strategy ...". Matching
 * that message (rather than a generic rejection) is what makes this a real
 * guard: a live network call would either resolve or reject with a transport
 * error, neither of which matches.
 */
describe("MSW integration harness", () => {
  it("rejects an outbound request that matches no handler", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(/Cannot bypass a request/i);
  });
});
