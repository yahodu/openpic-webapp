import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { after } from "next/server";
import { z } from "zod";

import {
  isDuplicateKeyError,
  projectProviderWebhookEvent,
} from "@/server/billing/webhook-projection";
import { getConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { getPaymentProvider, paymentEnvironmentFor } from "@/server/payments/get-payment-provider";
import type { WebhookHeaders } from "@/server/payments/payment-provider";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/webhooks/{provider}` — the one generic provider inbox (OP-108,
 * contract §10.1; ADR-0440, ADR-0441).
 *
 * The user story: *as the platform I want provider webhooks verified,
 * deduplicated, acknowledged quickly and projected transactionally so that
 * billing state is correct even under replays and delays.*
 *
 * The handler order is §10.1's, exactly:
 *
 *   1. read the **raw** body (`request.text()`, never the parsed one) and verify
 *      the signature → `401 invalid_signature`, no write;
 *   2. the timestamp must fall inside the port's ±300 s window →
 *      `401 stale_signature`;
 *   3. identity is the provider's own event id, else `sha256(rawBody)`;
 *   4. `insertOne` into `providerWebhookEvents` — the **unique index is the
 *      dedupe**, so a duplicate-key error answers `200 duplicate_ignored` and
 *      does nothing else;
 *   5. answer `200 {"status":"received"}` **before** any projection work;
 *   6–8. register the projection with `after()`, which re-reads, orders and
 *      applies the event transactionally (see
 *      `@/server/billing/webhook-projection`).
 *
 * Two structural facts are load-bearing. The route declares **no** request body
 * schema, because the pipeline's parser would re-serialise the body and JSON
 * re-serialisation breaks the HMAC (§10.1.1) — the handler reads the raw bytes
 * itself. It declares **no** `rateLimit` stage: `/webhooks/**` is not rate
 * limited (§0.11); the signature and the unique index are the protection.
 *
 * The `{provider}` segment must equal the key of the registered adapter
 * (`PAYMENT_PROVIDER`), which is what makes the inbox generic without a vendor
 * table in it. A segment with no adapter is refused with `404` and **no write**
 * — a crash on unroutable input is not a refusal.
 */

/** The port's replay window: how far a webhook timestamp may be from now (§10.1 step 2). */
const REPLAY_WINDOW_MS = 300_000;

/** The bare §10.1 step 5 receipt. No `eventId`, no `processedAt` — nothing to leak. */
const receiptSchema = z.object({ status: z.enum(["received", "duplicate_ignored"]) });

/** The receipt a fresh delivery gets. */
const RECEIVED = { status: "received" } as const;

/** The receipt a replayed delivery gets. */
const DUPLICATE_IGNORED = { status: "duplicate_ignored" } as const;

/** The `{provider}` segment of the matched path. */
function providerFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? "";
}

/** The two signature headers the port reads, lower-cased (`string | undefined`). */
function webhookHeaders(request: Request): WebhookHeaders {
  return {
    "x-webhook-timestamp": request.headers.get("x-webhook-timestamp") ?? undefined,
    "x-webhook-signature": request.headers.get("x-webhook-signature") ?? undefined,
  };
}

/**
 * A short, stable hash of the caller's IP.
 *
 * The invalid-signature warn has to be actionable without turning the log sink
 * into a store of raw client addresses (CONVENTIONS §5.3).
 */
function hashClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim() ?? "";
  if (first === "") {
    return null;
  }
  return createHash("sha256").update(first).digest("hex").slice(0, 16);
}

/**
 * Warn about a rejected signature.
 *
 * The provider and the hashed client IP are logged; the raw payload, the headers
 * and the raw IP are not (§0.15, CONVENTIONS §5.3).
 */
function warnRejectedSignature(request: Request, provider: string, reason: string): void {
  getLogger().warn("provider webhook signature rejected", {
    event: "webhook.signature_rejected",
    provider,
    reason,
    ipHash: hashClientIp(request),
  });
}

/** The `sha256` digest of the raw body, the identity of an id-less payload. */
function payloadHashOf(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

export const POST = defineRoute({
  route: "/api/v1/webhooks/:provider",
  response: receiptSchema,
  handler: async (ctx) => {
    const request = ctx.request;
    const providerKey = providerFromRequest(request);
    const config = getConfig();

    if (config.payments.provider !== providerKey) {
      getLogger().warn("provider webhook for an unregistered provider", {
        event: "webhook.provider_unknown",
        provider: providerKey,
      });
      throw appError("not_found", { details: { provider: providerKey } });
    }

    // §10.1.1: the signature covers the raw bytes. `parseJsonBody` is not
    // declared on this route, so this is the request stream's only reader.
    const rawBody = await request.text();
    const headers = webhookHeaders(request);
    const timestamp = headers["x-webhook-timestamp"];
    const signature = headers["x-webhook-signature"];

    // A missing timestamp or signature is `invalid_signature`, never "no window
    // to check" (ADR-0440 §2).
    if (timestamp === undefined || signature === undefined) {
      warnRejectedSignature(request, providerKey, "missing_signature_headers");
      throw appError("invalid_signature");
    }

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs)) {
      warnRejectedSignature(request, providerKey, "unparseable_timestamp");
      throw appError("invalid_signature");
    }
    if (Math.abs(systemClock.now().getTime() - timestampMs) > REPLAY_WINDOW_MS) {
      warnRejectedSignature(request, providerKey, "stale_timestamp");
      throw appError("stale_signature");
    }

    const provider = getPaymentProvider();
    if (!provider.verifyWebhook(rawBody, headers)) {
      warnRejectedSignature(request, providerKey, "signature_mismatch");
      throw appError("invalid_signature");
    }

    // §10.1 step 3 needs the normalized event: identity, kind and the refs.
    let payload: unknown;
    let event;
    try {
      payload = JSON.parse(rawBody);
      event = provider.parseWebhook(rawBody);
    } catch {
      // A body the adapter cannot normalize is a client error, and nothing is
      // written: there is no event type to record and nothing to re-project.
      throw appError("malformed_json", { details: { provider: providerKey } });
    }

    const db = getDb();
    const now = systemClock.now();
    const settings = await getPlatformSettings({ db, clock: systemClock });
    const inbox = platformRepo(db).collection(COLLECTIONS.providerWebhookEvents);

    let insertedId: ObjectId;
    try {
      const result = await inbox.insertOne({
        provider: providerKey,
        env: paymentEnvironmentFor(config.app.env),
        eventType: event.kind,
        providerEventId: event.providerEventId,
        payloadHash: event.providerEventId === null ? payloadHashOf(rawBody) : null,
        signatureValid: true,
        rawPayload: payload,
        receivedAt: now,
        processedAt: null,
        processResult: null,
        processError: null,
        expireAt: addDays(now, settings.retention.webhookDays),
      });
      insertedId = result.insertedId;
    } catch (error: unknown) {
      // §10.1.1: the unique index *is* the dedupe. A replay is expected control
      // flow, not an error.
      if (isDuplicateKeyError(error)) {
        return { body: DUPLICATE_IGNORED };
      }
      throw error;
    }

    // §10.1 steps 5–6: the provider is answered now, the projection runs after.
    after(() => projectProviderWebhookEvent(insertedId));
    return { body: RECEIVED };
  },
});
