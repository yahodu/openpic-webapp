import type { z } from "zod";

import type { Logger } from "@/server/logging";
import { REQUEST_ID_HEADER } from "@/server/runtime/request-context";

import { toErrorEnvelope } from "./app-error";
import { appError, isAppError } from "./errors";
import { toFieldErrors } from "./validation";

/**
 * Transport helpers for the HTTP pipeline: the shared security headers, the
 * JSON response builders and the request-body validator.
 *
 * These are the wire-facing details of the contract (§0.12), separated from the
 * `defineRoute` orchestration so the pipeline reads as stages rather than as
 * header plumbing.
 */

/** Default security headers applied to every JSON response (contract §0.12). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

/** Build a JSON response with the default security headers plus any extras. */
export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/**
 * Read and validate the request body against `schema`.
 *
 * Enforces `application/json` (415), well-formed JSON (400) and the schema
 * (422 with field details), in that order, before the handler ever runs.
 *
 * @param request - The inbound request.
 * @param schema - The declared body schema.
 * @returns The schema-parsed body.
 * @throws {AppError} `unsupported_media_type`, `malformed_json` or `validation_failed`.
 */
export async function parseJsonBody(request: Request, schema: z.ZodType): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    throw appError("unsupported_media_type");
  }

  const raw = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw appError("malformed_json");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw appError("validation_failed", { details: { fields: toFieldErrors(result.error) } });
  }

  return result.data;
}

/** Project any thrown value onto a JSON error response and log it at the right level. */
export function errorResponse(
  error: unknown,
  requestId: string,
  request: Request,
  logger: Logger
): Response {
  const status = isAppError(error) ? error.status : 500;

  if (status >= 500) {
    logger.error("request failed", { event: "http.error", status, err: error });
  } else {
    logger.info("request rejected", { event: "http.request.rejected", status });
  }

  const envelope = toErrorEnvelope(error, requestId);
  const errorHeaders = isAppError(error) && error.headers !== undefined ? error.headers : {};
  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: requestId,
    ...errorHeaders,
  };

  // A 401 points the client at the login page (contract §0.12) alongside the
  // `WWW-Authenticate` challenge, so an unauthenticated caller can recover.
  if (status === 401) {
    headers["www-authenticate"] = "Bearer";
    return jsonResponse(
      {
        error: {
          ...envelope.error,
          details: {
            ...(envelope.error.details ?? {}),
            loginUrl: `${new URL(request.url).origin}/login`,
          },
        },
      },
      status,
      headers
    );
  }

  return jsonResponse(envelope, status, headers);
}
