import { ObjectId, type Db } from "mongodb";

import { buildConsentEvidence } from "@/server/attendee/consent-evidence";
import { currentPolicies, type PolicyPurpose } from "@/server/compliance/policies";
import { COLLECTIONS } from "@/server/db/collections";
import { appError } from "@/server/http/errors";
import { platformRepo } from "@/server/repos";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * The policy-acknowledgement write, as a callable unit (OP-140 precondition,
 * contract §8.2, schema §15.4; ADR-0910 §2, ADR-0911).
 *
 * `POST /api/v1/me/consents/acknowledge` owned this write end to end until
 * OP-140 needed the same write for its `policy × acknowledge` notification
 * action. The route is now a thin delegate: this module resolves the served
 * document for the `purpose`, refuses a retired version, derives the §15.4
 * evidence from the facts it is handed and inserts one `consents` row.
 *
 * The route keeps its zod body and answer schemas; this module sees no request
 * and no clock, so the in-app method is its own invariant and the caller's
 * `now` is the recorded instant. It is **not** idempotent: a repeat inserts a
 * second row, which is the route's shipped behaviour (characterization pin
 * `I25`, ADR-0901 §5) and not something a delegate may silently change.
 */

/** How the in-app acknowledgement was given (§15.4, §8.2). */
const METHOD = "in_app_action";

/** The raw request facts §15.4 hashes, without the surface's method. */
export interface ConsentEvidenceFacts {
  /** The deployment salt (`getRateLimitConfig().salt`). */
  readonly salt: string;
  /** The client address, or `null` when it could not be resolved. */
  readonly ip: string | null;
  /** The raw `user-agent` header, or `null`. */
  readonly userAgent: string | null;
  /** The raw `accept-language` header, or `null`. */
  readonly acceptLanguage: string | null;
}

/** The acknowledgement one caller asks for. */
export interface AcknowledgeConsentInput {
  /** The database handle to write through. */
  readonly db: Db;
  /** The principal's 24-hex id (`ctx.principal`). */
  readonly userId: string;
  /** The document purpose being acknowledged. */
  readonly purpose: PolicyPurpose;
  /** The version the caller acknowledges. */
  readonly policyVersion: string;
  /** The instant the grant is recorded at. */
  readonly now: Date;
  /** The request facts the stored evidence is derived from. */
  readonly evidence: ConsentEvidenceFacts;
}

/** The `201` receipt the route answers (§8.2). */
export interface ConsentAcknowledgement {
  /** The stored row's 24-hex id. */
  readonly id: string;
  /** The acknowledged document's purpose. */
  readonly purpose: string;
  /** The acknowledged document's version. */
  readonly policyVersion: string;
  /** The acknowledged document's digest (§15.4). */
  readonly policyDocumentHash: string;
  /** The recorded instant, ISO 8601. */
  readonly grantedAt: string;
  /** Always `null`: withdrawal is a later write. */
  readonly withdrawnAt: null;
}

/**
 * Record one policy acknowledgement.
 *
 * @param input - The database, principal, purpose, acknowledged version, the
 * recorded instant and the raw request facts.
 * @returns The receipt the route answers, `grantedAt` being `input.now`.
 * @throws An `AppError` `validation_failed` (`422`) for a purpose the current
 * list does not serve, or `policy_version_stale` (`422`) for a version that is
 * not that purpose's served version; nothing is written in either case.
 */
export async function acknowledgeConsent(
  input: AcknowledgeConsentInput
): Promise<ConsentAcknowledgement> {
  const settings = await getPlatformSettings({ db: input.db });
  const document = currentPolicies(settings).find((entry) => entry.purpose === input.purpose);

  if (document === undefined) {
    throw appError("validation_failed", { details: { fields: [] } });
  }

  if (input.policyVersion !== document.version) {
    throw appError("policy_version_stale", {
      details: { currentPolicyVersion: document.version, policyUrl: document.url },
    });
  }

  const consentId = new ObjectId();
  await platformRepo(input.db)
    .collection(COLLECTIONS.consents)
    .insertOne({
      _id: consentId,
      // The in-app acknowledgement is platform-scope: it names no event.
      eventId: null,
      subject: { kind: "user", userId: new ObjectId(input.userId) },
      purpose: document.purpose,
      policyVersion: document.version,
      policyDocumentHash: document.documentHash,
      // Stored, not derived: the current-policy list only holds the current
      // version, so a rotation would strip the URL from older rows.
      policyUrl: document.url,
      method: METHOD,
      evidence: buildConsentEvidence({ ...input.evidence, method: METHOD }),
      grantedAt: input.now,
      withdrawnAt: null,
      createdAt: input.now,
    });

  return {
    id: consentId.toHexString(),
    purpose: document.purpose,
    policyVersion: document.version,
    policyDocumentHash: document.documentHash,
    grantedAt: input.now.toISOString(),
    withdrawnAt: null,
  };
}
