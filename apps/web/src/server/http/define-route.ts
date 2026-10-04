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
 *   context -> rate limit -> auth -> rate limit (identity) -> CSRF ->
 *   tenant resolution -> idempotency -> ETag -> validate -> handler -> serialize
 *
 * Rate limiting is deliberately two-tier (§0.11, ADR-0005): the coarse
 * `rateLimit` stage runs first (before auth), and the identity-keyed
 * `rateLimitIdentity` stage runs immediately after `auth` with the parsed body,
 * so it can key on `ctx.principal` and the request `contact`.
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
 * A stage may return:
 *   - a `Record<string, string>` of headers, which the pipeline merges into the
 *     *success* response (the rate stage uses this to attach the `RateLimit-*`
 *     headers);
 *   - a {@link StageHook} (built with {@link stageHook}) when it needs to act
 *     beyond a header merge — short-circuit the pipeline with a stored
 *     response, or run a callback once the handler's result is known. The
 *     idempotency stage uses this to replay a stored response and to persist or
 *     release the key around the handler;
 *   - `undefined` (or anything else) as a no-op.
 *
 * A stage may instead throw an `AppError` to deny the request; `AppError.headers`
 * travel with that error response.
 */
export type RouteStage = (ctx: RouteStageContext, request: Request) => unknown;

/** The marker key that identifies a {@link StageHook} at runtime. */
export const STAGE_HOOK: unique symbol = Symbol.for("openpic.routeStageHook");

/** A response snapshot the pipeline hands to a stage's `onResult` callback. */
export interface StageResultSnapshot {
  /** The status the response was served with. */
  readonly status: number;
  /** The schema-serialized response body. */
  readonly body: unknown;
  /** The response headers (security headers excluded). */
  readonly headers: Record<string, string>;
}

/** A response a stage wants the pipeline to serve verbatim (short-circuit). */
export interface StageReplay {
  /** The status to serve (a stage rewrites `201` to `200` for a replay). */
  readonly status: number;
  /** The stored response body. */
  readonly body: unknown;
  /** Extra headers for the replayed response (e.g. `Idempotency-Replayed`). */
  readonly headers?: Record<string, string>;
}

/**
 * A stage outcome richer than a header map.
 *
 * The pipeline merges `headers` into the response, returns `replay` immediately
 * (skipping the remaining stages and the handler), and runs `onResult` after a
 * 2xx/4xx handler result or `onError` after a thrown/5xx handler result.
 */
export interface StageHook {
  /** Runtime marker; set by {@link stageHook}. */
  readonly [STAGE_HOOK]: true;
  /** Headers to merge into the final response. */
  readonly headers?: Record<string, string>;
  /** A stored response to serve immediately, skipping the handler. */
  readonly replay?: StageReplay;
  /** Runs after a non-5xx handler result with the serialized snapshot. */
  readonly onResult?: (snapshot: StageResultSnapshot) => Promise<void>;
  /** Runs after the handler throws or returns a 5xx, to undo the stage's claim. */
  readonly onError?: () => Promise<void>;
}

/**
 * Build a {@link StageHook} with its runtime marker set.
 *
 * @param hook - The headers/replay/callbacks the stage wants to register.
 * @returns A marked stage-hook value the pipeline recognises.
 */
export function stageHook(hook: Omit<StageHook, typeof STAGE_HOOK>): StageHook {
  return { [STAGE_HOOK]: true, ...hook };
}

/** Narrow a stage result to a {@link StageHook}. */
function isStageHook(value: unknown): value is StageHook {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly [STAGE_HOOK]?: unknown })[STAGE_HOOK] === true
  );
}

/**
 * The post-auth, identity-keyed rate-limit stage (two-tier limiting, §0.11,
 * ADR-0005).
 *
 * It runs immediately after `auth` — so it can read `ctx.principal` — and is
 * handed the request body as a third argument (the pipeline parses the body
 * once, before this stage), so contact-keyed classes (`auth.otp`/`auth.verify`)
 * can key on the body's `contact`.
 */
