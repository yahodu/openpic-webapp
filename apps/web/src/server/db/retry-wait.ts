/**
 * The bounded wait a loser of a write race uses to answer the winner's committed
 * state (OP-121, ADR-0669).
 *
 * A loser can spend its whole `withTransaction` retry budget while the winner's
 * transaction is still open, so a single re-read still sees the pre-commit row
 * and would answer `500`. Polling until the winner's commit is visible answers
 * the same settled state instead. Both rivals this repository waits on — an
 * invitation decision and an event-member removal — share this one wait; their
 * call sites' docblocks name the record that explains each of them.
 */

/**
 * How long a loser of a commit race waits for the winner's commit, in ms.
 *
 * shortcut: a fixed ceiling, not the winner's own duration; a winner still
 * uncommitted at the ceiling keeps its original `500`. Upgrade to a shared
 * per-resource lock if a bounded wait proves too short.
 */
export const RIVAL_COMMIT_TIMEOUT_MS = 1_000;

/** Poll interval while waiting for the winner's commit, in ms. */
export const RIVAL_COMMIT_POLL_MS = 25;

/** Resolve after `ms`, for the bounded wait below. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll `read` until `isSettled` accepts a row, bounded by
 * {@link RIVAL_COMMIT_TIMEOUT_MS}.
 *
 * The ceiling bounds the **wait**, not the poll count: polls are taken at
 * `0, 25, … 1_000` ms (41 reads) and the loop sleeps only when another poll
 * follows, so the last check is at the ceiling rather than one interval past it.
 * The poll stays linear — it is a timeout, not a backoff — so a winner that
 * commits late is still answered within one interval; the read cost it pays is
 * recorded in ADR-0669 §Consequences.
 *
 * @param read - One read of the row the rival writes.
 * @param isSettled - True once the row carries the rival's committed write.
 * @returns `true` once settled, `false` when the ceiling passed without it.
 */
export async function waitForCommitted<T>(
  read: () => Promise<T>,
  isSettled: (row: T) => boolean
): Promise<boolean> {
  for (let waited = 0; waited <= RIVAL_COMMIT_TIMEOUT_MS; waited += RIVAL_COMMIT_POLL_MS) {
    if (isSettled(await read())) {
      return true;
    }
    if (waited + RIVAL_COMMIT_POLL_MS > RIVAL_COMMIT_TIMEOUT_MS) {
      break;
    }
    await sleep(RIVAL_COMMIT_POLL_MS);
  }
  return false;
}
