/**
 * Novu workflow drift guard (OP-92, notification design §8.3 / API contract §9.4).
 *
 * A dashboard edit that adds a workflow, adds a second step, or changes a
 * step's channel silently changes production behaviour. This module is the
 * guard: {@link checkTransportWorkflows} is pure over normalized workflows,
 * {@link runTransportDriftCheck} fetches every workflow from Novu and returns a
 * process exit code, and `scripts/novu/assert-no-drift.ts` is the thin CLI.
 */
import type { Logger } from "../../logging";
import {
  novuWorkflowListSchema,
  transportWorkflowListSchema,
  type NovuWorkflowList,
  type TransportWorkflow,
} from "./schemas";
import { TRANSPORT_WORKFLOW_IDS, channelForWorkflowId } from "./workflow-map";

/** The outcome of a pure drift check. */
export interface WorkflowDriftReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** The log event emitted when drift (or a fetch failure) is detected. */
export const WORKFLOW_DRIFT_EVENT = "transport.workflow_drift";

/**
 * Assert that a workflow set is exactly the three transport workflows, each
 * with exactly one step whose channel matches its workflow name.
 *
 * @param workflows - The normalized workflows to check.
 * @returns `{ ok, problems }`; `problems` is empty iff the set passes.
 */
export function checkTransportWorkflows(
  workflows: readonly TransportWorkflow[]
): WorkflowDriftReport {
  const problems: string[] = [];
  const byId = new Map<string, TransportWorkflow>();
  const expected = new Set<string>(TRANSPORT_WORKFLOW_IDS);

  for (const workflow of workflows) {
    byId.set(workflow.workflowId, workflow);
    if (!expected.has(workflow.workflowId)) {
      problems.push(`unexpected workflow '${workflow.workflowId}' is not a transport workflow`);
    }
  }

  for (const workflowId of TRANSPORT_WORKFLOW_IDS) {
    const workflow = byId.get(workflowId);
    if (workflow === undefined) {
      problems.push(`transport workflow '${workflowId}' is missing`);
      continue;
    }

    if (workflow.steps.length !== 1) {
      problems.push(
        `transport workflow '${workflowId}' must have exactly one step, found ${String(workflow.steps.length)}`
      );
      continue;
    }

    const [step] = workflow.steps;
    if (step === undefined) {
      continue;
    }
    const expectedChannel = channelForWorkflowId(workflowId);
    if (expectedChannel !== undefined && step.channel !== expectedChannel) {
      problems.push(
        `transport workflow '${workflowId}' step channel '${step.channel}' does not match '${expectedChannel}'`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Normalize the raw Novu workflow list (`steps[].template.type` → `channel`).
 *
 * @param list - The raw `GET /v1/workflows` payload, already schema-valid.
 * @returns The normalized transport workflows.
 */
export function toTransportWorkflows(list: NovuWorkflowList): TransportWorkflow[] {
  return transportWorkflowListSchema.parse(
    list.data.map((workflow) => ({
      workflowId: workflow.workflowId,
      steps: workflow.steps.map((step) => ({
        active: step.active,
        channel: step.template.type,
      })),
    }))
  );
}

/** Options for a drift check. */
export interface TransportDriftOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly logger?: Logger;
}

/**
 * Fetch every Novu workflow, run the pure drift assertion and return an exit
 * code (`0` ok, `1` on drift or a fetch/contract failure).
 *
 * @param options - Novu base URL, API key and optional logger.
 * @returns The process exit code.
 */
export async function runTransportDriftCheck(options: TransportDriftOptions): Promise<number> {
  const url = `${options.baseUrl}/v1/workflows`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `ApiKey ${options.apiKey}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      options.logger?.error("Novu workflow list request failed.", {
        event: WORKFLOW_DRIFT_EVENT,
        status: response.status,
      });
      return 1;
    }

    const body: unknown = await response.json();
    const parsed = novuWorkflowListSchema.safeParse(body);
    if (!parsed.success) {
      options.logger?.error("Novu workflow list response did not match the contract.", {
        event: WORKFLOW_DRIFT_EVENT,
      });
      return 1;
    }

    const report = checkTransportWorkflows(toTransportWorkflows(parsed.data));
    if (!report.ok) {
      options.logger?.error("Novu workflow drift detected.", {
        event: WORKFLOW_DRIFT_EVENT,
        problems: report.problems,
      });
      return 1;
    }

    return 0;
  } catch (error) {
    options.logger?.error("Novu workflow drift check failed.", {
      event: WORKFLOW_DRIFT_EVENT,
      err: error,
    });
    return 1;
  }
}
