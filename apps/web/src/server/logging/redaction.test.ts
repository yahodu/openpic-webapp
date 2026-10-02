import { describe, expect, it } from "vitest";

import { expectNoSecretsInLogs } from "../../test/helpers/log-assertions";
import { createLogger, memoryTransport } from "./index";

/**
 * Contract under test — US-003 redaction, applied by the port before emission.
 *
 * By key (case-insensitive, deep, through arrays): authorization, cookie,
 * set-cookie, password, token, sessionToken, otp, secret, sig, signature,
 * email, phone, phoneNumber, phoneE164, embedding, vector(s), rawPayload,
 * queryVector — plus `code` only when nested under an `auth` object.
 *
 * By value, anywhere in a free-text message or a string field: Bearer tokens,
 * `opat_` tokens, E.164 phone numbers and email addresses.
 */

const REDACTED_KEY_NAMES = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "token",
  "sessionToken",
  "otp",
  "secret",
  "sig",
  "signature",
  "email",
  "phone",
  "phoneNumber",
  "phoneE164",
  "embedding",
  "vectors",
  "rawPayload",
  "queryVector",
] as const;

describe("redaction — by key", () => {
  it.each(REDACTED_KEY_NAMES)("redacts the %s key case-insensitively", (key) => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "info", transports: [sink] });
    const secret = `secret-value-for-${key}`;

    logger.info("keys", { event: "e", requestId: "r", [key.toUpperCase()]: secret });

    expect(JSON.stringify(sink.entries[0])).not.toContain(secret);
  });

  it("redacts sensitive keys in nested objects and arrays", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "info", transports: [sink] });

    logger.info("nested", {
      event: "e",
      requestId: "r",
      context: {
        AUTHORIZATION: "Bearer abcdef123456",
        "Set-Cookie": "sid=abc",
        list: [{ Token: "tok-plain-123" }, { nested: { secret: "shhh" } }],
      },
    });

    const serialized = JSON.stringify(sink.entries[0]);
    expect(serialized).not.toContain("abcdef123456");
    expect(serialized).not.toContain("sid=abc");
    expect(serialized).not.toContain("tok-plain-123");
    expect(serialized).not.toContain("shhh");

    const context = sink.entries[0]?.context as Record<string, unknown>;
    expect(context.AUTHORIZATION).toMatch(/REDACTED/);
    expectNoSecretsInLogs(sink);
  });

  it("redacts `code` only when nested under `auth`", () => {
    const sink = memoryTransport();
    const logger = createLogger({ level: "info", transports: [sink] });

    logger.info("code", {
      event: "e",
      requestId: "r",
      code: "public-code",
      auth: { code: "123456" },
    });

    expect(sink.entries[0]?.code).toBe("public-code");
    const auth = sink.entries[0]?.auth as Record<string, unknown>;
    expect(auth.code).toMatch(/REDACTED/);
  });
});

describe("redaction — value patterns in free text", () => {
  it("masks an email address inside the message", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info(
      "contact john.doe@example.com about the invoice",
      { event: "e", requestId: "r" }
    );

    const msg = sink.entries[0]?.msg ?? "";
    expect(msg).not.toContain("john.doe@example.com");
    expect(msg).toMatch(/REDACTED/);
  });

  it("masks an E.164 phone number inside the message", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info("call +14155552671 now", {
      event: "e",
      requestId: "r",
    });

    const msg = sink.entries[0]?.msg ?? "";
    expect(msg).not.toContain("+14155552671");
    expect(msg).toMatch(/REDACTED/);
  });

  it("masks a Bearer token inside the message", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info(
      "using Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      { event: "e", requestId: "r" }
    );

    const msg = sink.entries[0]?.msg ?? "";
    expect(msg).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(msg).toMatch(/REDACTED/);
    expectNoSecretsInLogs(sink);
  });

  it("masks an opat_ token inside the message", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info("token opat_live_ABCdef123456", {
      event: "e",
      requestId: "r",
    });

    const msg = sink.entries[0]?.msg ?? "";
    expect(msg).not.toContain("opat_live_ABCdef123456");
    expect(msg).toMatch(/REDACTED/);
  });

  it("masks a value pattern inside a non-sensitive string field", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info("note", {
      event: "e",
      requestId: "r",
      note: "reach me at a.person@example.com",
    });

    expect(String(sink.entries[0]?.note)).not.toContain("a.person@example.com");
  });

  it("leaves ordinary prose untouched", () => {
    const sink = memoryTransport();
    createLogger({ level: "info", transports: [sink] }).info("request completed in 42ms", {
      event: "e",
      requestId: "r",
    });

    expect(sink.entries[0]?.msg).toBe("request completed in 42ms");
  });
});
