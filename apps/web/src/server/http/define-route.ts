import type { z } from "zod";

import { getAppEnv } from "@/server/config/env";
import { requestLogger, type Logger } from "@/server/logging";
import { systemClock } from "@/server/runtime/clock";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithRequestContext,
  type RequestContext,
} from "@/server/runtime/request-context";

import { AppError, toErrorEnvelope } from "./app-error";
import { appError } from "./errors";
import { serializeResponse } from "./serialize-response";
import { toFieldErrors } from "./validation";

/**
 * `defineRoute` — the shared HTTP pipeline (architecture §3).
 *
 * A route declares its contract (input schema, response schema, pluggable
 * stages and handler) and the pipeline runs the stages in the documented order:
 *
 *   context -> rate limit -> auth -> CSRF -> tenant resolution -> idempotency ->
 *   ETag -> validate -> handler -> serialize
 *
 * Every stage is optional and a no-op until its own story lands. The handler
 * only runs after validation succeeds and receives the typed, parsed input; its
 * result is serialized through the response schema before it reaches the wire.
 * Every failure is projected onto the shared `ApiError` envelope, and every JSON
 * response carries the default security headers (contract §0.12).
 */

/** The context handed to the pluggable stages (pre-validation). */
export type RouteStageContext = RequestContext;

/** The context handed to the handler, carrying the validated input. */
export interface HandlerContext<TBody = unknown> extends RequestContext {
  /** The schema-parsed request body (or `undefined` when no schema is declared). */
  readonly body: TBody;
}

/** A pluggable pipeline stage; a no-op until its story lands. */
export type RouteStage = (ctx: RouteStageContext) => void | Promise<void>;

/** The handler's successful result. */
export interface RouteResult<TResponse = unknown> {
  /** The HTTP status; defaults to `200`. */
  readonly status?: number;
  /** The response body, projected through the response schema. */
  readonly body: TResponse;
  /** Extra response headers merged over the default security headers. */
  readonly headers?: Record<string, string>;
}

/** The declaration accepted by {@link defineRoute}. */
export interface DefineRouteOptions<TBody = unknown, TResponse = unknown> {
  /** The matched route template, bound to the context and used in logs. */
  readonly route: string;
  /** The request body schema; when present, validation runs before the handler. */
  readonly body?: z.ZodType<TBody>;
  /** The response schema every body is projected through. */
  readonly response: z.ZodType<TResponse>;
  /** The application environment; only `production` degrades serialization. */
  readonly env?: string;
  /** An explicit logger; defaults to the request-scoped process logger. */
  readonly logger?: Logger;
  /** Rate-limit stage (no-op until its story lands). */
  readonly rateLimit?: RouteStage;
  /** Authentication stage (no-op until its story lands). */
  readonly auth?: RouteStage;
  /** CSRF stage (no-op until its story lands). */
  readonly csrf?: RouteStage;
  /** Tenant-resolution stage (no-op until its story lands). */
  readonly tenant?: RouteStage;
  /** Idempotency stage (no-op until its story lands). */
  readonly idempotency?: RouteStage;
  /** ETag stage (no-op until its story lands). */
  readonly etag?: RouteStage;
  /** The business handler, run after the stages and validation. */
  readonly handler: (
    ctx: HandlerContext<TBody>
  ) => RouteResult<TResponse> | Promise<RouteResult<TResponse>>;
}

/** A Next.js-compatible route handler. */
export type RouteHandler = (request: Request) => Promise<Response>;

/** Build a `201 Created` result with a `Location` header (contract §0.12). */
export function created<TResponse>(body: TResponse, location: string): RouteResult<TResponse> {
  return { status: 201, body, headers: { location } };
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

/**
 * Declare an HTTP route on the shared pipeline.
 *
 * @param options - Route template, schemas, stages, handler and environment.
 * @returns A `(request) => Promise<Response>` handler.
 */
export function defineRoute<TBody = unknown, TResponse = unknown>(
  options: DefineRouteOptions<TBody, TResponse>
): RouteHandler {
  const stages: readonly (RouteStage | undefined)[] = [
    options.rateLimit,
    options.auth,
    options.csrf,
    options.tenant,
    options.idempotency,
    options.etag,
  ];

  return async (request: Request): Promise<Response> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const startedAt = systemClock.now();
    const context: RequestContext = { requestId, route: options.route, startedAt };

    return runWithRequestContext(context, async (): Promise<Response> => {
      const logger =
        options.logger === undefined
          ? requestLogger(request, { route: options.route })
          : options.logger.child({ requestId, route: options.route });

      try {
        for (const stage of stages) {
          if (stage !== undefined) {
            await stage(context);
          }
        }

        const body =
          options.body === undefined ? undefined : await parseJsonBody(request, options.body);
        const handlerContext: HandlerContext<TBody> = { ...context, body: body as TBody };

        const result = await options.handler(handlerContext);
        const status = result.status ?? 200;
        const env = resolveAppEnv(options.env);

        const serialized = serializeResponse({
          schema: options.response,
          data: result.body,
          route: options.route,
          logger,
          env,
        });

        return jsonResponse(serialized, status, {
          ...(result.headers ?? {}),
          [REQUEST_ID_HEADER]: requestId,
        });
      } catch (error: unknown) {
        return errorResponse(error, requestId, request, logger);
      }
    });
  };
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
async function parseJsonBody(request: Request, schema: z.ZodType): Promise<unknown> {
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
    throw new AppError("validation_failed", {
      details: { fields: toFieldErrors(result.error) },
    });
  }

  return result.data;
}

/** Project any thrown value onto a JSON error response and log it at the right level. */
function errorResponse(
  error: unknown,
  requestId: string,
  request: Request,
  logger: Logger
): Response {
  const status = error instanceof AppError ? error.status : 500;

  if (status >= 500) {
    logger.error("request failed", { event: "http.error", status, err: error });
  } else {
    logger.info("request rejected", { event: "http.request.rejected", status });
  }

  const envelope = toErrorEnvelope(error, requestId);
  const headers: Record<string, string> = { [REQUEST_ID_HEADER]: requestId };

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

/**
 * Resolve the effective environment for response serialization.
 *
 * Prefers the explicit option, then the process environment (read through the
 * config module); never throws when the process env is incomplete.
 */
function resolveAppEnv(explicit: string | undefined): string {
  return explicit ?? getAppEnv();
}

/** Build a JSON response with the default security headers plus any extras. */
function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}
