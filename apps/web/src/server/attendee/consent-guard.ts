import type { Db, ObjectId } from "mongodb";

import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { tenantRepo } from "@/server/repos";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `requireConsent` — the biometric gate every selfie endpoint calls (OP-131,
 * contract §6.2/§6.3, Appendix A.7, schema §15.4; ADR-0789 §3, ADR-0790).
 *
 * Contract §6.2 makes consent a hard precondition of the whole attendee
 * surface, so the gate resolves the consent **in force**: the current policy
 * version from `platformSettings.legal`, and the latest non-withdrawn
 * `consents` row the subject holds at that version. Two ways a granted consent
 * stops being valid are therefore refused by construction, not by a status
 * flag: a withdrawal (`withdrawnAt` set) and a policy version that moved on
 * (`legal.biometricPolicyVersion` edited). The refusal is `412
 * consent_required` carrying the three details Appendix A.7 fixes, so the
 * client can render the policy and retry.
 */

/** The one consent purpose the attendee surface asks for (contract §6.2). */
export const CONSENT_PURPOSE = "biometric_processing";

/** The subject a consent belongs to (schema §10.3): an attendee, or a user. */
export type ConsentSubject =
  | { readonly kind: "anonymous"; readonly attendeeSessionId: string }
  | { readonly kind: "user"; readonly userId: ObjectId };

/** Options for {@link requireConsent}. */
export interface RequireConsentOptions {
  /** The database holding `consents` and `platformSettings`. */
  readonly db: Db;
  /** The event's tenant (hex, as stored on the event row). */
  readonly tenantKey: string;
  /** The event the consent must be for. */
  readonly eventId: ObjectId;
  /** The subject the consent must belong to. */
  readonly subject: ConsentSubject;
}

/** The current policy an `consent_required` refusal names. */
export interface RequiredPolicy {
  readonly requiredPolicyVersion: string;
  readonly policyUrl: string;
}

/**
 * Build the `412 consent_required` refusal (Appendix A.7).
 *
 * @param policy - The current policy the client has to agree to.
 * @returns The refusal, carrying the purpose and the policy it names.
 */
export function consentRequiredError(policy: RequiredPolicy): Error {
  return appError("consent_required", {
    details: {
      purpose: CONSENT_PURPOSE,
      requiredPolicyVersion: policy.requiredPolicyVersion,
      policyUrl: policy.policyUrl,
    },
  });
}

/**
 * Resolve the consent in force for one subject on one event.
 *
 * @param options - The database, tenant, event and subject.
 * @returns The id of the consent in force.
 * @throws {AppError} `consent_required` (412) when there is none — no row, a
 *   withdrawn row, or a row granted at a policy version the platform retired.
 */
export async function requireConsent(
  options: RequireConsentOptions
): Promise<{ readonly consentId: ObjectId }> {
  const settings = await getPlatformSettings({ db: options.db });
  const requiredPolicyVersion = settings.legal.biometricPolicyVersion;

  const row = (await tenantRepo(options.tenantKey, options.db)
    .collection(COLLECTIONS.consents)
    .findOne(
      {
        eventId: options.eventId,
        purpose: CONSENT_PURPOSE,
        policyVersion: requiredPolicyVersion,
        withdrawnAt: null,
        ...subjectFilter(options.subject),
      },
      { sort: { grantedAt: -1 }, projection: { _id: 1 } }
    )) as { readonly _id: ObjectId } | null;

  if (row === null) {
    throw consentRequiredError({
      requiredPolicyVersion,
      policyUrl: settings.legal.biometricPolicyUrl,
    });
  }
  return { consentId: row._id };
}

/**
 * The stored `subject` predicate for one subject (schema §10.3).
 *
 * Exported because the grant links the consent to an `attendeeEventProfiles`
 * row carrying the same subject, and both lookups must agree on its shape.
 *
 * @param subject - The subject a row must belong to.
 * @returns A filter matching exactly that subject.
 */
export function subjectFilter(subject: ConsentSubject): Record<string, unknown> {
  return subject.kind === "anonymous"
    ? { "subject.kind": "anonymous", "subject.attendeeSessionId": subject.attendeeSessionId }
    : { "subject.kind": "user", "subject.userId": subject.userId };
}
