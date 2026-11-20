import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { after } from "next/server";
import { z } from "zod";

import { getAppEnv, getNovuRuntimeConfig } from "@/server/config/env";
import { COLLECTIONS } from "@/server/db/collections";
import { getDb } from "@/server/db/mongo";
import { defineRoute } from "@/server/http/define-route";
import { appError } from "@/server/http/errors";
import { getLogger } from "@/server/logging";
import { projectDeliveryReceipt } from "@/server/notifications/receipt-projection";
import { platformRepo } from "@/server/repos";
import { systemClock } from "@/server/runtime/clock";
import { addDays } from "@/server/runtime/time";
import { getPlatformSettings } from "@/server/settings/platform-settings";

/**
 * `POST /api/v1/webhooks/novu` — the message-transport delivery receipts
 * (OP-137, contract §10.1.3; ADR-0875 §2/§3).
 *
 * Its own route rather than a `{provider}` segment: the payment inbox's first
 * act is to compare that segment with `config.payments.provider`, and a
 * transport receipt has no such selector. Everything else is the OP-108 inbox
 * shape, exactly:
 *
 *   1. read the **raw** body (`request.text()`, never a parsed one) and verify
 *      the signature → `401`, no write;
 *   2. the timestamp must fall inside the ±300 s replay window → `401`;
 *   3. the provider's own event id (`webhook-id`) is the identity the
 *      `providerWebhookEvents` unique index dedupes on;
 *   4. a duplicate-key error answers `200 duplicate_ignored` and does nothing;
 *   5. `200 {"status":"received"}` is answered **before** any projection work,
 *      which is registered with `after()`.
 *
 * The signature is **Svix's**, which is what Novu uses: headers `webhook-id`,
 * `webhook-timestamp` and `webhook-signature: v1,<base64>`, over
 * `"<id>.<timestamp>.<rawBody>"`, keyed by the base64-decoded
 * `NOVU_WEBHOOK_SECRET` with its `whsec_` prefix stripped. A header carrying
 * several space-separated `v1,` entries verifies when **any** entry matches
 * (key rotation). A blank or absent secret refuses every receipt — a missing
 * credential is a refusal, never a wildcard.
 *
 * The payload is stored as the parsed JSON and validated by the adapter schema
 * in the projection, so a shape change is recorded as `processResult: "error"`
 * on the inbox row (naming the field) instead of failing the provider's POST.
 */

/** The port's replay window: how far a webhook timestamp may be from now (§10.1). */
const REPLAY_WINDOW_MS = 300_000;

/** The bare §10.1 receipt: no event id, no `processedAt` — nothing to leak. */
const receiptSchema = z.object({ status: z.enum(["received", "duplicate_ignored"]) });

/** The receipt a fresh delivery gets. */
const RECEIVED = { status: "received" } as const;

/** The receipt a replayed delivery gets. */
const DUPLICATE_IGNORED = { status: "duplicate_ignored" } as const;

/** The `providerWebhookEvents.eventType` a receipt row carries (§18.4). */
const RECEIPT_EVENT_TYPE = "receipt";

/** The HMAC key Svix derives from a `whsec_`-prefixed secret. */
function signingKey(secret: string): Buffer {
  return Buffer.from(secret.replace(/^whsec_/, ""), "base64");
}

/**
 * Verify one delivery against the Svix signature header.
 *
 * @param input - The secret, the three headers and the raw body bytes.
 * @returns `true` when any `v1,` entry matches the recomputed HMAC.
 */
function signatureMatches(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: string;
  readonly rawBody: string;
  readonly header: string;
}): boolean {
  const expected = createHmac("sha256", signingKey(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.rawBody}`, "utf8")
    .digest();

  return input.header.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || signature === undefined || signature === "") {
      return false;
    }
    const given = Buffer.from(signature, "base64");
    // Constant-time, and a length mismatch can never be a match.
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * A short, stable hash of the caller's IP.
 *
 * The rejected-signature warn must be actionable without turning the log sink
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

/** Warn about a rejected signature; the payload, headers and raw IP stay out. */
function warnRejectedSignature(request: Request, reason: string): void {
  getLogger().warn("novu webhook signature rejected", {
    event: "webhook.signature_rejected",
    provider: "novu",
    reason,
    ipHash: hashClientIp(request),
  });
}

export const POST = defineRoute({
  route: "/api/v1/webhooks/novu",
  response: receiptSchema,
  handler: async (ctx) => {
    const request = ctx.request;

    // §10.1.1: the signature covers the raw bytes. No request schema is
    // declared, so this is the request stream's only reader.
    const rawBody = await request.text();
    const id = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");
    const signature = request.headers.get("webhook-signature");

    const secret = getNovuRuntimeConfig().webhookSecret;
    if (secret.trim() === "") {
      // Fail closed: an unconfigured deployment accepts nothing.
      warnRejectedSignature(request, "webhook_secret_not_configured");
      throw appError("invalid_signature");
    }

    if (id === null || timestamp === null || signature === null) {
      warnRejectedSignature(request, "missing_signature_headers");
      throw appError("invalid_signature");
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds)) {
      warnRejectedSignature(request, "unparseable_timestamp");
      throw appError("invalid_signature");
    }
    if (Math.abs(systemClock.now().getTime() - timestampSeconds * 1000) > REPLAY_WINDOW_MS) {
      warnRejectedSignature(request, "stale_timestamp");
      throw appError("stale_signature");
    }

    if (!signatureMatches({ secret, id, timestamp, rawBody, header: signature })) {
      warnRejectedSignature(request, "signature_mismatch");
      throw appError("invalid_signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      // Nothing to record and nothing to re-project: there is no payload.
      throw appError("malformed_json", { details: { provider: "novu" } });
    }

    const db = getDb();
    const now = systemClock.now();
    const settings = await getPlatformSettings({ db, clock: systemClock });
    const inbox = platformRepo(db).collection(COLLECTIONS.providerWebhookEvents);

    let insertedId;
    try {
      const result = await inbox.insertOne({
        provider: "novu",
        env: getAppEnv(),
        eventType: RECEIPT_EVENT_TYPE,
        providerEventId: id,
        payloadHash: null,
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
    after(() => projectDeliveryReceipt(insertedId));
    return { body: RECEIVED };
  },
});

/** True when an error is MongoDB's duplicate-key (E11000) refusal. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === 11000
  );
}
