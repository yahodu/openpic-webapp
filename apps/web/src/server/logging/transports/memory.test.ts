import { describe, expect, it } from "vitest";

import { makeLogEntry } from "../../../test/helpers/log-assertions";
import { memoryTransport } from "../index";

/**
 * Contract under test — `memoryTransport`, the in-memory test double.
 *
 * It records every entry it receives so tests can assert on what the logger
 * produced, and exposes `clear()` so state does not leak between tests.
 */

describe("memoryTransport", () => {
  it("captures every entry it receives in order", () => {
    const transport = memoryTransport();

    void transport.write(makeLogEntry({ msg: "one" }));
    void transport.write(makeLogEntry({ msg: "two" }));

    expect(transport.entries.map((entry) => entry.msg)).toEqual(["one", "two"]);
  });

  it("clears captured entries", () => {
    const transport = memoryTransport();
    void transport.write(makeLogEntry({ msg: "one" }));

    transport.clear();

    expect(transport.entries).toEqual([]);
  });
});
