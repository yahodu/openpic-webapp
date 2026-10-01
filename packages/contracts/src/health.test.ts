import { describe, expect, it } from "vitest";

import { HealthResponseSchema, buildHealthResponse } from "@openpic/contracts";

/**
 * U2 — proves the `@openpic/contracts` workspace package is wired up: the
 * schemas it exports are importable by consumers and reject invalid input.
 *
 * The response contract is the tracer-bullet liveness body, so a drifting
 * health payload fails here before it ever reaches a route.
 */
describe("HealthResponseSchema", () => {
  it("accepts a valid liveness payload", () => {
    expect(HealthResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
  });

  it('rejects a payload whose status is not "ok"', () => {
    expect(HealthResponseSchema.safeParse({ status: "down" }).success).toBe(false);
  });

  it("rejects a payload that is missing the status field", () => {
    expect(HealthResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a payload with a wrong-typed status field", () => {
    expect(HealthResponseSchema.safeParse({ status: 200 }).success).toBe(false);
  });
});

describe("buildHealthResponse", () => {
  it("produces a payload that satisfies its own schema", () => {
    expect(HealthResponseSchema.safeParse(buildHealthResponse()).success).toBe(true);
  });

  it("defaults to the liveness payload", () => {
    expect(buildHealthResponse()).toEqual({ status: "ok" });
  });
});
