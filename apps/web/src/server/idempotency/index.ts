/**
 * Idempotency stage (API contract §0.9).
 *
 * Public surface consumed by `defineRoute` route handlers: the stage itself,
 * the pure helpers it is built from, and the MongoDB-backed store adapter.
 */

export { canonicalJson } from "./canonical-json";
export { requestHash, type RequestHashInput } from "./request-hash";
export { replayedStatus } from "./replay";
export {
  mongoIdempotencyStore,
  type IdempotencyLookup,
  type IdempotencyRecord,
  type IdempotencyRecordStatus,
  type IdempotencySnapshot,
  type IdempotencyStore,
} from "./store";
export { idempotencyStage, type IdempotencyStageOptions } from "./stage";
