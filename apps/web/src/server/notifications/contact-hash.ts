import { createHash } from "node:crypto";

/**
 * The shared contact digest — one canonical form for every suppression lookup
 * key (OP-137, contract §10.1.3; design §19.6; ADR-0875 §1).
 *
 * Design §19.6 keys a suppression on `{channel, contactHash}` and the one-click
 * unsubscribe route already writes `sha256:` + this digest. Every site that
 * needs a *lookup key* therefore derives the same value here —
 * `sha256(trim().toLowerCase())`, 64 lowercase hex characters — because a
 * provider echoes the address it was handed in its own casing and spacing: a
 * second, independently written hash would produce a key that no stored row
 * ever matches.
 */

/**
 * Hash a contact into the canonical lookup digest.
 *
 * @param contact - The address the provider attempted (any casing, any padding).
 * @returns The 64 lowercase hex characters of `sha256(trimmed + lower-cased)`.
 */
export function contactHashOf(contact: string): string {
  return createHash("sha256").update(contact.trim().toLowerCase()).digest("hex");
}
