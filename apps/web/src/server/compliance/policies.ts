import { sha256Hex } from "@/server/runtime/crypto";
import type { PlatformSettings } from "@/server/settings/platform-settings";

/**
 * The policy documents the platform currently serves (OP-138, contract §8.2;
 * ADR-0898 §3).
 *
 * One list feeds both surfaces: `GET /legal/policies/current` publishes it and
 * `POST /me/consents/acknowledge` refuses a version that is not in it, so a
 * consent record and the public document can never name different versions.
 */

/** The document purposes the consent surface knows. */
export const POLICY_PURPOSES = ["terms_of_service", "biometric_processing"] as const;

/** A member of {@link POLICY_PURPOSES}. */
export type PolicyPurpose = (typeof POLICY_PURPOSES)[number];

/** One current policy document, as the public route answers it (§8.2). */
export interface PolicyDocument {
  readonly purpose: PolicyPurpose;
  readonly version: string;
  readonly url: string;
  readonly effectiveFrom: string;
  readonly documentHash: string;
}

/**
 * The digest of a policy document (schema §15.4).
 *
 * A version and its URL move together and name one immutable document, so the
 * digest is deterministic per version — two records acknowledging the same
 * version store the same value, which is what makes the evidence verifiable.
 *
 * @param version - The policy version.
 * @param url - The document's URL.
 * @returns `sha256:<64 hex>`.
 */
export function policyDocumentHash(version: string, url: string): string {
  return `sha256:${sha256Hex(`${version}\u0000${url}`)}`;
}

/**
 * The current document list in the §8.2 order.
 *
 * @param settings - The validated `platformSettings` singleton.
 * @returns The terms document, then the biometric one.
 */
export function currentPolicies(settings: PlatformSettings): readonly PolicyDocument[] {
  const legal = settings.legal;
  return [
    {
      purpose: "terms_of_service",
      version: legal.termsPolicyVersion,
      url: legal.termsPolicyUrl,
      effectiveFrom: legal.effectiveFrom,
      documentHash: policyDocumentHash(legal.termsPolicyVersion, legal.termsPolicyUrl),
    },
    {
      purpose: "biometric_processing",
      version: legal.biometricPolicyVersion,
      url: legal.biometricPolicyUrl,
      effectiveFrom: legal.effectiveFrom,
      documentHash: policyDocumentHash(legal.biometricPolicyVersion, legal.biometricPolicyUrl),
    },
  ];
}
