import { describe, expect, it } from "vitest";

import { planCatalogueETag } from "@/server/plans/plan-etag";

/**
 * Unit contract — the `GET /plans` catalogue entity tag (OP-102, contract §3.1,
 * §0.10, ADR-0320).
 *
 * `GET /plans` is `public, max-age=300` and supports a conditional request
 * (contract §3.1), so the tag must be a function of the catalogue's **plan
 * versions** and nothing else: an unchanged catalogue revalidates to `304`,
 * while any plan whose entitlements changed (a `version` bump — ADR-0014 §6)
 * must invalidate every cached copy so no client serves stale limits.
 *
 * The tag's *shape* is deliberately not pinned (weak vs strong, hash vs
 * join): only the invariant matters — same versions ⇒ same tag, changed
 * version set ⇒ different tag. The conditional-request plumbing itself is
 * already pinned by `conditional-etag.test.ts`.
 *
 * ## Contract expected of the implementation
 *
 * `@/server/plans/plan-etag` exports:
 *
 *   planCatalogueETag(entries: readonly { readonly key: string; readonly version: number }[]): string
 */
describe("planCatalogueETag", () => {
  it("is stable for the same plan versions", () => {
    const first = planCatalogueETag([
      { key: "free", version: 1 },
      { key: "starter", version: 3 },
    ]);
    const second = planCatalogueETag([
      { key: "free", version: 1 },
      { key: "starter", version: 3 },
    ]);

    expect(first).toBe(second);
  });

  it("changes when a plan's version is bumped", () => {
    const before = planCatalogueETag([{ key: "starter", version: 3 }]);
    const after = planCatalogueETag([{ key: "starter", version: 4 }]);

    expect(after).not.toBe(before);
  });

  it("changes when a plan is added to the catalogue", () => {
    const before = planCatalogueETag([{ key: "free", version: 1 }]);
    const after = planCatalogueETag([
      { key: "free", version: 1 },
      { key: "starter", version: 1 },
    ]);

    expect(after).not.toBe(before);
  });

  it("changes when a plan is removed from the catalogue", () => {
    const before = planCatalogueETag([
      { key: "free", version: 1 },
      { key: "starter", version: 1 },
    ]);
    const after = planCatalogueETag([{ key: "free", version: 1 }]);

    expect(after).not.toBe(before);
  });

  it("returns a stable, non-empty tag for an empty catalogue", () => {
    const first = planCatalogueETag([]);

    expect(first.length).toBeGreaterThan(0);
    expect(planCatalogueETag([])).toBe(first);
  });
});
