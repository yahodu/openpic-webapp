import { sha256Hex } from "@/server/runtime/crypto";

import { canonicalJson } from "./canonical-json";

/**
 * Request hashing for idempotency (API contract §0.9).
 *
 * `requestHash = sha256(canonicalJson(body) + "\n" + resolvedTenantId + "\n" + userId)`.
 *
 * The tenant and the user are part of the hash, so the same key presented with
 * the same body by two different principals can never be mistaken for a replay
 * of one another. An absent tenant/user is treated as the empty string.
 */

/** The inputs to {@link requestHash}. */
export interface RequestHashInput {
  /** The parsed request body. */
  readonly body: unknown;
  /** The resolved tenant id; absent means the empty string. */
  readonly tenantId?: string;
  /** The acting principal id; absent means the empty string. */
  readonly userId?: string;
}

/**
 * Compute the idempotency request hash.
 *
 * @param input - The body, tenant and user.
 * @returns A 64-character lowercase hex SHA-256 digest.
 */
export function requestHash(input: RequestHashInput): string {
  const body = canonicalJson(input.body);
  const tenantId = input.tenantId ?? "";
  const userId = input.userId ?? "";
  return sha256Hex(`${body}\n${tenantId}\n${userId}`);
}
