import { createHash } from "node:crypto";

import { claimMemoryPresign } from "@/server/storage/memory-presigns";
import { getAppEnv } from "@/server/config/env";
import { isTestOtpRouteEnabled } from "@/server/auth/test-route";

/**
 * Test-only storage `PUT` route (OP-124 E1, ADR-0721 D6).
 *
 * The e2e suite runs in a different process from the server, so the in-memory
 * storage adapter's presigned URL must be `PUT`-able over HTTP: this route
 * redeems the opaque token the adapter minted, writes the body into the store
 * that minted it, and answers an `ETag` the client echoes back on completion —
 * exactly the shape S3 gives it.
 *
 * Gated like the OTP read-back ({@link isTestOtpRouteEnabled}): reachable only
 * in `test`/`e2e`, `404` everywhere else. A leaked writer would let anyone
 * store an object the completion would then register.
 */

/** Node runtime so the route shares the adapter's in-process store. */
export const runtime = "nodejs";

/**
 * Accept one presigned upload.
 *
 * @param request - The inbound `PUT`; its last path segment is the token.
 * @returns `200` with the object's `ETag`, or `404` for a disabled
 *   environment, an unknown token or an expired one.
 */
export async function PUT(request: Request): Promise<Response> {
  if (!isTestOtpRouteEnabled(getAppEnv())) {
    return new Response(null, { status: 404 });
  }

  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  const presign = claimMemoryPresign(String(segments.at(-1)));
  if (presign === null) {
    return new Response(null, { status: 404 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  presign(bytes);

  return new Response(null, {
    status: 200,
    headers: { etag: `"${createHash("md5").update(bytes).digest("hex")}"` },
  });
}
