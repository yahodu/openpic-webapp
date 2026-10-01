import { z } from "zod";

/** Liveness response body returned by `GET /api/v1/health`. */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
});

/** Inferred DTO for {@link HealthResponseSchema}. */
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Build a liveness response fixture.
 *
 * Fixtures are produced through factories that parse their own output so a
 * fixture can never drift from its schema.
 *
 * @param overrides - Fields to override on the default payload.
 * @returns A schema-valid health response.
 * @example
 * buildHealthResponse(); // { status: 'ok' }
 */
export function buildHealthResponse(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return HealthResponseSchema.parse({ status: "ok", ...overrides });
}
