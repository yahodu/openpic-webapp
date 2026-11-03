import { describe, expect, it } from "vitest";

import { memoryObjectStorage } from "@/server/adapters/memory-object-storage";
import { AppError } from "@/server/http/app-error";

import { STORAGE_PORT_METHODS } from "../factories/storage";

/**
 * U4 — the in-memory storage adapter and the port's range read (OP-112).
 *
 * The `memory` adapter is the implementation an e2e boot selects, so it is the
 * one place the port's byte-level contract can be pinned without a network: what
 * was written is what comes back, a range read returns exactly the requested
 * bytes, and a read of something the location does not hold is the same
 * `not_found` refusal the R2 adapter answers for a `HeadObject` 404.
 *
 * `getObjectRange` mirrors the HTTP `Range: bytes=<start>-<end>` header S3
 * documents, so **both** ends are inclusive: `{ start: 2, end: 5 }` over the
 * bytes `0123456789` is `2345` — four bytes, not three.
 */
const encoder = new TextEncoder();

/** The object every byte-level case stores. */
const OBJECT_KEY = "images/3f2c1d8899aa55bb66cc77dd88ee99ff00112233445566778899aabbccddeeff.jpg";

/** Ten readable bytes, so a range's inclusive ends are unmistakable in a failure. */
const OBJECT_BYTES = encoder.encode("0123456789");

/**
 * Run an attempt that is expected to refuse and return whatever it threw.
 *
 * Both a rejected promise and a synchronous throw are the same refusal to a
 * caller, so the spec must not depend on which one an adapter chose.
 *
 * @param attempt - The call under test.
 * @returns The thrown/rejected value, or `undefined` when the call succeeded.
 */
async function refusalOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("memory object storage", () => {
  it("U4: the adapter exposes exactly the ObjectStorage port surface", () => {
    // A later lane (multipart signing, aborts, deletes) depends on the port
    // being complete, and §6.6 ("swapping provider must not touch domain code")
    // means a method only the vendor path provides is a provider leak. The
    // adapter carries every port method as an own key, even one no spec drives
    // yet — the `memory` adapter is what an e2e boot selects.
    expect(Object.keys(memoryObjectStorage()).sort()).toEqual([...STORAGE_PORT_METHODS].sort());
  });

  it("U4: a stored object reads back byte-for-byte", async () => {
    // Arrange
    const storage = memoryObjectStorage();
    await storage.putObject("originals", OBJECT_KEY, OBJECT_BYTES, "image/jpeg");

    // Act
    const read = await storage.getObject("originals", OBJECT_KEY);

    // Assert
    expect(read).toEqual(OBJECT_BYTES);
  });

  it("U4: a range read returns exactly the requested inclusive bytes", async () => {
    // Arrange
    const storage = memoryObjectStorage();
    await storage.putObject("originals", OBJECT_KEY, OBJECT_BYTES, "image/jpeg");

    // Act
    const slice = await storage.getObjectRange("originals", OBJECT_KEY, { start: 2, end: 5 });

    // Assert — "2345", four bytes: `end` is inclusive.
    expect(slice).toEqual(encoder.encode("2345"));
  });

  it("U4: a one-byte range returns the single byte at each end of the object", async () => {
    // Arrange
    const storage = memoryObjectStorage();
    await storage.putObject("originals", OBJECT_KEY, OBJECT_BYTES, "image/jpeg");

    // Act
    const first = await storage.getObjectRange("originals", OBJECT_KEY, { start: 0, end: 0 });
    const last = await storage.getObjectRange("originals", OBJECT_KEY, { start: 9, end: 9 });

    // Assert
    expect(first).toEqual(encoder.encode("0"));
    expect(last).toEqual(encoder.encode("9"));
  });

  it("U4: a read of an object the location does not hold is a not_found refusal", async () => {
    // Arrange
    const storage = memoryObjectStorage();

    // Act
    const read = await refusalOf(() => storage.getObject("originals", OBJECT_KEY));
    const ranged = await refusalOf(() =>
      storage.getObjectRange("originals", OBJECT_KEY, { start: 0, end: 3 })
    );

    // Assert
    expect(read).toBeInstanceOf(AppError);
    expect(read).toMatchObject({ code: "not_found" });
    expect(ranged).toMatchObject({ code: "not_found" });
  });

  it("U4: the same object key in another location is a different object", async () => {
    // Arrange
    const storage = memoryObjectStorage();
    await storage.putObject("originals", OBJECT_KEY, OBJECT_BYTES, "image/jpeg");

    // Act / Assert — `originals` and `thumbnails` are separate object spaces.
    expect(await refusalOf(() => storage.getObject("thumbnails", OBJECT_KEY))).toBeInstanceOf(
      AppError
    );
  });

  it("U4: each adapter instance is an isolated store", async () => {
    // Arrange
    const first = memoryObjectStorage();
    const second = memoryObjectStorage();
    await first.putObject("originals", OBJECT_KEY, OBJECT_BYTES, "image/jpeg");

    // Act / Assert
    expect(await refusalOf(() => second.getObject("originals", OBJECT_KEY))).toBeInstanceOf(
      AppError
    );
  });
});
