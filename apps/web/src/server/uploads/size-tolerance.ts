/**
 * The completion path's stored-size tolerance (OP-124 U1, contract §5.3,
 * ADR-0720 D1).
 *
 * `POST …/uploads/{uploadSessionId}/complete` carries the client's `bytes` and
 * the server `HeadObject`s the object it presigned. The two numbers may
 * disagree by **at most 1 %** — a client that miscounts a trailing byte is not
 * a corrupt upload — and anything past that is `409 size_mismatch`.
 *
 * The base of the percentage is the **declared** value: the client's `bytes` is
 * the number the rule applies to, so `|stored − declared| × 100 ≤ declared`
 * (integer arithmetic, boundary inclusive) is the whole contract.
 */

/** The declared and stored sizes of one completed upload. */
export interface SizeToleranceInput {
  /** The `bytes` the client declared on `complete` (and on `params`). */
  readonly declaredBytes: number;
  /** The `ContentLength` the object store answered on `HeadObject`. */
  readonly storedBytes: number;
}

/**
 * Whether a stored object size agrees with the declared size within 1 %.
 *
 * @param input - The declared and stored sizes.
 * @returns `true` when the disagreement is at most 1 % of the declaration.
 * @example
 * sizeWithinTolerance({ declaredBytes: 10_000, storedBytes: 10_100 }); // true
 * sizeWithinTolerance({ declaredBytes: 10_000, storedBytes: 10_101 }); // false
 */
export function sizeWithinTolerance(input: SizeToleranceInput): boolean {
  const difference = Math.abs(input.storedBytes - input.declaredBytes);
  return difference * 100 <= input.declaredBytes;
}
