import type { RepositoryCollection } from "@/server/repos";

/**
 * The upgrade-only suppression write (OP-137, design §19.6; ADR-0891).
 *
 * Two writers own the same `{channel, contactHash}` row: the delivery-receipt
 * projection (ADR-0882) and the one-click unsubscribe route (ADR-0240). A
 * `hard_bounce`, a `complaint` and a `dnd_registry` suppression are all-scope; a
 * marketing unsubscribe is `marketing`-scope and must never block a
 * transactional message (§10.1.3). The key is shared, so whichever write landed
 * second used to decide which contacts keep receiving. Every write therefore
 * goes through one ladder: a row only ever moves to the stronger scope, the
 * strongest reason and a `null` `expiresAt`, which re-arms a lapsed row.
 */

/** One suppression a writer wants stored (§19.6). */
export interface SuppressionWrite {
  readonly channel: string;
  /** `"sha256:"` + the shared contact digest (§19.6, ADR-0875 §1). */
  readonly contactHash: string;
  readonly reason: "hard_bounce" | "complaint" | "unsubscribe" | "dnd_registry";
  readonly scope: "all" | "marketing";
  /** Provenance: written on insert and on an upgrade; omitted by a writer that stores none. */
  readonly source?: { readonly provider: string; readonly providerEventId: string | null };
}

/** Scope strength: `all` outranks `marketing` (§10.1.3). */
const SCOPE_RANK = { all: 2, marketing: 1 } as const;

/**
 * Store one suppression, upgrading an existing row and never weakening it.
 *
 * One conditional upsert, expressed as an aggregation-pipeline update: the
 * decision needs the stored row, so a `$set` would let a marketing unsubscribe
 * narrow an all-scope hard bounce. A row that is already stronger is left as it
 * is; `createdAt` is written once.
 *
 * @param suppressions - The `notificationSuppressions` handle.
 * @param write - The suppression this writer wants stored.
 * @param now - The instant the write runs at; `createdAt` is insert-only.
 */
export async function upsertSuppression(
  suppressions: RepositoryCollection,
  write: SuppressionWrite,
  now: Date
): Promise<void> {
  // True when the incoming write is at least as strong as the stored row. An
  // absent row has no `$scope`, so it ranks lowest and an insert always applies.
  const applies = {
    $lte: [
      { $cond: [{ $eq: ["$scope", "all"] }, SCOPE_RANK.all, SCOPE_RANK.marketing] },
      SCOPE_RANK[write.scope],
    ],
  };
  // The stored value when the incoming write is weaker, the new value otherwise.
  const ladder = (field: string, value: unknown): Record<string, unknown> => ({
    $cond: [applies, value, `$${field}`],
  });

  await suppressions.updateOne(
    { channel: write.channel, contactHash: write.contactHash },
    [
      {
        $set: {
          channel: write.channel,
          contactHash: write.contactHash,
          reason: ladder("reason", write.reason),
          scope: ladder("scope", write.scope),
          ...(write.source === undefined ? {} : { source: ladder("source", write.source) }),
          expiresAt: ladder("expiresAt", null),
          createdAt: { $ifNull: ["$createdAt", now] },
        },
      },
    ],
    { upsert: true }
  );
}
