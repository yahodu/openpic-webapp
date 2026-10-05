/**
 * Novu `MessageTransport` adapter (OP-92, ADR-0072).
 *
 * This is the only module that talks to Novu's HTTP API. It derives the Novu
 * subscriber from the message's `userId`, passes the rendered content through
 * as the trigger `payload`, validates both directions at the boundary, applies
 * the timeout and error classification, and returns the vendor-neutral receipt
 * (`data.transactionId` → `providerMessageId`).
 */
import { getConfig } from "../../config/env";
import type { Logger } from "../../logging";
import type {
  MessageTransport,
  OutboundChannel,
  OutboundMessage,
  OutboundRecipient,
  TransportReceipt,
} from "../../notifications/message-transport";
import {
  TransportError,
  UpstreamContractError,
  classifyTransportFailure,
} from "../transport-error";
import { novuTriggerRequestSchema, novuTriggerResponseSchema } from "./schemas";
import { novuAuthHeaders } from "./novu-http";
import { workflowIdForChannel } from "./workflow-map";

/** The log event emitted for a successful send. */
export const TRANSPORT_SENT_EVENT = "transport.sent";

/** The log event emitted when Novu answers with an unpinned shape. */
export const UPSTREAM_CONTRACT_VIOLATION_EVENT = "transport.upstream_contract_violation";

/** Options for {@link novuTransport}. */
export interface NovuTransportOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly logger?: Logger;
  /** Per-request timeout in ms; defaults to `getConfig().transport.timeoutMs`. */
  readonly timeoutMs?: number;
}

/**
 * Timeout used when the application configuration is not available (e.g. a
 * bare unit/integration harness that never loads the environment). Mirrors the
 * `NOVU_TIMEOUT_MS` default so the adapter still behaves deterministically.
 */
const FALLBACK_TIMEOUT_MS = 10_000;

/** Resolve the configured timeout, degrading to the fallback when unconfigured. */
function configuredTimeoutMs(): number {
  try {
    return getConfig().transport.timeoutMs;
  } catch {
    return FALLBACK_TIMEOUT_MS;
  }
}

/** Build the inline `to` recipient for the given channel. */
function buildRecipient(
  channel: OutboundChannel,
  to: OutboundRecipient
): { readonly subscriberId: string; readonly email?: string; readonly phone?: string } {
  if (channel === "email") {
    return to.email === undefined
      ? { subscriberId: to.userId }
      : { subscriberId: to.userId, email: to.email };
  }
  return to.phoneE164 === undefined
    ? { subscriberId: to.userId }
    : { subscriberId: to.userId, phone: to.phoneE164 };
}

/** Pass the rendered content through as the Novu trigger payload. */
function buildPayload(message: OutboundMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (message.subject !== undefined) {
    payload.subject = message.subject;
  }
  if (message.html !== undefined) {
    payload.html = message.html;
  }
  if (message.text !== undefined) {
    payload.text = message.text;
  }
  if (message.templateName !== undefined) {
    payload.templateName = message.templateName;
  }
  if (message.variables !== undefined) {
    payload.variables = message.variables;
  }
  if (message.headers !== undefined) {
    payload.headers = message.headers;
  }
  return payload;
}

/**
 * Build a Novu-backed {@link MessageTransport}.
 *
 * @param options - Base URL, API key, optional logger and timeout override.
 * @returns The transport adapter.
 */
export function novuTransport(options: NovuTransportOptions): MessageTransport {
  const timeoutMs = options.timeoutMs ?? configuredTimeoutMs();
  const triggerUrl = `${options.baseUrl}/v1/events/trigger`;

  return {
    async send(message: OutboundMessage): Promise<TransportReceipt> {
      const request = {
        name: workflowIdForChannel(message.channel),
        to: buildRecipient(message.channel, message.to),
        payload: buildPayload(message),
      };

      const validatedRequest = novuTriggerRequestSchema.safeParse(request);
      if (!validatedRequest.success) {
        throw new TransportError("Outbound message did not match the Novu trigger contract.", {
          retryable: false,
          code: "invalid_request",
          cause: validatedRequest.error,
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetch(triggerUrl, {
          method: "POST",
          headers: { ...novuAuthHeaders(options.apiKey), "content-type": "application/json" },
          body: JSON.stringify(validatedRequest.data),
          signal: controller.signal,
        });
      } catch (error) {
        throw classifyTransportFailure({ error });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw classifyTransportFailure({ status: response.status });
      }

      const body: unknown = await response.json();
      const parsed = novuTriggerResponseSchema.safeParse(body);
      if (!parsed.success) {
        options.logger?.error("Novu trigger response did not match the contract.", {
          event: UPSTREAM_CONTRACT_VIOLATION_EVENT,
        });
        throw new UpstreamContractError("Novu returned an unexpected payload shape.", {
          cause: parsed.error,
        });
      }

      const providerMessageId = parsed.data.data.transactionId;
      options.logger?.info("Outbound message accepted by Novu.", {
        event: TRANSPORT_SENT_EVENT,
        channel: message.channel,
        provider: "novu",
        messageId: providerMessageId,
      });

      return { providerMessageId };
    },
  };
}
