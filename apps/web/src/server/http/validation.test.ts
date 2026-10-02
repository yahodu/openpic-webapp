import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fieldErrorSchema } from "@openpic/contracts";

import { toFieldErrors } from "@/server/http/validation";

/**
 * U3 — Zod issues become API field errors.
 *
 * Clients address a field by a dot path, so a nested array index must render as
 * `items.0.hash` (not a JSON pointer, not a bracket). The `code` is the raw Zod
 * issue code and `message` is the human text; both must survive the mapping so
 * a client can localise the message without parsing it.
 */
describe("toFieldErrors", () => {
  it("U3: maps nested array indices to dot paths (items.0.hash)", () => {
    const schema = z.object({
      items: z.array(z.object({ hash: z.string() })),
    });
    const result = schema.safeParse({ items: [{ hash: 123 }] });
    if (result.success) {
      throw new Error("expected the schema to reject the payload");
    }

    const fields = toFieldErrors(result.error);

    expect(fields).toEqual([
      {
        path: "items.0.hash",
        code: "invalid_type",
        message: expect.any(String),
      },
    ]);
    for (const field of fields) {
      expect(fieldErrorSchema.safeParse(field).success).toBe(true);
    }
  });

  it("U3: maps deep object paths", () => {
    const schema = z.object({
      profile: z.object({ address: z.object({ zip: z.string() }) }),
    });
    const result = schema.safeParse({ profile: { address: { zip: 42 } } });
    if (result.success) {
      throw new Error("expected the schema to reject the payload");
    }

    expect(toFieldErrors(result.error).map((field) => field.path)).toEqual(["profile.address.zip"]);
  });

  it("U3: preserves the raw Zod issue code and message", () => {
    const schema = z.object({ name: z.string().min(3) });
    const result = schema.safeParse({ name: "x" });
    if (result.success) {
      throw new Error("expected the schema to reject the payload");
    }

    const issue = result.error.issues[0];
    const field = toFieldErrors(result.error)[0];

    expect(field?.code).toBe(issue?.code);
    expect(field?.message).toBe(issue?.message);
  });

  it("U3: a root-level issue maps to an empty path", () => {
    const result = z.string().safeParse(42);
    if (result.success) {
      throw new Error("expected the schema to reject the payload");
    }

    expect(toFieldErrors(result.error)[0]?.path).toBe("");
  });
});
