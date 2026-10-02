import { describe, expect, it } from "vitest";

import { errorCodeSchema } from "@openpic/contracts";

import { ERROR_CATALOG, appError, isAppError } from "@/server/http/errors";

/**
 * U2 — the error catalogue mirrors contract Appendix A.
 *
 * One HTTP status and one retryable flag per code, so a client can branch on
 * `error.code` alone and the retry policy is decided server-side. The table
 * below is the executable copy of Appendix A; if the contract changes, this is
 * the single place to update.
 *
 * NOTE: Appendix A was not present in this repository, so the table encodes the
 * codes exercised by the HTTP-pipeline stories plus the standard REST set. It is
 * an explicit assumption of this RED handoff — see the card handoff notes.
 */
interface CatalogRow {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
}

const APPENDIX_A: readonly CatalogRow[] = [
  { code: "bad_request", status: 400, retryable: false },
  { code: "malformed_json", status: 400, retryable: false },
  { code: "unauthenticated", status: 401, retryable: false },
  { code: "invalid_credentials", status: 401, retryable: false },
  { code: "payment_required", status: 402, retryable: false },
  { code: "forbidden", status: 403, retryable: false },
  { code: "not_found", status: 404, retryable: false },
  { code: "method_not_allowed", status: 405, retryable: false },
  { code: "conflict", status: 409, retryable: false },
  { code: "idempotency_conflict", status: 409, retryable: false },
  { code: "gone", status: 410, retryable: false },
  { code: "precondition_failed", status: 412, retryable: false },
  { code: "payload_too_large", status: 413, retryable: false },
  { code: "unsupported_media_type", status: 415, retryable: false },
  { code: "validation_failed", status: 422, retryable: false },
  { code: "locked", status: 423, retryable: false },
  { code: "failed_dependency", status: 424, retryable: true },
  { code: "rate_limited", status: 429, retryable: true },
  { code: "internal_error", status: 500, retryable: false },
  { code: "not_implemented", status: 501, retryable: false },
  { code: "bad_gateway", status: 502, retryable: true },
  { code: "service_unavailable", status: 503, retryable: true },
  { code: "gateway_timeout", status: 504, retryable: true },
];

describe("ERROR_CATALOG", () => {
  it("U2: contains exactly the Appendix A codes", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(APPENDIX_A.map((row) => row.code).sort());
  });

  it.each(APPENDIX_A)("U2: $code maps to $status / retryable=$retryable", (row) => {
    expect(ERROR_CATALOG[row.code as keyof typeof ERROR_CATALOG]).toMatchObject({
      status: row.status,
      retryable: row.retryable,
    });
  });

  it.each(APPENDIX_A)("U2: the Zod code enum accepts $code", (row) => {
    expect(errorCodeSchema.safeParse(row.code).success).toBe(true);
  });

  it("U2: the Zod code enum rejects a code outside the catalogue", () => {
    expect(errorCodeSchema.safeParse("totally_made_up_code").success).toBe(false);
  });
});

describe("appError", () => {
  it("builds an AppError carrying the catalogue defaults", () => {
    const error = appError("not_found");

    expect(isAppError(error)).toBe(true);
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
  });

  it("accepts overrides without mutating the catalogue", () => {
    const error = appError("conflict", { message: "Already exists" });

    expect(error.message).toBe("Already exists");
    expect(ERROR_CATALOG.conflict.status).toBe(409);
  });
});
