import { describe, expect, it } from "vitest";

import { AppError } from "@/server/http/app-error";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  parsePageQuery,
  type Cursor,
} from "@/server/http/cursor";

/**
 * U1–U4 — the cursor codec, the `?cursor=&limit=` parser and the page envelope
 * (API contract §0.8).
 *
 * The cursor is `base64url(JSON.stringify({ c, i }))`: a compound `(sortValue,
 * id)` key that never ties, opaque to clients. A malformed or foreign cursor is
 * a `400 invalid_cursor`; `limit` is bounded `1..100` with a per-endpoint
 * default (40; 20 for the notification feed); `hasMore`/`nextCursor` are
 * refined together so a client can never be handed a cursor it cannot follow or
 * a terminal page that still offers one.
 */

/** Run `fn` and return whatever it throws (`undefined` when it does not throw). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

function expectInvalidCursor(raw: string): void {
  const error = caught(() => decodeCursor(raw));
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: "invalid_cursor", status: 400 });
}

function expectInvalidLimit(limit: string): void {
  const error = caught(() => parsePageQuery(new URLSearchParams({ limit })));
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ code: "validation_failed", status: 422 });
}

describe("cursor encoding", () => {
  const sample: Cursor = {
    c: "2026-09-24T18:30:00.000Z",
    i: "6702f1a3b4c5d6e7f8a9b0c1",
  };

  it("U1: encode then decode round-trips the compound cursor unchanged", () => {
    const encoded = encodeCursor(sample);

    expect(decodeCursor(encoded)).toEqual(sample);
  });

  it("U1: the wire cursor is URL-safe base64url (no '+', '/' or '=' padding)", () => {
    const encoded = encodeCursor(sample);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    expect(encoded).not.toMatch(/[+/]/);
  });

  it("U1: the wire cursor decodes to the JSON { c, i } payload", () => {
    const encoded = encodeCursor(sample);

    const json = Buffer.from(encoded, "base64url").toString("utf8");
    expect(JSON.parse(json)).toEqual(sample);
  });
});

describe("decodeCursor — malformed and foreign cursors", () => {
  it.each([
    ["an empty string", ""],
    ["plain non-base64 text", "not a cursor!!!"],
    ["base64 that is not JSON", Buffer.from("hello").toString("base64url")],
  ])("U2: %s is rejected as 400 invalid_cursor", (_label, raw) => {
    expectInvalidCursor(raw);
  });

  it.each([
    ["a JSON object with a foreign shape", { userId: "u1", createdAt: "2026-09-24T18:30:00.000Z" }],
    ["a missing sort value", { i: "6702f1a3b4c5d6e7f8a9b0c1" }],
    ["a missing id", { c: "2026-09-24T18:30:00.000Z" }],
    ["a non-string sort value", { c: 42, i: "6702f1a3b4c5d6e7f8a9b0c1" }],
    ["a non-string id", { c: "2026-09-24T18:30:00.000Z", i: 7 }],
    ["an empty sort value", { c: "", i: "6702f1a3b4c5d6e7f8a9b0c1" }],
    ["an empty id", { c: "2026-09-24T18:30:00.000Z", i: "" }],
    ["a JSON array", ["2026-09-24T18:30:00.000Z", "6702f1a3b4c5d6e7f8a9b0c1"]],
  ])("U2: %s is rejected as 400 invalid_cursor", (_label, value) => {
    expectInvalidCursor(Buffer.from(JSON.stringify(value)).toString("base64url"));
  });
});

describe("parsePageQuery — limit bounds and defaults", () => {
  it.each([
    ["the documented default", "", 40],
    ["an in-range value", "40", 40],
    ["the lower bound", "1", 1],
    ["the upper bound", "100", 100],
  ])("U3: %s yields limit %i", (_label, limit, expected) => {
    const params = new URLSearchParams(limit === "" ? {} : { limit });

    expect(parsePageQuery(params).limit).toBe(expected);
  });

  it("U3: a limit above the maximum is clamped to 100", () => {
    expect(parsePageQuery(new URLSearchParams({ limit: "101" })).limit).toBe(100);
    expect(parsePageQuery(new URLSearchParams({ limit: "5000" })).limit).toBe(100);
  });

  it("U3: the clamp ceiling is configurable per endpoint", () => {
    expect(parsePageQuery(new URLSearchParams({ limit: "90" }), { maxLimit: 50 }).limit).toBe(50);
  });

  it("U3: the default limit is configurable per endpoint", () => {
    expect(parsePageQuery(new URLSearchParams(), { defaultLimit: 20 }).limit).toBe(20);
  });

  it.each([
    ["zero", "0"],
    ["a negative value", "-1"],
    ["a non-integer", "1.5"],
    ["non-numeric text", "abc"],
    ["a numeric prefix with trailing text", "10abc"],
    ["a blank value", " "],
  ])("U3: limit %s is rejected as 422 validation_failed", (_label, limit) => {
    expectInvalidLimit(limit);
  });
});

describe("parsePageQuery — cursor", () => {
  it("U4: an absent cursor is null (first page)", () => {
    expect(parsePageQuery(new URLSearchParams()).cursor).toBeNull();
    expect(parsePageQuery(new URLSearchParams({ limit: "40" })).cursor).toBeNull();
  });

  it("U4: a valid cursor decodes into the parsed query", () => {
    const cursor: Cursor = { c: "2026-09-24T18:30:00.000Z", i: "6702f1a3b4c5d6e7f8a9b0c1" };

    const parsed = parsePageQuery(new URLSearchParams({ cursor: encodeCursor(cursor) }));

    expect(parsed.cursor).toEqual(cursor);
  });

  it("U2: a garbage cursor in the query string surfaces as 400 invalid_cursor", () => {
    const error = caught(() => parsePageQuery(new URLSearchParams({ cursor: "!not-base64!" })));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "invalid_cursor", status: 400 });
  });
});

describe("buildCursorPage — hasMore / nextCursor semantics", () => {
  interface Row {
    readonly c: string;
    readonly i: string;
  }

  const keyOf = (row: Row): Cursor => ({ c: row.c, i: row.i });

  const rows: Row[] = Array.from({ length: 41 }, (_, index) => ({
    c: `c-${index.toString().padStart(2, "0")}`,
    i: index.toString(16).padStart(24, "0"),
  }));

  it("U4: a full page with an extra row reports hasMore and a cursor for the last returned row", () => {
    const page = buildCursorPage(rows, 40, keyOf);

    const lastReturned = rows[39];
    if (lastReturned === undefined) {
      throw new Error("expected 41 fixture rows");
    }
    expect(page.items).toEqual(rows.slice(0, 40));
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(encodeCursor(keyOf(lastReturned)));

    const { nextCursor } = page;
    if (nextCursor === null) {
      throw new Error("expected a next cursor on a full page");
    }
    expect(decodeCursor(nextCursor)).toEqual(keyOf(lastReturned));
  });

  it("U4: exactly `limit` rows is terminal — hasMore false and nextCursor null", () => {
    const page = buildCursorPage(rows.slice(0, 40), 40, keyOf);

    expect(page.items).toHaveLength(40);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("U4: a short page is terminal", () => {
    const page = buildCursorPage(rows.slice(0, 39), 40, keyOf);

    expect(page.items).toHaveLength(39);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("U4: an empty result is terminal with no cursor", () => {
    const page = buildCursorPage([], 40, keyOf);

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
