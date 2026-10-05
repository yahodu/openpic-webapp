import { sha256Hex } from "@/server/runtime/crypto";

/**
 * Session device fingerprinting and the "new device" decision (OP-89, contract
 * §1.1 "after session created", schema §13.5).
 *
 * A session-created hook fingerprints the request (user-agent, client IP,
 * accepted languages) and decides whether this is a device the user has not
 * used in the last 24 hours. Fingerprints are hashed **with the deployment
 * salt** so a leaked digest cannot be reversed into an IP or user-agent (data
 * minimisation): the outbox payload carries only a salted `deviceHash`.
 */

/** The documented "new device" window: one sighting per device per 24 hours. */
export const NEW_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The request components a device fingerprint is derived from. */
export interface FingerprintParts {
  readonly userAgent?: string | null;
  readonly ip?: string | null;
  readonly acceptLanguage?: string | null;
}

/** One previously seen device fingerprint and when it was seen. */
export interface PriorDeviceSighting {
  readonly fingerprintHash: string;
  readonly createdAt: Date;
}

/** The inputs to the pure 24-hour "is this a new device?" decision. */
export interface NewDeviceInput {
  /** The salted fingerprint hash of the device being considered. */
  readonly fingerprintHash: string;
  /** Prior sightings for the same user, newest or oldest order irrelevant. */
  readonly prior: readonly PriorDeviceSighting[];
  /** The instant to measure the window against. */
  readonly now: Date;
  /** The window length in milliseconds. */
  readonly windowMs: number;
}

/**
 * Hash a device fingerprint with the deployment salt.
 *
 * Deterministic for a given parts/salt pair, salted (a different salt yields a
 * different digest) and sensitive to each part.
 *
 * @param parts - The user-agent, client IP and accepted languages.
 * @param salt - The deployment salt (`getRateLimitConfig().salt`).
 * @returns A 64-character lowercase hex SHA-256 digest that leaks no raw part.
 */
export function hashFingerprint(parts: FingerprintParts, salt: string): string {
  const canonical = [salt, parts.userAgent ?? "", parts.ip ?? "", parts.acceptLanguage ?? ""].join(
    "\u0000"
  );
  return sha256Hex(canonical);
}

/**
 * Decide whether a device is new to a user inside the rolling window.
 *
 * A device is **not** new when a prior sighting with the same fingerprint hash
 * falls within `(now - windowMs, now]`; it is new when there is no such
 * sighting (never seen, seen only outside the window, or only a different
 * device was seen).
 *
 * @param input - The fingerprint, prior sightings, instant and window.
 * @returns `true` when the device counts as new.
 */
export function isNewDevice(input: NewDeviceInput): boolean {
  const nowMs = input.now.getTime();
  const sinceMs = nowMs - input.windowMs;

  const seen = input.prior.some(
    (sighting) =>
      sighting.fingerprintHash === input.fingerprintHash &&
      sighting.createdAt.getTime() > sinceMs &&
      sighting.createdAt.getTime() <= nowMs
  );

  return !seen;
}
