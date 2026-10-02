import { describe, expect, it } from "vitest";

import { findForbiddenFields } from "@openpic/contracts";

/**
 * U5 / U6 / U7 — the never-return scanner (CONVENTIONS §8.1, contract §0.15).
 *
 * A response projection must never carry credential material, upstream payloads
 * or internal identifiers. The scanner is the reusable control every endpoint
 * story runs over its response body, so it has to descend through arrays of
 * objects (a collection page is where leaks actually happen) and it has to know
 * the audience: an attendee must not receive a face-match `similarity`, while an
 * admin legitimately receives a `rawPayload`.
 *
 * Returned paths are dot-separated with numeric array indices, matching the
 * `FieldError.path` convention (`items.0.hash`), so a failure names exactly
 * where the leak is.
 */

const R2_ENDPOINT = "https://account-id.r2.cloudflarestorage.com/openpic/raw/photo.jpg";

describe("findForbiddenFields", () => {
  it("U5: finds a forbidden key nested in an array of objects", () => {
    const body = { items: [{ id: "a" }, { embedding: [0.1, 0.2] }] };

    expect(findForbiddenFields(body, "default")).toEqual(["items.1.embedding"]);
  });

  it("U5: finds a forbidden key inside an array nested in an object", () => {
    const body = { data: { cards: [{ queryVector: [1, 2] }] } };

    expect(findForbiddenFields(body, "default")).toEqual(["data.cards.0.queryVector"]);
  });

  it("U6: the attendee profile flags similarity", () => {
    expect(findForbiddenFields({ similarity: 0.98, id: "a" }, "attendee")).toEqual(["similarity"]);
  });

  it("U6: the default profile does not flag similarity", () => {
    expect(findForbiddenFields({ similarity: 0.98, id: "a" }, "default")).toEqual([]);
  });

  it("U6: the admin profile allows rawPayload", () => {
    expect(findForbiddenFields({ rawPayload: { any: true } }, "admin")).toEqual([]);
  });

  it("U6: the default profile flags rawPayload", () => {
    expect(findForbiddenFields({ rawPayload: { any: true } }, "default")).toEqual(["rawPayload"]);
  });

  it("flags sessionToken for the default profile", () => {
    expect(findForbiddenFields({ sessionToken: "opaque" }, "default")).toEqual(["sessionToken"]);
  });

  it("allows sessionToken for the issuance profile", () => {
    expect(findForbiddenFields({ sessionToken: "opaque" }, "issuance")).toEqual([]);
  });

  it("still flags sessionToken for the admin profile", () => {
    expect(findForbiddenFields({ sessionToken: "opaque" }, "admin")).toEqual(["sessionToken"]);
  });

  it.each(["default", "attendee", "admin", "issuance"] as const)(
    "U7: flags _id for the %s profile",
    (profile) => {
      expect(findForbiddenFields({ _id: "507f1f77bcf86cd799439011" }, profile)).toEqual(["_id"]);
    }
  );

  it("flags the other always-forbidden keys wherever they appear", () => {
    const body = {
      data: { bucket: "openpic", nested: { externalRefs: ["ref"] } },
      providerCode: "P1",
    };

    expect(findForbiddenFields(body, "default")).toEqual([
      "data.bucket",
      "data.nested.externalRefs",
      "providerCode",
    ]);
  });

  it("flags an R2 endpoint hostname anywhere in a string value", () => {
    expect(findForbiddenFields({ url: R2_ENDPOINT }, "default")).toEqual(["url"]);
  });

  it("does not flag a value that is not an R2 endpoint", () => {
    expect(
      findForbiddenFields({ url: "https://cdn.openpic.example/openpic/photo.jpg" }, "default")
    ).toEqual([]);
  });

  it("returns an empty array for a clean body", () => {
    const body = {
      id: "a",
      items: [{ id: "b", name: "sunset" }],
      hasMore: false,
      nextCursor: null,
    };

    expect(findForbiddenFields(body, "default")).toEqual([]);
  });
});
