import { describe, expect, it } from "vitest";

import { mapUserAgentToDeviceLabel } from "./sessions";

/**
 * Unit — the `deviceLabel` mapping for the sessions list (OP-91, contract §1.3).
 *
 * `GET /api/v1/me/sessions` returns a human-readable `deviceLabel` for each
 * session ("Chrome on macOS"), never the raw user-agent. This spec pins the
 * browser/OS detection table the route projects a stored `session.userAgent`
 * through:
 *
 *   - the browser is detected **before** the OS, because an Edge or iOS-Chrome
 *     agent string also contains `Chrome`/`Safari` tokens (Edge carries both
 *     `Chrome` and `Safari`; `CriOS` carries `Safari`);
 *   - recognisable desktop and mobile agents map to the canonical
 *     `<Browser> on <OS>` label;
 *   - anything unrecognisable — including an empty or absent agent — degrades
 *     to `Unknown device` rather than echoing the raw agent.
 *
 * Contract expected of the implementation:
 *
 *   @/server/me/sessions exports
 *     mapUserAgentToDeviceLabel(userAgent: string | null | undefined): string
 *   output: "<Browser> on <OS>" one of the labels below, or "Unknown device"
 */

interface DeviceCase {
  readonly name: string;
  readonly userAgent: string;
  readonly label: string;
}

/** A realistic agent string per browser/OS pair; each asserts an exact label. */
const DEVICE_CASES: readonly DeviceCase[] = [
  {
    name: "Chrome on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    label: "Chrome on macOS",
  },
  {
    name: "Safari on macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    label: "Safari on macOS",
  },
  {
    name: "Firefox on Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    label: "Firefox on Windows",
  },
  {
    // Edge carries both `Chrome` and `Safari`; browser detection must win
    // before OS detection so this is not mislabelled Chrome.
    name: "Edge on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    label: "Edge on Windows",
  },
  {
    name: "Chrome on Windows",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    label: "Chrome on Windows",
  },
  {
    name: "Chrome on Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    label: "Chrome on Android",
  },
  {
    name: "Safari on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    label: "Safari on iOS",
  },
  {
    // `CriOS` is Chrome on iOS; the agent also carries `Safari`, so the
    // browser token must be checked before the generic Safari fallback.
    name: "Chrome on iOS",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.4896.88 Mobile/15E148 Safari/604.1",
    label: "Chrome on iOS",
  },
  {
    name: "unknown agent",
    userAgent: "Totally-Unknown-Agent/1.0",
    label: "Unknown device",
  },
  {
    name: "empty agent",
    userAgent: "",
    label: "Unknown device",
  },
];

describe("mapUserAgentToDeviceLabel (§1.3)", () => {
  it.each(DEVICE_CASES)("U1: maps $name to $label", ({ userAgent, label }) => {
    expect(mapUserAgentToDeviceLabel(userAgent)).toBe(label);
  });

  it("U1: a null agent degrades to Unknown device", () => {
    expect(mapUserAgentToDeviceLabel(null)).toBe("Unknown device");
  });

  it("U1: an absent agent degrades to Unknown device", () => {
    expect(mapUserAgentToDeviceLabel(undefined)).toBe("Unknown device");
  });
});
