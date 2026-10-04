import { appError } from "@/server/http/errors";
import {
  stageHook,
  type RouteStage,
  type StageHook,
  type StageResultSnapshot,
} from "@/server/http/define-route";

import { requestHash } from "./request-hash";
import { replayedStatus } from "./replay";
import type { IdempotencyLookup, IdempotencyRecord, IdempotencyStore } from "./store";

/**
 * The `defineRoute` idempotency stage (API contract §0.9).
 *
 * Makes a create/charge endpoint safe to retry: a repeated request with the
 * same `Idempotency-Key` replays the stored response instead of re-running the
 * handler. The flow is:
 *
 *   1. missing key on a required route -> `400 idempotency_key_required`;
 *   2. a key that is not UUIDv4 -> `422 validation_failed`;
 *   3. an existing record with a matching hash -> replay `200` +
 *      `Idempotency-Replayed: true` (never `201`);
 *   4. an existing record still `in_progress` -> `409 idempotency_in_progress`
 *      with `Retry-After: 2`;
 *   5. an existing record with a different hash -> `422 idempotency_key_reuse`
 *      with `details.originalRequestAt`;
 *   6. otherwise claim the key atomically, run the handler, then store the
 *      response (`onResult`) or release the key (`onError`) on a thrown/5xx
 *      failure so the client may retry.
 *
 * The key is scoped per principal (`{key, scope, principalId}`), so two users
 * presenting the same key never share a stored body.
 */

/** Options for {@link idempotencyStage}. */
export interface IdempotencyStageOptions {
  /** The persistence port the stage reads and writes. */
  readonly store: IdempotencyStore;
  /** When `true`, a request without an `Idempotency-Key` is rejected (`400`). */
  readonly required?: boolean;
  /** The acting principal; when omitted, the request context's principal is used. */
  readonly userId?: string;
  /** The tenant; when omitted, the request context's tenant is used. */
  readonly tenantId?: string;
}

/** The inbound header a client sends to request idempotent handling. */
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** The header a replay carries. */
const REPLAYED_HEADER = "idempotency-replayed";

/** The record TTL (API contract §0.9: 24h). */
const TTL_MS = 24 * 60 * 60 * 1000;

/** A UUID version-4 key (`xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build the idempotency pipeline stage.
 *
 * @param options - Store, required flag and optional principal/tenant overrides.
 * @returns A stage that claims/replays the key or denies the request.
 */
export function idempotencyStage(options: IdempotencyStageOptions): RouteStage {
  return async (ctx, request): Promise<StageHook | undefined> => {
    const header = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    const key = header === null ? undefined : header.trim();

    if (key === undefined || key === "") {
      if (options.required === true) {
        throw appError("idempotency_key_required");
      }
      return undefined;
    }

    if (!UUID_V4.test(key)) {
      throw appError("validation_failed", {
        details: {
          fields: [
            { path: IDEMPOTENCY_KEY_HEADER, code: "invalid_format", message: "must be a UUIDv4" },
          ],
        },
      });
    }

    const principalId = options.userId ?? ctx.principal ?? "";
    const tenantId = options.tenantId ?? ctx.tenantId ?? "";
    const lookup: IdempotencyLookup = { key, scope: `${request.method} ${ctx.route}`, principalId };
    const hash = requestHash({ body: await readJsonBody(request), tenantId, userId: principalId });

    const existing = await options.store.find(lookup);
    if (existing !== undefined) {
      return replayOrReject(existing, hash);
    }

    const createdAt = new Date();
    const claimed = await options.store.claim({
      ...lookup,
      requestHash: hash,
      status: "in_progress",
      createdAt,
      expireAt: new Date(createdAt.getTime() + TTL_MS),
    });

    if (!claimed) {
      // Another writer won the unique-index race between our find and insert.
      const raced = await options.store.find(lookup);
      if (raced !== undefined) {
        return replayOrReject(raced, hash);
      }
      throw inProgress();
    }

    return stageHook({
      onResult: (snapshot) => options.store.complete(lookup, storedSnapshot(snapshot)),
      onError: () => options.store.release(lookup),
    });
  };
}

/** Project an existing record onto a replay or the matching error. */
function replayOrReject(record: IdempotencyRecord, hash: string): StageHook {
  if (record.status === "in_progress") {
    throw inProgress();
  }

  if (record.requestHash !== hash) {
    throw appError("idempotency_key_reuse", {
      details: { originalRequestAt: record.createdAt.toISOString() },
    });
  }

  const snapshot = record.responseSnapshot;
  if (snapshot === undefined) {
    throw inProgress();
  }

  return stageHook({
    replay: {
      status: replayedStatus(snapshot.status),
      body: snapshot.body,
      headers: { [REPLAYED_HEADER]: "true", ...snapshot.headers },
    },
  });
}

/** The shared `409` for a request whose key is still held by an in-flight call. */
function inProgress(): ReturnType<typeof appError> {
  return appError("idempotency_in_progress", { headers: { "retry-after": "2" } });
}

/** Keep only the headers a replay must carry: `location`. */
function storedSnapshot(snapshot: StageResultSnapshot) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshot.headers)) {
    if (name.toLowerCase() === "location") {
      headers[name] = value;
    }
  }
  return { status: snapshot.status, body: snapshot.body, headers };
}

/**
 * Read the request body for hashing without consuming the pipeline's copy.
 *
 * The request is cloned first, so `defineRoute` can still parse the original
 * body afterwards. A body that is absent or not JSON falls back to the raw
 * text; the pipeline's own validation decides whether such a request is valid.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.clone().text();
  if (raw.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
