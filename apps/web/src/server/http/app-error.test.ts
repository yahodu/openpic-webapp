import { describe, expect, it } from "vitest";

import { apiErrorSchema } from "@openpic/contracts";

import { AppError, toErrorEnvelope } from "@/server/http/app-error";

/**
 * U1 / U4 — AppError and the unknown-error fallback.
 *
 * The envelope is the only shape a client may branch on (`error.code`), so it
 * must match `apiErrorSchema` exactly and always carry the correlation
 * `requestId`. Anything the pipeline does not explicitly expose is a 500 with a
 * generic message: the thrown text, a stack frame or a driver fragment must
 * never reach the caller.
 */
describe("toErrorEnvelope", () => {
  it("U1: maps an AppError onto the ApiError envelope with the request id", () => {
    const error = new AppError("validation_failed", {
      message: "The request body is invalid.",
      details: {
        fields: [{ path: "message", code: "too_small", message: "Too small" }],
      },
    });

    const envelope = toErrorEnvelope(error, "req_0123456789abcdef");

    expect(envelope).toEqual({
      error: {
        code: "validation_failed",
        message: "The request body is invalid.",
        requestId: "req_0123456789abcdef",
        retryable: false,
        details: {
          fields: [{ path: "message", code: "too_small", message: "Too small" }],
        },
      },
    });
    expect(apiErrorSchema.safeParse(envelope).success).toBe(true);
  });

  it("U1: derives status and retryable from the error catalogue", () => {
    const error = new AppError("rate_limited");

    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("U1: lets an explicit status and retryable flag win over the catalogue", () => {
    const error = new AppError("internal_error", {
      status: 503,
      retryable: true,
      expose: true,
      message: "Temporarily unavailable, try again.",
    });

    const envelope = toErrorEnvelope(error, "req_1");

    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(envelope.error.message).toBe("Temporarily unavailable, try again.");
  });

  it.each([
    ["an Error", new Error("mongodb://user:pass@db:27017 refused the connection")],
    ["a string", "boom"],
    ["a plain object", { unexpected: true }],
    ["undefined", undefined],
    ["null", null],
  ])("U4: %s becomes a generic 500 internal_error", (_label, thrown) => {
    const envelope = toErrorEnvelope(thrown, "req_02H");

    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.requestId).toBe("req_02H");
    expect(envelope.error.retryable).toBe(false);
    expect(typeof envelope.error.message).toBe("string");
    expect(envelope.error.message.length).toBeGreaterThan(0);
    expect(apiErrorSchema.safeParse(envelope).success).toBe(true);
  });

  it("U4: never leaks the thrown message, stack or driver text into the response", () => {
    const envelope = toErrorEnvelope(
      new Error("kaboom at /srv/app/src/server/db/mongo.ts:42:7"),
      "req_03H"
    );

    expect(envelope.error.message).not.toContain("kaboom");
    expect(envelope.error.message).not.toContain("mongo.ts");
    expect(envelope.error.message).not.toMatch(/\bat\s+\S+\s+\(/);
    expect(envelope.error.details).toBeUndefined();
  });

  it("U4: hides the message of a non-exposed AppError behind the generic text", () => {
    const error = new AppError("internal_error", {
      message: "MongoServerError: aggregate failed on db.internal_notes",
      expose: false,
    });

    const envelope = toErrorEnvelope(error, "req_04H");

    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.message).not.toContain("MongoServerError");
    expect(envelope.error.message).not.toContain("internal_notes");
  });
});
