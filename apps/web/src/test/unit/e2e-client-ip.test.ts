import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { clientIpFor } from "../../../e2e/client-ip";

/**
 * The e2e suite must not share one `auth.otp` IP bucket (OP-117, ADR-0601 §D2).
 *
 * `auth.otp` is limited by contact **and** by client IP (15 / hour), and every
 * spec that sends an OTP without a forwarding header lands in the single bucket
 * the server stamps from its socket address. The suite as a whole then spends
 * more than 15 tokens and a later spec gets `429 too_many_requests` — a harness
 * budget bug that is invisible to any one spec and only shows up in a full run.
 *
 * These pins hold the suite-level property that removes the shared ceiling:
 * every OTP-sending spec announces its own private address, and no two specs
 * derive the same one.
 */

const e2eDir = fileURLToPath(new URL("../../../e2e/", import.meta.url));

/** Every Playwright spec file in the e2e directory. */
const specFiles = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts"));

/** The request paths the `auth.otp` limiter guards (`OTP_SEND_PATHS`). */
const OTP_SEND_PATHS = [
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/phone-number/send-otp",
];

/** One `readFileSync` call site, so the file readers stay countable. */
const readSpecFile = (name: string): string => readFileSync(join(e2eDir, name), "utf8");

describe("clientIpFor — the per-spec e2e client identity", () => {
  it("derives a private 10/8 host address from a spec file name", () => {
    // Act
    const ip = clientIpFor("auth.spec.ts");

    // Assert — `10/8` is RFC 1918, and the host octet is never 0 or 255.
    expect(ip).toMatch(/^10\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:[1-9]\d{0,2})$/);
    const hostOctet = Number(ip.split(".")[3]);
    expect(hostOctet).toBeGreaterThanOrEqual(1);
    expect(hostOctet).toBeLessThanOrEqual(254);
  });

  it("is stable for the same spec file", () => {
    // Assert
    expect(clientIpFor("webhook-inbox.spec.ts")).toBe(clientIpFor("webhook-inbox.spec.ts"));
  });

  it("gives every e2e spec its own address", () => {
    // Arrange
    expect(specFiles.length).toBeGreaterThan(0);

    // Act
    const addresses = specFiles.map((name) => clientIpFor(name));

    // Assert — a duplicated address is a shared bucket, i.e. the bug is back.
    expect(new Set(addresses).size).toBe(specFiles.length);
  });

  it("stamps x-forwarded-for with the spec's own identity on every OTP send", () => {
    // Arrange
    const otpSpecs = specFiles.filter((name) => {
      const source = readSpecFile(name);
      return OTP_SEND_PATHS.some((path) => source.includes(path));
    });

    // Assert — the filter is not vacuous: the suite really has OTP senders.
    expect(otpSpecs.length).toBeGreaterThan(0);

    for (const name of otpSpecs) {
      const source = readSpecFile(name);
      expect(source, `${name} must send x-forwarded-for`).toContain('"x-forwarded-for": CLIENT_IP');
      expect(source, `${name} must derive its own identity`).toContain(`clientIpFor("${name}")`);
    }
  });
});
