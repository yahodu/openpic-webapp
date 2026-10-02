import { describe, expect, it } from "vitest";

import { makeLogEntry } from "../../../test/helpers/log-assertions";
import { stdoutJsonTransport } from "../index";

/**
 * Contract under test — `stdoutJsonTransport`, the 12-factor default.
 *
 * It serializes each entry to a single JSON line and hands it to the injected
 * sink (stdout by default), so logs are a line-delimited event stream the
 * aggregator can consume.
 */

describe("stdoutJsonTransport", () => {
  it("writes one JSON line per entry to the injected sink", () => {
    const lines: string[] = [];
    const transport = stdoutJsonTransport({ write: (line) => lines.push(line) });

    void transport.write(makeLogEntry({ msg: "first" }));
    void transport.write(makeLogEntry({ msg: "second" }));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ msg: "first", level: "info" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ msg: "second" });
  });

  it("emits exactly one line per entry", () => {
    const lines: string[] = [];
    const transport = stdoutJsonTransport({ write: (line) => lines.push(line) });

    void transport.write(makeLogEntry({ msg: "single" }));

    expect(
      lines
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
    ).toHaveLength(1);
  });
});
