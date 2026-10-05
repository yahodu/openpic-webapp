import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * Sessions & devices projection helpers (OP-91, contract §1.3).
 *
 * `GET /api/v1/me/sessions` lists the caller's **active** sessions with a
 * human-readable `deviceLabel` and a `current` flag, and never the raw IP,
 * user-agent, session token or owning user id (§0.15). The pure pieces the
 * route composes live here so they are unit-testable without a database:
 *
 *   - {@link mapUserAgentToDeviceLabel} — the browser/OS detection table;
 *   - {@link toSessionSummary} — the §1.3 projection of one stored session.
 *
 * The browser is detected **before** the operating system because an Edge or
 * iOS-Chrome agent string also carries `Chrome`/`Safari` tokens; anything
 * unrecognisable degrades to `Unknown device` rather than echoing the agent.
 */

/** The Better Auth-owned session collection (schema §13.1). */
export const SESSION_COLLECTION = "session";

/** The stored shape of a Better Auth session the projection reads. */
export interface StoredSession {
  readonly _id?: unknown;
  readonly userId?: unknown;
  readonly token?: unknown;
  readonly userAgent?: unknown;
  readonly ipAddress?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly expiresAt?: unknown;
}

/** One session summary as returned by the list route (§1.3). */
export const sessionSummarySchema = z.object({
  id: z.string(),
  current: z.boolean(),
  deviceLabel: z.string(),
  ipCountry: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
});

/** The `GET /me/sessions` response body. */
export const sessionsListSchema = z.object({ data: z.array(sessionSummarySchema) });

/** A projected session summary. */
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** Detect the browser token, most specific first. */
function detectBrowser(userAgent: string): string | null {
  if (userAgent.includes("Edg/")) {
    return "Edge";
  }
  // `CriOS` is Chrome on iOS and also carries `Safari`; check it before Safari.
  if (userAgent.includes("CriOS/")) {
    return "Chrome";
  }
  if (userAgent.includes("Firefox/")) {
    return "Firefox";
  }
  if (userAgent.includes("Chrome/")) {
    return "Chrome";
  }
  if (userAgent.includes("Safari/")) {
    return "Safari";
  }
  return null;
}

/** Detect the operating system, phone/tablet platforms before desktop. */
function detectOs(userAgent: string): string | null {
  // An iPhone/iPad agent string also contains `like Mac OS X`, so this runs
  // before the macOS check.
  if (userAgent.includes("iPhone") || userAgent.includes("iPad") || userAgent.includes("iPod")) {
    return "iOS";
  }
  if (userAgent.includes("Android")) {
    return "Android";
  }
  if (userAgent.includes("Macintosh") || userAgent.includes("Mac OS X")) {
    return "macOS";
  }
  if (userAgent.includes("Windows")) {
    return "Windows";
  }
  return null;
}

/**
 * Map a stored user-agent to a canonical, human-readable device label.
 *
 * @param userAgent - The stored agent string, or a null/absent value.
 * @returns `"<Browser> on <OS>"`, or `"Unknown device"` when either part is
 *   unrecognised (the raw agent is never echoed).
 */
export function mapUserAgentToDeviceLabel(userAgent: string | null | undefined): string {
  if (typeof userAgent !== "string" || userAgent.trim() === "") {
    return "Unknown device";
  }
  const browser = detectBrowser(userAgent);
  const os = detectOs(userAgent);
  if (browser === null || os === null) {
    return "Unknown device";
  }
  return `${browser} on ${os}`;
}

/** Read a stored id (ObjectId or string) as its hex string form, or `null`. */
function asHexString(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return typeof value === "string" ? value : null;
}

/** Read a stored date as an ISO string, falling back to `null`. */
function asIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/**
 * Project one stored session onto the §1.3 summary.
 *
 * @param session - The stored Better Auth session document.
 * @param currentSessionId - The caller's own session id (hex), or `null`.
 * @returns The summary; raw IP/user-agent/token/userId are dropped (§0.15).
 */
export function toSessionSummary(
  session: StoredSession,
  currentSessionId: string | null
): SessionSummary {
  const id = asHexString(session._id) ?? "";
  const createdAt = asIsoString(session.createdAt);
  return {
    id,
    current: currentSessionId !== null && id === currentSessionId,
    deviceLabel: mapUserAgentToDeviceLabel(
      typeof session.userAgent === "string" ? session.userAgent : null
    ),
    // There is no geo resolver in the codebase yet: the raw IP is never
    // returned and `ipCountry` stays `null` until one exists (ADR-0068 §6).
    ipCountry: null,
    createdAt: createdAt ?? "",
    lastActiveAt: asIsoString(session.updatedAt) ?? createdAt ?? "",
    expiresAt: asIsoString(session.expiresAt) ?? "",
  };
}
