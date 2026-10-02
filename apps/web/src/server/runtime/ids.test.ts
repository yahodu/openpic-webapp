import { describe, expect, it } from "vitest";

import { idGenerator, type IdGenerator } from "./ids";

/**
 * Contract under test — the `IdGenerator` port (OP-72, epic Runtime Primitives).
 *
 * `src/server/runtime/ids.ts` must expose an injectable `IdGenerator`
 * implementation as `idGenerator` with three generators:
 *
 *   - `objectIdHex()` — 24-character lowercase hex (Mongo ObjectId shape).
 *   - `uuidV4()` — a RFC 4122 version 4 UUID.
 *   - `ulid()` — a 26-character Crockford base32 ULID (no I, L, O, U).
 */

const OBJECT_ID = /^[0-9a-f]{24}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("idGenerator", () => {
  it("satisfies the IdGenerator port shape", () => {
    const port: IdGenerator = idGenerator;

    expect(typeof port.objectIdHex).toBe("function");
    expect(typeof port.uuidV4).toBe("function");
    expect(typeof port.ulid).toBe("function");
  });

  it("mints a 24-character lowercase hex ObjectId", () => {
    expect(idGenerator.objectIdHex()).toMatch(OBJECT_ID);
  });

  it("mints a RFC 4122 version-4 UUID", () => {
    expect(idGenerator.uuidV4()).toMatch(UUID_V4);
  });

  it("mints a 26-character Crockford base32 ULID", () => {
    expect(idGenerator.ulid()).toMatch(ULID);
  });

  it("produces distinct values across calls", () => {
    expect(idGenerator.objectIdHex()).not.toBe(idGenerator.objectIdHex());
    expect(idGenerator.uuidV4()).not.toBe(idGenerator.uuidV4());
    expect(idGenerator.ulid()).not.toBe(idGenerator.ulid());
  });
});
