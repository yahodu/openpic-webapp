import { describe, expect, it } from "vitest";

import {
  REQUEST_ID_HEADER,
  getRequestContext,
  newRequestId,
  resolveRequestId,
  runWithRequestContext,
  type RequestContext,
} from "./request-context";

/**
 * Contract under test — request context and request-id handling (OP-72,
 * epic Runtime Primitives).
 *
 * `src/server/runtime/request-context.ts` must expose:
 *
 *   - `REQUEST_ID_HEADER` — the inbound/outbound header name, `x-request-id`.
 *   - `resolveRequestId(inbound)` — returns `inbound` unchanged when it matches
 *     `^[A-Za-z0-9_-]{8,64}$`; otherwise mints a fresh `req_` + ULID.
 *   - `newRequestId()` — mints `req_` + a 26-character Crockford base32 ULID.
 *   - `runWithRequestContext(context, fn)` / `getRequestContext()` — an
 *     `AsyncLocalStorage`-backed request scope. The context is visible for the
 *     whole async tree of `fn` and never leaks across concurrent operations.
 *   - `RequestContext` — `{ requestId, route, startedAt, principal?, tenantId? }`.
 */

/** Canonical generated shape: `req_` + 26-char Crockford base32 ULID (no I, L, O, U). */
const GENERATED_REQUEST_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

function contextFor(requestId: string): RequestContext {
  return { requestId, route: "/test", startedAt: new Date(0) };
}

describe("request id handling", () => {
  it("exposes the canonical inbound/outbound header name", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("U1: echoes a valid inbound id unchanged", () => {
    expect(resolveRequestId("0123456789abcdef")).toBe("0123456789abcdef");
  });

  it.each([
    ["lowercase alphanumerics", "abcdef12"],
    ["mixed case alphanumerics", "AbCdEf12"],
    ["underscores and hyphens", "abc_def-12"],
    ["the lower length boundary (8)", "a".repeat(8)],
    ["the upper length boundary (64)", "a".repeat(64)],
  ])("U1: accepts %s and echoes it", (_label, value) => {
    expect(resolveRequestId(value)).toBe(value);
  });

  it.each([
    ["one character below the minimum (7)", "a".repeat(7)],
    ["one character above the maximum (65)", "a".repeat(65)],
    ["an embedded space", "abc def1"],
    ["an embedded slash", "abc/def1"],
    ["an embedded dot", "abc.def1"],
    ["an embedded newline", "abc\ndef1"],
    ["the empty string", ""],
  ])("U2: replaces %s with a generated req_ id", (_label, value) => {
    const resolved = resolveRequestId(value);

    expect(resolved).not.toBe(value);
    expect(resolved).toMatch(GENERATED_REQUEST_ID);
  });

  it("U2: replaces a missing inbound id (undefined/null) with a generated req_ id", () => {
    expect(resolveRequestId(undefined)).toMatch(GENERATED_REQUEST_ID);
    expect(resolveRequestId(null)).toMatch(GENERATED_REQUEST_ID);
  });

  it("U2: newRequestId mints a distinct req_ + ULID on every call", () => {
    const first = newRequestId();
    const second = newRequestId();

    expect(first).toMatch(GENERATED_REQUEST_ID);
    expect(second).toMatch(GENERATED_REQUEST_ID);
    expect(first).not.toBe(second);
  });
});

describe("request context (AsyncLocalStorage)", () => {
  it("makes the context visible inside runWithRequestContext and undefined outside", () => {
    expect(getRequestContext()).toBeUndefined();

    const seen = runWithRequestContext(contextFor("req_inside"), () => getRequestContext());

    expect(seen?.requestId).toBe("req_inside");
    expect(seen?.route).toBe("/test");
    expect(seen?.startedAt).toEqual(new Date(0));
    expect(getRequestContext()).toBeUndefined();
  });

  it("returns the callback's value from runWithRequestContext", () => {
    const result = runWithRequestContext(contextFor("req_value"), () => 42);

    expect(result).toBe(42);
  });

  it("U3: does not leak contexts across 50 concurrent async operations", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `req_${String(index).padStart(3, "0")}`);

    const observed: Array<readonly [string | undefined, string | undefined]> = await Promise.all(
      ids.map((requestId, index) =>
        runWithRequestContext(contextFor(requestId), async () => {
          // Interleave the 50 runs with different waits so their async trees
          // overlap; a leaking store would surface another run's id here.
          await new Promise((resolve) => setTimeout(resolve, index % 5));
          const before = getRequestContext()?.requestId;
          await new Promise((resolve) => setTimeout(resolve, (index * 7) % 5));
          return [before, getRequestContext()?.requestId] as const;
        })
      )
    );

    expect(observed).toEqual(ids.map((id) => [id, id]));
  });

  it("U3: a nested run shadows the outer context and restores it on exit", () => {
    runWithRequestContext(contextFor("req_outer"), () => {
      expect(getRequestContext()?.requestId).toBe("req_outer");

      runWithRequestContext(contextFor("req_inner"), () => {
        expect(getRequestContext()?.requestId).toBe("req_inner");
      });

      expect(getRequestContext()?.requestId).toBe("req_outer");
    });
  });
});
