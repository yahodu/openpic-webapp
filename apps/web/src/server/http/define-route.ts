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

import { serializeResponse } from "./serialize-response";
import { jsonResponse, parseJsonBody, errorResponse } from "./respond";

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
 *
 * The wire-facing details (security headers, JSON response builders and the body
 * validator) live in `./respond`.
 */

/** The context handed to the pluggable stages (pre-validation). */
export type RouteStageContext = RequestContext;

/** The context handed to the handler, carrying the validated input. */
export interface HandlerContext<TBody = unknown> extends RequestContext {
  /** The schema-parsed request body (or `undefined` when no schema is declared). */
  readonly body: TBody;
}

/**
 * A pluggable pipeline stage.
 *
 * A stage may return a `Record<string, string>` of headers, which the pipeline
 * merges into the *success* response (the rate stage uses this to attach the
 * `RateLimit-*` headers). It may instead throw an `AppError` to deny the
 * request; `AppError.headers` travel with that error response. A stage that
 * returns nothing (or whose return is not a header map) is a no-op.
 */
export type RouteStage = (ctx: RouteStageContext, request: Request) => unknown;

/** Narrow a stage result to a header map, ignoring every other return. */
function stageHeadersOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.every(([, headerValue]) => typeof headerValue === "string")) {
    return Object.fromEntries(entries) as Record<string, string>;
  }
  return undefined;
}

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
        const stageHeaders: Record<string, string> = {};
        for (const stage of stages) {
          if (stage !== undefined) {
            const headers = stageHeadersOf(await stage(context, request));
            if (headers !== undefined) {
              Object.assign(stageHeaders, headers);
            }
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
          ...stageHeaders,
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
 * Resolve the effective environment for response serialization.
 *
 * Prefers the explicit option, then the process environment (read through the
 * config module); never throws when the process env is incomplete.
 */
function resolveAppEnv(explicit: string | undefined): string {
  return explicit ?? getAppEnv();
}
