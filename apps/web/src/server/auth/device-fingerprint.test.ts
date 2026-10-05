import { describe, expect, it } from "vitest";

import {
  NEW_DEVICE_WINDOW_MS,
  hashFingerprint,
  isNewDevice,
} from "@/server/auth/device-fingerprint";

/**
 * Unit contract — session device fingerprinting and the "new device" decision
 * (OP-89, contract §1.1 "after session created", schema §13.5).
 *
 * On every session creation the identity hook fingerprints the request
 * (user-agent, client IP, accepted languages) and decides whether this is a
 * device the user has not used in the last 24 hours. A new device emits
 * `auth.signin.new_device` (1/device/24h); a repeat does not. The fingerprints
 * are hashed **with the deployment salt** so a leaked fingerprint cannot be
 * reversed into an IP or user-agent (data minimisation, schema §13.5).
 *
 * Contract expected of the implementation
 * (`@/server/auth/device-fingerprint`):
 *
 *   hashFingerprint(parts, salt): string
 *     parts: { userAgent?: string | null; ip?: string | null;
 *              acceptLanguage?: string | null }
 *     - Deterministic: the same parts and salt always hash identically.
 *     - Salted: a different salt yields a different digest for the same parts.
 *     - Sensitive to each part: changing any single part changes the digest.
 *     - A lowercase-hex SHA-256 digest (64 chars) that never contains the raw
 *       user-agent or IP.
 *
 *   isNewDevice({ fingerprintHash, prior, now, windowMs }): boolean
 *     prior: readonly { fingerprintHash: string; createdAt: Date }[]
 *     - true when no prior fingerprint matches within (now - windowMs, now].
 *     - false when the same fingerprint was seen inside the window.
 *     - true again once the last matching sighting falls outside the window.
 *
 *   NEW_DEVICE_WINDOW_MS === 24 * 60 * 60 * 1000
 */

/** A deterministic instant for the window-boundary specs. */
const T0 = new Date("2026-03-01T00:00:00.000Z");

const PARTS = {
  userAgent: "Mozilla/5.0 (TestBrowser)",
  ip: "203.0.113.7",
  acceptLanguage: "en-IN,en;q=0.9",
};

describe("hashFingerprint — stability and salting", () => {
  it("U2: hashes the same parts and salt to the same digest", () => {
    expect(hashFingerprint(PARTS, "salt-one")).toBe(hashFingerprint(PARTS, "salt-one"));
  });

  it("U2: produces a different digest under a different salt", () => {
    expect(hashFingerprint(PARTS, "salt-one")).not.toBe(hashFingerprint(PARTS, "salt-two"));
  });

  it.each([
    ["userAgent", { ...PARTS, userAgent: "DifferentBrowser" }],
    ["ip", { ...PARTS, ip: "198.51.100.9" }],
    ["acceptLanguage", { ...PARTS, acceptLanguage: "fr-FR" }],
  ])("U2: a change in %s changes the digest", (_part, changed) => {
    expect(hashFingerprint(changed, "salt-one")).not.toBe(hashFingerprint(PARTS, "salt-one"));
  });

  it("U2: emits a 64-character lowercase hex digest that leaks no raw part", () => {
    const digest = hashFingerprint(PARTS, "salt-one");

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(PARTS.ip);
    expect(digest).not.toContain(PARTS.userAgent);
    expect(digest).not.toContain(PARTS.acceptLanguage);
  });
});

describe("isNewDevice — the 24h per-device decision", () => {
  it("U3: reports a device as new when there is no prior sighting", () => {
    expect(
      isNewDevice({
        fingerprintHash: "abc",
        prior: [],
        now: T0,
        windowMs: NEW_DEVICE_WINDOW_MS,
      })
    ).toBe(true);
  });

  it("U3: reports a device as known when the same fingerprint was seen inside the window", () => {
    expect(
      isNewDevice({
        fingerprintHash: "abc",
        prior: [{ fingerprintHash: "abc", createdAt: new Date(T0.getTime() - 1_000) }],
        now: T0,
        windowMs: NEW_DEVICE_WINDOW_MS,
      })
    ).toBe(false);
  });

  it("U3: reports a device as new when the last matching sighting is outside the window", () => {
    expect(
      isNewDevice({
        fingerprintHash: "abc",
        prior: [
          { fingerprintHash: "abc", createdAt: new Date(T0.getTime() - NEW_DEVICE_WINDOW_MS - 1) },
        ],
        now: T0,
        windowMs: NEW_DEVICE_WINDOW_MS,
      })
    ).toBe(true);
  });

  it("U3: does not treat a different device's sighting as this device", () => {
    expect(
      isNewDevice({
        fingerprintHash: "abc",
        prior: [{ fingerprintHash: "other", createdAt: new Date(T0.getTime() - 1_000) }],
        now: T0,
        windowMs: NEW_DEVICE_WINDOW_MS,
      })
    ).toBe(true);
  });

  it("U3: finds a matching sighting among several prior devices", () => {
    expect(
      isNewDevice({
        fingerprintHash: "abc",
        prior: [
          { fingerprintHash: "other-1", createdAt: new Date(T0.getTime() - 3_600_000) },
          { fingerprintHash: "abc", createdAt: new Date(T0.getTime() - 3_600_000) },
          { fingerprintHash: "other-2", createdAt: new Date(T0.getTime() - 60_000) },
        ],
        now: T0,
        windowMs: NEW_DEVICE_WINDOW_MS,
      })
    ).toBe(false);
  });
});
