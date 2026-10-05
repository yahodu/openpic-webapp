/**
 * Shared Novu HTTP plumbing (OP-92).
 *
 * The drift guard, the workflow-upsert CLI and the transport adapter all speak
 * to the same Novu API with the same `ApiKey` authorization scheme and read the
 * same workflow list. This module owns that scheme and that single read so the
 * three call sites cannot drift apart.
 */
import { novuWorkflowListSchema, type NovuWorkflowList } from "./schemas";

/** A Novu API origin and key. */
export interface NovuConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** The `ApiKey` authorization (and JSON accept) headers for a Novu request. */
export function novuAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `ApiKey ${apiKey}`, accept: "application/json" };
}

/** The outcome of reading the Novu workflow list. */
export type WorkflowListRead =
  | { readonly ok: true; readonly workflows: NovuWorkflowList }
  | { readonly ok: false; readonly status?: number };

/**
 * Read every workflow from `GET {baseUrl}/v1/workflows`.
 *
 * @param connection - The Novu origin and API key.
 * @returns `{ ok: true, workflows }` on a schema-valid list; `{ ok: false,
 *   status }` when Novu answered non-2xx; `{ ok: false }` when the body did not
 *   match the pinned contract. A network failure propagates to the caller.
 */
export async function readNovuWorkflowList(connection: NovuConnection): Promise<WorkflowListRead> {
  const response = await fetch(`${connection.baseUrl}/v1/workflows`, {
    method: "GET",
    headers: novuAuthHeaders(connection.apiKey),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const body: unknown = await response.json();
  const parsed = novuWorkflowListSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false };
  }

  return { ok: true, workflows: parsed.data };
}
