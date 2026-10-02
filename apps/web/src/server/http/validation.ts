import type { FieldError } from "@openpic/contracts";
import type { z } from "zod";

/**
 * Map a Zod validation failure onto the client-facing field errors.
 *
 * Clients address a field by a dot path, so a nested array index renders as
 * `items.0.hash` (not a JSON pointer, not a bracket) and a root-level issue
 * renders as the empty string. The raw Zod issue `code` and `message` are
 * preserved so a client can localise without parsing the message.
 *
 * @param error - The `ZodError` from a failed `safeParse`.
 * @returns One field error per issue, in issue order.
 */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
    message: issue.message,
  }));
}
