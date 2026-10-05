/**
 * Novu workflow upsert engine (OP-92 §5, ADR-0074).
 *
 * Novu must hold exactly the three single-step pass-through workflows. This
 * engine lists the existing workflows and creates only the missing ones, so a
 * second run is a no-op. `scripts/novu/upsert-workflows.ts` is the thin CLI;
 * the engine lives here so it is unit-testable in-process against MSW.
 */
import type { Logger } from "../../logging";
import { novuAuthHeaders, readNovuWorkflowList } from "./novu-http";
import { toTransportWorkflows } from "./workflow-drift";
import { TRANSPORT_WORKFLOW_IDS, channelForWorkflowId } from "./workflow-map";

/** The log event emitted when the upsert cannot complete. */
export const WORKFLOW_UPSERT_FAILED_EVENT = "transport.workflow_upsert_failed";

/** The create body for one transport workflow (`POST /v1/workflows`). */
export interface TransportWorkflowCreateBody {
  readonly workflowId: string;
  readonly name: string;
  readonly active: true;
  readonly steps: readonly {
    readonly active: true;
    readonly template: { readonly type: string };
  }[];
}

/** Options for {@link runWorkflowUpsert}. */
export interface UpsertWorkflowsOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly logger?: Logger;
}

/**
 * The three canonical create bodies, in workflow-id order.
 *
 * @returns One create body per transport workflow.
 */
export function buildTransportWorkflowBodies(): TransportWorkflowCreateBody[] {
  return TRANSPORT_WORKFLOW_IDS.map((workflowId) => {
    const channel = channelForWorkflowId(workflowId);
    if (channel === undefined) {
      throw new Error(`Transport workflow '${workflowId}' has no channel mapping.`);
    }
    return {
      workflowId,
      name: workflowId,
      active: true,
      steps: [{ active: true, template: { type: channel } }],
    };
  });
}

/**
 * Create any missing transport workflow and return a process exit code.
 *
 * @param options - Novu base URL, API key and optional logger.
 * @returns `0` when the three workflows exist, non-zero on any failure.
 */
export async function runWorkflowUpsert(options: UpsertWorkflowsOptions): Promise<number> {
  const url = `${options.baseUrl}/v1/workflows`;

  try {
    const read = await readNovuWorkflowList(options);
    if (!read.ok) {
      if (read.status === undefined) {
        options.logger?.error("Novu workflow list response did not match the contract.", {
          event: WORKFLOW_UPSERT_FAILED_EVENT,
        });
      } else {
        options.logger?.error("Novu workflow list request failed.", {
          event: WORKFLOW_UPSERT_FAILED_EVENT,
          status: read.status,
        });
      }
      return 1;
    }

    const existing = new Set(
      toTransportWorkflows(read.workflows).map((workflow) => workflow.workflowId)
    );

    for (const body of buildTransportWorkflowBodies()) {
      if (existing.has(body.workflowId)) {
        continue;
      }

      const createResponse = await fetch(url, {
        method: "POST",
        headers: { ...novuAuthHeaders(options.apiKey), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!createResponse.ok) {
        options.logger?.error("Novu workflow create request failed.", {
          event: WORKFLOW_UPSERT_FAILED_EVENT,
          status: createResponse.status,
          workflowId: body.workflowId,
        });
        return 1;
      }
    }

    return 0;
  } catch (error) {
    options.logger?.error("Novu workflow upsert failed.", {
      event: WORKFLOW_UPSERT_FAILED_EVENT,
      err: error,
    });
    return 1;
  }
}
