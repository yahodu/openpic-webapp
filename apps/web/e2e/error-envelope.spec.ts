import { expect, test } from "@playwright/test";

/**
 * E1 — the error envelope over a real HTTP server.
 *
 * Complements the unit and integration specs by proving the envelope survives
 * routing, header handling and JSON serialization end to end. `POST /api/v1/echo`
 * is the tracer-bullet route for the pipeline (the first route built with
 * `defineRoute`).
 */
test.describe("POST /api/v1/echo — error envelope", () => {
  test("E1: an invalid body returns the 422 validation_failed envelope", async ({ request }) => {
    const response = await request.post("/api/v1/echo", {
      headers: { "content-type": "application/json" },
      data: { message: "" },
    });

    expect(response.status()).toBe(422);
    expect(response.headers()["content-type"]).toContain("application/json");
    expect(response.headers()["cache-control"]).toBe("no-store");

    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "validation_failed",
        retryable: false,
      },
    });
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error.requestId.length).toBeGreaterThan(0);
    expect(Array.isArray(body.error.details.fields)).toBe(true);
    expect(body.error.details.fields.length).toBeGreaterThan(0);
    expect(body.error.details.fields[0]).toEqual({
      path: expect.any(String),
      code: expect.any(String),
      message: expect.any(String),
    });
  });
});
