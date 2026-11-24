import type { ClientSession } from "mongodb";

import { hashFingerprint } from "@/server/auth/device-fingerprint";
import { getRateLimitConfig, getTrustedClientIpHeader } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { resolveClientIp } from "@/server/rate-limit/client-ip";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";

/**
 * The `auditLogs` write seam (ADR-0970 §D2, schema §20.2/§22).
 *
 * A workspace-member mutation writes one durable row per call, **inside** the
 * same transaction as the membership change (ADR-0970 §D3), so one writer is
 * shared by both verbs instead of an inline insert per route drifting in TTL
 * arithmetic and fingerprinting. The two billing downgrade jobs write their
 * `subscription.downgraded` row through the same seam (ADR-0975 §D3). The row
 * is what the §9.9 audit reader will serve; the structured log line stays the
 * operator's tail (ADR-0970 §D4).
 */

/** §22's retention: a full audit year, 400 days. */
const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** The `auditLogs` action union this lane writes (schema §20.2, ADR-0970 §D1). */
export type AuditLogAction = "member.role_changed" | "member.removed" | "subscription.downgraded";

/** A user principal, with both request fingerprints already hashed (§D2). */
export interface AuditUserActor {
  readonly kind: "user";
  readonly id: string;
  readonly ipHash: string;
  readonly uaHash: string;
}

/** A job principal: no request to fingerprint, so both digests are null (§D3). */
export interface AuditSystemActor {
  readonly kind: "system";
  readonly id: string;
  readonly ipHash: null;
  readonly uaHash: null;
}

/** The acting principal (§D2, §D3). */
export type AuditActor = AuditUserActor | AuditSystemActor;

/** One `auditLogs` document, minus the two instants the writer stamps (§D2). */
export interface AuditLogEntry {
  readonly actor: AuditActor;
  readonly action: AuditLogAction;
  readonly target: { readonly kind: "user" | "subscription"; readonly id: string };
  readonly tenantId: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  /** Written only when the transition carries one (§20.2, ADR-0975 §D3). */
  readonly reason?: string;
}

/**
 * The retention instant for a row written at `at` (§20.2, §22).
 *
 * @param at - The instant the row is stamped with.
 * @returns A new `Date` exactly 400 × 24 h after `at`; `at` is not mutated.
 */
export function auditExpireAt(at: Date): Date {
  return new Date(at.getTime() + AUDIT_RETENTION_MS);
}

/**
 * Build the actor for one mutating call (§D2).
 *
 * The client address and user agent are stored only as salted SHA-256 digests,
 * on the shipped {@link hashFingerprint} scheme, so a row never carries a raw
 * address or agent (§0.15).
 *
 * @param request - The inbound request.
 * @param id - The acting principal's Better Auth user id.
 * @returns The actor sub-document.
 */
export function requestAuditActor(request: Request, id: string): AuditActor {
  const salt = getRateLimitConfig().salt;
  return {
    kind: "user",
    id,
    ipHash: hashFingerprint(
      { ip: resolveClientIp(request.headers, getTrustedClientIpHeader()) ?? null },
      salt
    ),
    uaHash: hashFingerprint({ userAgent: request.headers.get("user-agent") }, salt),
  };
}

/**
 * Build the actor for a job-issued transition (§D3).
 *
 * A cron job has no HTTP request to fingerprint, so both digest keys stay
 * **present and null**: every row carries the same four-key actor, and a system
 * row can never be read as an unhashed user row.
 *
 * @param id - The job's own name (`dunning`, `scheduled-plan-changes`).
 * @returns The actor sub-document.
 */
export function systemAuditActor(id: string): AuditSystemActor {
  return { kind: "system", id, ipHash: null, uaHash: null };
}

/**
 * Insert one `auditLogs` row with the caller's session, so the write joins the
 * route's transaction (§D3): an insert failure aborts the mutation.
 *
 * @param session - The transaction session the caller is running in.
 * @param entry - The row's fixed fields; `at`/`expireAt` are stamped here from
 *   one instant.
 * @param at - The instant the row is stamped with; a job passes its own
 *   injected `clock.now()`, so the row and the transition share one instant.
 */
export async function writeAuditLog(
  session: ClientSession,
  entry: AuditLogEntry,
  at: Date = systemClock.now()
): Promise<void> {
  // A member row carries no `reason` key at all — spread it only when present.
  const { reason, ...fields } = entry;
  await platformRepo(getDb())
    .collection(COLLECTIONS.auditLogs)
    .insertOne(
      { ...fields, ...(reason === undefined ? {} : { reason }), at, expireAt: auditExpireAt(at) },
      { session }
    );
}
