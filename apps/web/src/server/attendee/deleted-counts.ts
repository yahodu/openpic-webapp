/**
 * The withdrawal's `X-Deleted-Counts` header (OP-131, contract §6.2;
 * ADR-0789 §1).
 *
 * `DELETE /p/events/{slug}/consent` answers `204`, so the header is the only
 * place the client — and the DSR `executionLog` — can learn *what* was
 * destroyed. §6.2 fixes the string as `selfies=1;embeddings=1;matches=1904`, so
 * its shape is a wire contract: a client splits on `;` and `=`, which a space or
 * a reordered field would silently break.
 */

/** The §6.2 response header name, in the casing a header map stores. */
export const DELETED_COUNTS_HEADER = "x-deleted-counts";

/** What one withdrawal destroyed. */
export interface DeletedCounts {
  /** The `selfies` rows removed. */
  readonly selfies: number;
  /** The selfie rows that carried a face vector (schema §16.4). */
  readonly embeddings: number;
  /** The `faceMatches` rows removed. */
  readonly matches: number;
}

/**
 * Render the §6.2 header value: `selfies=<n>;embeddings=<n>;matches=<n>`.
 *
 * @param counts - The counts of the completed withdrawal.
 * @returns The header value in the contract's field order, with no whitespace.
 */
export function formatDeletedCounts(counts: DeletedCounts): string {
  return `selfies=${String(counts.selfies)};embeddings=${String(counts.embeddings)};matches=${String(counts.matches)}`;
}
