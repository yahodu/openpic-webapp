import { appError } from "./errors";
import { stageHook, type RouteStage } from "./define-route";

/**
 * ETag formatting and conditional-request evaluation (API contract §0.10,
 * RFC 7232).
 *
 * A mutable resource returns an `ETag`; a `PATCH`/`PUT` must present `If-Match`
 * (missing → `428 precondition_required`, mismatched → `412 etag_mismatch` with
 * `details.currentETag`). `If-Match` uses the **strong** comparison (a weak tag
 * never matches) while `If-None-Match` uses the **weak** comparison (`W/"x"`
 * and `"x"` match). Every comparison is opaque-value based, never a string
 * prefix.
 */

/** The attribute flags an ETag is emitted with. */
export interface EtagStageOptions {
  /**
   * Resolve the resource's current ETag. Returning `null`/`undefined` means the
   * resource does not exist, so the stage is a no-op.
   */
  readonly resolve: (ctx: Parameters<RouteStage>[0], request: Request) => string | null | undefined;
  /** Whether an unsafe method must present `If-Match` (428 when absent). */
  readonly required?: boolean;
}

/** Methods that mutate a resource and therefore may demand `If-Match`. */
const UNSAFE_METHODS = new Set(["PATCH", "PUT", "DELETE"]);

/**
 * Format a strong entity tag.
 *
 * @param token - The opaque token, e.g. a version counter.
 * @returns `"<token>"`.
 */
export function strongETag(token: string | number): string {
  return `"${String(token)}"`;
}

/**
 * Format a weak entity tag.
 *
 * @param token - The opaque token.
 * @returns `W/"<token>"`.
 */
export function weakETag(token: string | number): string {
  return `W/"${String(token)}"`;
}

/**
 * The strong ETag for an event: its `updatedAt` in epoch milliseconds composed
 * with the schema version that last wrote it.
 *
 * A strong tag (not `W/"…"`) is required so the value a client reads from a
 * `GET` can satisfy the strong `If-Match` comparison on a later `PATCH`/`PUT`
 * (RFC 7232; contract §0.10).
 *
 * @param updatedAt - The event's last-write timestamp.
 * @param schemaVersion - The event schema version.
 * @returns `"<updatedAtMs>-<schemaVersion>"`.
 */
export function eventETag(updatedAt: Date, schemaVersion: number): string {
  return strongETag(`${String(updatedAt.getTime())}-${String(schemaVersion)}`);
}

/** One parsed entity tag: its opaque value and weakness flag. */
interface EntityTag {
  readonly value: string;
  readonly weak: boolean;
}

/**
 * Parse a single entity tag, `W/` opaque-tag.
 *
 * @param token - One comma-separated member of a conditional header.
 * @returns The parsed tag, or `null` when it is not a valid entity tag.
 */
function parseEntityTag(token: string): EntityTag | null {
  let rest = token.trim();
  let weak = false;
  if (rest.startsWith("W/")) {
    weak = true;
    rest = rest.slice(2);
  }
  if (rest.length < 2 || !rest.startsWith('"') || !rest.endsWith('"')) {
    return null;
  }
  return { value: rest.slice(1, -1), weak };
}

/** Parse a comma-separated entity-tag list, dropping any invalid member. */
function parseEntityTagList(header: string): EntityTag[] {
  return header
    .split(",")
    .map((token) => parseEntityTag(token))
    .filter((tag): tag is EntityTag => tag !== null);
}

/**
 * Evaluate an `If-Match` precondition with the RFC 7232 strong comparison.
 *
 * A missing header never matches; `*` matches any existing resource; otherwise
 * a member matches only when it and the current tag are both strong and carry
 * the same opaque value. A weak current tag therefore never strong-matches.
 *
 * @param request - The inbound request.
 * @param currentETag - The resource's current ETag.
 * @returns `true` when the precondition is satisfied.
 */
export function ifMatchSatisfied(request: Request, currentETag: string): boolean {
  const header = request.headers.get("if-match");
  if (header === null) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }

  const current = parseEntityTag(currentETag);
  if (current === null || current.weak) {
    return false;
  }
  return parseEntityTagList(header).some((tag) => !tag.weak && tag.value === current.value);
}

/**
 * Evaluate an `If-None-Match` precondition with the RFC 7232 weak comparison.
 *
 * A missing header never matches; `*` matches any existing resource; otherwise
 * a member matches when its opaque value equals the current tag's, regardless
 * of either side's weakness.
 *
 * @param request - The inbound request.
 * @param currentETag - The resource's current ETag.
 * @returns `true` when the precondition is satisfied.
 */
export function ifNoneMatchSatisfied(request: Request, currentETag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }

  const current = parseEntityTag(currentETag);
  if (current === null) {
    return false;
  }
  return parseEntityTagList(header).some((tag) => tag.value === current.value);
}

/**
 * The `defineRoute` ETag stage.
 *
 * It never governs whether a resource exists: when {@link EtagStageOptions.resolve}
 * yields `null`/`undefined` the stage is a no-op. Otherwise it merges the
 * current `ETag` into the response and, for a safe polled `GET`/`HEAD`, serves a
 * bodyless `304` when the client's `If-None-Match` matches. For an unsafe
 * method it enforces the `If-Match` precondition per {@link EtagStageOptions.required}.
 *
 * @param options - The resolver and whether `If-Match` is mandatory.
 * @returns A pipeline stage.
 */
export function etagStage(options: EtagStageOptions): RouteStage {
  return (ctx, request): Promise<unknown> => {
    const current = options.resolve(ctx, request);
    if (current === null || current === undefined) {
      return Promise.resolve(undefined);
    }

    if (UNSAFE_METHODS.has(request.method.toUpperCase())) {
      const ifMatch = request.headers.get("if-match");
      if (ifMatch === null) {
        if (options.required === true) {
          return Promise.reject(
            appError("precondition_required", { details: { header: "If-Match" } })
          );
        }
        return Promise.resolve({ etag: current });
      }
      if (!ifMatchSatisfied(request, current)) {
        return Promise.reject(appError("etag_mismatch", { details: { currentETag: current } }));
      }
      return Promise.resolve({ etag: current });
    }

    if (ifNoneMatchSatisfied(request, current)) {
      return Promise.resolve(
        stageHook({
          headers: { etag: current },
          replay: { status: 304, body: undefined },
        })
      );
    }
    return Promise.resolve({ etag: current });
  };
}
