import type { z } from "zod";

import { appError } from "./errors";
import { toFieldErrors } from "./validation";

/**
 * Read a request body the contract declares **optional** (OP-133).
 *
 * `defineRoute`'s `body` option is all-or-nothing: a declared schema makes a
 * bodyless request `415 unsupported_media_type`. §6.5's `gallery:seen` and
 * §6.5's `hide` both take an optional body (`{seenAt?}`, `{reason?}`), so those
 * two routes read it here instead and keep the "no body means defaults"
 * behaviour a client expects.
 *
 * The stream is unread at this point: a route with no `body` option never
 * parses it.
 *
 * @param request - The inbound request.
 * @param schema - The schema the body must satisfy when one was sent.
 * @returns The parsed body, or `undefined` when the request carried none.
 * @throws {AppError} `malformed_json` (400) or `validation_failed` (422).
 */
export async function optionalJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<T | undefined> {
  const raw = await request.text();
  if (raw.trim() === "") {
    return undefined;
  }

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
