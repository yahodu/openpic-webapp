import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { toDto } from "@/server/repos";

/**
 * Unit contract — DTO projection (OP-77, conventions §8.1 never-return).
 *
 * `toDto(doc)` is the single boundary that turns a stored document into a
 * client-facing shape: it renames `_id` to a string `id` and removes the
 * internal `_id` key so it can never be serialised. A document is either mapped
 * or (when null) passed through as null.
 *
 *   toDto<T>(doc: WithId<T> | null): (T & { id: string }) | null
 *
 * Cases: U6 the `_id` rename and non-emission; the null passthrough.
 */
describe("toDto", () => {
  it("U6: never emits _id and maps it to a string id", () => {
    const id = new ObjectId();

    const dto = toDto({ _id: id, name: "Rahul Studio", status: "active" });

    expect(dto).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(dto, "_id")).toBe(false);
    expect(dto?.id).toBe(id.toHexString());
    expect(dto?.name).toBe("Rahul Studio");
    expect(dto?.status).toBe("active");
  });

  it("U6: returns null for a null document", () => {
    expect(toDto(null)).toBeNull();
  });
});
