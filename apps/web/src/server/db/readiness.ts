import { getDb } from "./mongo";

/**
 * Readiness probe seam (OP-75, §4).
 *
 * The readiness endpoint must be exercisable without a reachable database, so
 * the actual ping is resolved through a swappable probe. Production uses the
 * default `pingMongo`; specs override it with {@link setReadinessProbe}.
 */

/** A readiness check: resolves when the dependency answers, rejects otherwise. */
export type ReadinessProbe = () => Promise<void>;

let probeOverride: ReadinessProbe | undefined;

/**
 * Install (or clear) the readiness probe.
 *
 * @param probe - The probe to use, or `undefined` to restore the default ping.
 */
export function setReadinessProbe(probe: ReadinessProbe | undefined): void {
  probeOverride = probe;
}

/** The default probe: ping the primary through the shared client. */
async function pingMongo(): Promise<void> {
  await getDb().command({ ping: 1 });
}

/**
 * Resolve the probe the readiness endpoint should call.
 *
 * @returns The override when installed, otherwise the real Mongo ping.
 */
export function getReadinessProbe(): ReadinessProbe {
  return probeOverride ?? pingMongo;
}
