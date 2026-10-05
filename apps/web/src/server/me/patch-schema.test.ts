import { describe, expect, it } from "vitest";

import { mePatchSchema } from "./patch-schema";

/**
 * Unit — the `PATCH /me` body schema (OP-90, contract §1.2).
 *
 * The request contract: every field is optional and **at least one is
 * required**; `displayName` is trimmed and 1–80 characters; `marketingOptIn`
 * is a real boolean (an explicit `false` is a provided field, not an absent
 * one); `avatarAssetId` may be `null` to clear the avatar.
 *
 * Field-level rejections that need the stored data or a catalogue error code —
 * unknown IANA zone → `422 unknown_timezone`, and camera/internally-owned
 * fields such as `email`, `phoneNumber` and `platformRole` → `422
 * forbidden_field` — are pinned at the HTTP level in
 * `src/test/integration/me-current-user.test.ts`, not by this pure schema.
 *
 * Contract expected of the implementation:
 *
 *   @/server/me/patch-schema exports mePatchSchema: z.ZodType<MePatch>
 *
 * The schema must not silently strip unknown keys and report an empty body:
 * the route must still see a supplied `email`/`platformRole` to reject it with
 * `422 forbidden_field` (I4/I6), so the schema and route together must produce
 * that code, not `validation_failed`.
 */

describe("mePatchSchema (§1.2)", () => {
  it("U2: rejects an empty body — at least one field is required", () => {
    expect(mePatchSchema.safeParse({}).success).toBe(false);
  });

  it("U2: accepts a body carrying only displayName", () => {
    expect(mePatchSchema.safeParse({ displayName: "Rahul" }).success).toBe(true);
  });

  it("U2: accepts a body carrying only timeZone", () => {
    expect(mePatchSchema.safeParse({ timeZone: "Asia/Kolkata" }).success).toBe(true);
  });

  it("U2: treats an explicit false as a provided marketingOptIn field", () => {
    expect(mePatchSchema.safeParse({ marketingOptIn: false }).success).toBe(true);
  });

  it("U2: treats an explicit null as a provided avatarAssetId field (clears the avatar)", () => {
    expect(mePatchSchema.safeParse({ avatarAssetId: null }).success).toBe(true);
  });

  it("U3: trims surrounding whitespace from displayName", () => {
    const parsed = mePatchSchema.parse({ displayName: "  Rahul Menon  " });
    expect(parsed.displayName).toBe("Rahul Menon");
  });

  it.each([
    ["the minimum one-character name", "R"],
    ["exactly the 80-character maximum", "a".repeat(80)],
  ])("U3: accepts %s", (_label, value) => {
    expect(mePatchSchema.safeParse({ displayName: value }).success).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["81 characters — one past the maximum", "a".repeat(81)],
  ])("U3: rejects %s", (_label, value) => {
    expect(mePatchSchema.safeParse({ displayName: value }).success).toBe(false);
  });
});
