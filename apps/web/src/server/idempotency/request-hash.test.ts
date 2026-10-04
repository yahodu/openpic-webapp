import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson, requestHash } from "./index";

/**
 * U2 — `requestHash` (API contract §0.9).
 *
 * `requestHash = sha256(canonicalJson(body) + "\n" + resolvedTenantId + "\n" + userId)`.
 *
 * The tenant and the user are part of the hash, so the same key presented with
 * the same body by two different principals can never be mistaken for a replay
 * of one another (see the I8 integration case). An absent tenant/user is
 * treated as the empty string.
 */

/** The reference digest, computed independently of the production helper. */
function expectedHash(body: unknown, tenantId: string, userId: string): string {
  return createHash("sha256")
    .update(`${String(canonicalJson(body))}\n${tenantId}\n${userId}`)
    .digest("hex");
}

describe("requestHash", () => {
  it("U2: is the sha256 of canonicalJson(body), tenant and user", () => {
    const body = { b: 1, a: { d: 4, c: 3 } };

    expect(requestHash({ body, tenantId: "tenant-1", userId: "user-a" })).toBe(
      expectedHash(body, "tenant-1", "user-a")
    );
  });

  it("U2: is a 64-character lowercase hex digest", () => {
    expect(requestHash({ body: { amount: 1 }, tenantId: "tenant-1", userId: "user-a" })).toMatch(
      /^[0-9a-f]{64}$/
    );
  });

  it("U2: changes when the tenant changes", () => {
    const body = { amount: 1 };

    expect(requestHash({ body, tenantId: "tenant-1", userId: "user-a" })).not.toBe(
      requestHash({ body, tenantId: "tenant-2", userId: "user-a" })
    );
  });

  it("U2: changes when the user changes", () => {
    const body = { amount: 1 };

    expect(requestHash({ body, tenantId: "tenant-1", userId: "user-a" })).not.toBe(
      requestHash({ body, tenantId: "tenant-1", userId: "user-b" })
    );
  });

  it("U2: changes when the body changes", () => {
    expect(requestHash({ body: { amount: 1 }, tenantId: "t", userId: "u" })).not.toBe(
      requestHash({ body: { amount: 2 }, tenantId: "t", userId: "u" })
    );
  });

  it("U2: is stable across equivalent key orderings of the same body", () => {
    expect(requestHash({ body: { a: 1, b: 2 }, tenantId: "t", userId: "u" })).toBe(
      requestHash({ body: { b: 2, a: 1 }, tenantId: "t", userId: "u" })
    );
  });

  it("U2: treats an absent tenant and user as the empty string", () => {
    expect(requestHash({ body: { amount: 1 } })).toBe(expectedHash({ amount: 1 }, "", ""));
  });
});
