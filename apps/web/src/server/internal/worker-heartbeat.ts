/**
 * The worker heartbeat response builder (OP-135; contract §10.3.2, §9.10;
 * schema §20.4; ADR-0829 §1).
 *
 * §10.3.2 calls the heartbeat's answer the worker's **configuration channel**:
 * the face space, the lease length, the attempt ceiling and the operator's
 * pause switch reach the worker without a redeploy. Every value is therefore a
 * read of `platformSettings`, and this builder only shapes it — the route
 * resolves the settings document and records the liveness row.
 */

/** The `pipeline`/`face` settings a worker is paced by (§20.4). */
export interface HeartbeatConfig {
  readonly activeSpaceKey: string;
  readonly leaseMinutes: number;
  readonly maxAttempts: number;
  readonly pauseRequested: boolean;
}

/** The five-key configuration channel §10.3.2 answers with. */
export interface HeartbeatResponse extends HeartbeatConfig {
  readonly acknowledged: true;
}

/**
 * Shape the configuration channel for one heartbeat.
 *
 * @param config - The four settings values the route read.
 * @returns The five-key answer, acknowledged.
 */
export function buildHeartbeatResponse(config: HeartbeatConfig): HeartbeatResponse {
  return {
    acknowledged: true,
    activeSpaceKey: config.activeSpaceKey,
    leaseMinutes: config.leaseMinutes,
    maxAttempts: config.maxAttempts,
    pauseRequested: config.pauseRequested,
  };
}
