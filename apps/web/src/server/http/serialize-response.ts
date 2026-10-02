import { z } from "zod";

import type { Logger } from "@/server/logging";

/**
 * Response serialization — the never-return control (CONVENTIONS §8.1).
 *
 * Every response body is projected through its `packages/contracts` schema. An
 * unknown field is a schema violation, not a cosmetic detail: outside
 * production it throws so a developer (and the test) sees it immediately; in
 * production it is logged at error and the body is returned stripped, so a
 * leaked field can never reach a client even when a handler misbehaves.
 */

/** Inputs for {@link serializeResponse}. */
export interface SerializeResponseOptions<T> {
  /** The response schema the body must satisfy. */
  readonly schema: z.ZodType<T>;
  /** The raw body produced by the handler. */
  readonly data: unknown;
  /** The matched route template, for the log line and the thrown message. */
  readonly route: string;
  /** The request-scoped logger. */
  readonly logger: Logger;
  /** The application environment; only `production` degrades instead of throwing. */
  readonly env?: string;
}

/**
 * Enforce the response schema on `data`.
 *
 * The matching case returns the schema-parsed body. A mismatch outside
 * production throws an error naming the route; in production it is logged at
 * error (event `http.response.serialization_failed`) and the body is returned
 * parsed without the unknown fields. When production cannot even loosely parse
 * the body (a wrong type, not merely an extra field) it throws, so the pipeline
 * maps it onto the generic `500 internal_error` envelope instead of serving an
 * empty 2xx.
 *
 * @param options - Schema, data, route, logger and environment.
 * @returns The schema-projected body.
 * @throws {Error} when the body does not match and `env` is not `production`,
 *   or when in production the body cannot be parsed even without the unknown
 *   fields.
 */
export function serializeResponse<T>(options: SerializeResponseOptions<T>): T {
  // A plain `z.object` silently strips unknown keys, which would hide exactly the
  // leak this control exists to catch, so object schemas are validated strictly.
  const validator: z.ZodType =
    options.schema instanceof z.ZodObject ? options.schema.strict() : options.schema;
  const strictResult = validator.safeParse(options.data);

  if (strictResult.success) {
    return strictResult.data as T;
  }

  if (options.env !== "production") {
    throw new Error(
      `Response for ${options.route} did not match its schema: ${formatIssues(strictResult.error)}`
    );
  }

  options.logger.error("response did not match its schema", {
    event: "http.response.serialization_failed",
    route: options.route,
    issues: strictResult.error.issues.map((issue) => issue.code),
  });

  // Strip unknown fields with a non-strict parse. If the body cannot be parsed
  // at all (a wrong type, not merely an extra field) nothing safe can be
  // returned: throwing lets the pipeline project it onto the generic 500
  // envelope rather than serving a 2xx with an empty body.
  const looseResult = options.schema.safeParse(options.data);
  if (!looseResult.success) {
    throw new Error(`Response for ${options.route} could not be serialized`);
  }
  return looseResult.data;
}

/** Render the Zod issues for a developer-facing thrown message. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join(".") || "<root>"}: ${issue.message}`
    )
    .join("; ");
}