export type RouteIdentityStage = (
  ctx: RouteStageContext,
  request: Request,
  body: unknown
) => unknown;

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
  /** Coarse, pre-auth rate-limit stage (no-op until its story lands). */
  readonly rateLimit?: RouteStage;
  /** Authentication stage (no-op until its story lands). */
  readonly auth?: RouteStage;
  /**
   * Identity-keyed rate-limit stage; runs immediately after `auth` and receives
   * the parsed request body as its third argument (two-tier limiting, §0.11).
   */
  readonly rateLimitIdentity?: RouteIdentityStage;
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
  return async (request: Request): Promise<Response> => {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
    const startedAt = systemClock.now();
    const context: RequestContext = { requestId, route: options.route, startedAt };

    return runWithRequestContext(context, async (): Promise<Response> => {
      const logger =
        options.logger === undefined
          ? requestLogger(request, { route: options.route })
          : options.logger.child({ requestId, route: options.route });

      const stageHeaders: Record<string, string> = {};
      const hooks: StageHook[] = [];

      /** Release every stage claim when the request did not produce a stored result. */
      const runErrorHooks = async (): Promise<void> => {
        for (const hook of hooks) {
          if (hook.onError === undefined) {
            continue;
          }
          try {
            await hook.onError();
          } catch (hookError: unknown) {
            // A failed release must never mask the request's own failure.
            logger.error("pipeline stage cleanup failed", {
              event: "http.stage_hook_failed",
              err: hookError,
            });
          }
        }
      };

      try {
        // Parse the body at most once. The post-auth identity stage needs it
        // (contact-keyed classes) and the handler consumes the same parsed
        // value, so `parseJsonBody` never reads the request stream twice. It
        // reads a clone, so a later stage that clones the request (the
        // idempotency stage hashes the body) still sees an unread stream.
        let parsedBody: unknown;
        let bodyParsed = false;
        const resolveBody = async (): Promise<unknown> => {
          if (!bodyParsed) {
            parsedBody =
              options.body === undefined
                ? undefined
                : await parseJsonBody(request.clone(), options.body);
            bodyParsed = true;
          }
          return parsedBody;
        };

        /**
         * Fold one stage's return into the pipeline: merge its headers, serve a
         * replay immediately, or register its result/error hooks. Returns the
         * short-circuit response when the stage produced one.
         */
        const applyStageResult = (value: unknown): Response | undefined => {
          if (isStageHook(value)) {
            if (value.headers !== undefined) {
              Object.assign(stageHeaders, value.headers);
            }
            if (value.replay !== undefined) {
              return jsonResponse(value.replay.body, value.replay.status, {
                ...stageHeaders,
                ...(value.replay.headers ?? {}),
                [REQUEST_ID_HEADER]: requestId,
              });
            }
            hooks.push(value);
            return undefined;
          }

          const headers = stageHeadersOf(value);
          if (headers !== undefined) {
            Object.assign(stageHeaders, headers);
          }
          return undefined;
        };

        const runStage = async (stage: RouteStage | undefined): Promise<Response | undefined> =>
          stage === undefined ? undefined : applyStageResult(await stage(context, request));

        // Two-tier limiting (§0.11, ADR-0005): the coarse, pre-auth stage runs
        // first; the identity-keyed stage runs immediately after auth, with the
        // parsed body, so it can see `ctx.principal` and the request `contact`.
        let replay = await runStage(options.rateLimit);
        if (replay !== undefined) {
          return replay;
        }
        replay = await runStage(options.auth);
        if (replay !== undefined) {
          return replay;
        }
        if (options.rateLimitIdentity !== undefined) {
          const identityBody = await resolveBody();
          const identityReplay = applyStageResult(
            await options.rateLimitIdentity(context, request, identityBody)
          );
          if (identityReplay !== undefined) {
            return identityReplay;
          }
        }
        for (const stage of [options.csrf, options.tenant, options.idempotency, options.etag]) {
          const stageReplay = await runStage(stage);
          if (stageReplay !== undefined) {
            return stageReplay;
          }
        }

        const body = await resolveBody();
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

        if (status >= 500) {
          await runErrorHooks();
        } else {
          const snapshot: StageResultSnapshot = {
            status,
            body: serialized,
            headers: { ...stageHeaders, ...(result.headers ?? {}) },
          };
          for (const hook of hooks) {
            if (hook.onResult !== undefined) {
              await hook.onResult(snapshot);
            }
          }
        }

        return jsonResponse(serialized, status, {
          ...stageHeaders,
          ...(result.headers ?? {}),
          [REQUEST_ID_HEADER]: requestId,
        });
      } catch (error: unknown) {
        await runErrorHooks();
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
