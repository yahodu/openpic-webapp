import { z } from "zod";

import { getRateLimitConfig } from "@/server/config/env";
import { defineRoute } from "@/server/http/define-route";
import { createRateLimiter, rateLimitStage } from "@/server/rate-limit";

/**
 * `POST /api/v1/echo` — the tracer-bullet route for the HTTP pipeline.
 *
 * Echoes `{ message }` back to the caller. It exists to prove the shared
 * `defineRoute` pipeline end to end (validation -> handler -> serialization)
 * before the real endpoints are built on it.
 *
 * @see API contract §4.2
 */

/** Request body accepted by the echo route. */
const EchoRequestSchema = z.object({
  message: z.string().min(1),
});

/** Response body returned by the echo route. */
const EchoResponseSchema = z.object({
  message: z.string(),
});

/** Echo the validated `message` back to the caller. */
export const POST = defineRoute({
  route: "/api/v1/echo",
  body: EchoRequestSchema,
  response: EchoResponseSchema,
  rateLimit: rateLimitStage({
    classKey: "write.normal",
    limiter: createRateLimiter(),
    salt: getRateLimitConfig().salt,
  }),
  handler: (ctx) => ({ body: { message: ctx.body.message } }),
});
