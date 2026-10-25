/**
 * U1 — the decision behind `scripts/git/pin-hooks-path.mjs`, the `prepare` step
 * that pins `core.hooksPath` to the tracked `.husky` directory (ADR-0310 §2).
 *
 * Root cause this pins (ADR-0311, card `t_60e20c44`): the script wraps **both**
 * git calls in a bare `catch {}`:
 *
 *   try {
 *     git(["rev-parse", "--is-inside-work-tree"]);
 *     git(["config", "core.hooksPath", ".husky"]);
 *   } catch {
 *     // No work tree to configure (e.g. an install from a source tarball).
 *   }
 *
 * The tolerance is correct for the "no work tree" case, but the bare catch
 * cannot tell it apart from a **failed pin** — a read-only `.git/config`, a
 * `.git` owned by another user (git refuses with `detected dubious ownership`),
 * or any other `git config` failure all become the same silent no-op. The commit
 * -time identity guard (ADR-0309 / ADR-0310) is then silently *absent* in every
 * worktree of that checkout — precisely the state it exists for — with no
 * diagnostic anywhere in the install output.
 *
 * Contract pinned here — the seam the GREEN must expose. The module stays a
 * runnable `prepare` step (`node scripts/git/pin-hooks-path.mjs`, wired by
 * `package.json`) and additionally exports a decision function whose I/O is
 * injected, so a spec can drive success / failure / not-a-work-tree without
 * touching the real `.git/config` and with no I/O at import:
 *
 *   module   `scripts/git/pin-hooks-path.mjs`
 *   exports  pinHooksPath(deps): number        — returns the process exit code
 *   deps     { runGit(args: readonly string[]): void;   // throws on any git failure
 *              stderr: { write(chunk: string): unknown } }  // the diagnostic sink
 *
 * Behaviour, in order:
 *
 *   1. `runGit(["rev-parse", "--is-inside-work-tree"])` throws → the process is
 *      not inside a work tree → write **nothing**, return `0`, and never attempt
 *      the `core.hooksPath` write (the tarball tolerance is preserved);
 *   2. the rev-parse succeeds and
 *      `runGit(["config", "core.hooksPath", ".husky"])` throws → write **one**
 *      diagnostic line to stderr that names `core.hooksPath` and carries the
 *      underlying git failure, then still return `0` (a failed pin must never
 *      fail `pnpm install`);
 *   3. both succeed → write nothing, return `0`.
 *
 * Importing the module must have no side effect: the runner logic (reading the
 * real git and `process.stderr`) runs only when the file is the process entry
 * point, never on import — otherwise this spec would mutate the worktree's
 * config or exit the test process.
 */
import { describe, expect, it } from "vitest";

import * as pinModule from "../../../../../scripts/git/pin-hooks-path.mjs";

const REV_PARSE_ARGS: readonly string[] = ["rev-parse", "--is-inside-work-tree"];
const CONFIG_WRITE_ARGS: readonly string[] = ["config", "core.hooksPath", ".husky"];

/** The injected I/O the seam is driven through. Mirrors the runner's real wiring. */
interface PinHooksPathDeps {
  /** Runs one git command; throws (as `execFileSync` does) on any failure. */
  readonly runGit: (args: readonly string[]) => void;
  /** The diagnostic sink the runner wires to `process.stderr`. */
  readonly stderr: { write(chunk: string): unknown };
}

interface DepsHandle {
  readonly deps: PinHooksPathDeps;
  /** Every git invocation the seam attempted, in order. */
  readonly calls: (readonly string[])[];
  /** Every chunk the seam wrote to the diagnostic sink, in order. */
  readonly lines: string[];
}

/**
 * Build the injected I/O. `failOn` decides which git invocation throws, so one
 * helper drives all three behaviours without touching a real repository.
 */
function makeDeps(options: {
  readonly failOn?: (args: readonly string[]) => Error | undefined;
}): DepsHandle {
  const calls: (readonly string[])[] = [];
  const runGit = (args: readonly string[]): void => {
    calls.push(args);
    const failure = options.failOn?.(args);
    if (failure !== undefined) {
      throw failure;
    }
  };

  const lines: string[] = [];
  const stderr = {
    write: (chunk: string): unknown => {
      lines.push(chunk);
      return true;
    },
  };

  return { deps: { runGit, stderr }, calls, lines };
}

const exported = pinModule as unknown as {
  readonly pinHooksPath?: (deps: PinHooksPathDeps) => number;
};

/**
 * Call the seam, failing with a message that names the missing export rather
 * than an opaque import error — the module exists today but exports nothing.
 */
function pinHooksPath(deps: PinHooksPathDeps): number {
  const fn = exported.pinHooksPath;
  if (typeof fn !== "function") {
    throw new Error(
      "scripts/git/pin-hooks-path.mjs must export pinHooksPath(deps): number — " +
        "the injectable seam this pin drives (see ADR-0311)."
    );
  }
  return fn(deps);
}

/** The one diagnostic line, failing loudly if the seam wrote zero or several. */
function onlyLine(lines: readonly string[]): string {
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) {
    throw new Error("expected exactly one diagnostic line on stderr");
  }
  return line;
}

describe("pinHooksPath when the process is not inside a git work tree", () => {
  const NOT_A_WORK_TREE: { label: string; message: string }[] = [
    {
      label: "the directory is not a repository at all",
      message: "fatal: not a git repository (or any of the parent directories): .git",
    },
    {
      label: "the repository is bare",
      message: "fatal: this operation must be run in a work tree",
    },
  ];

  it.each(NOT_A_WORK_TREE)(
    "stays silent, returns 0 and never attempts the core.hooksPath write when $label",
    ({ message }) => {
      const { deps, calls, lines } = makeDeps({
        failOn: (args) => (args[0] === "rev-parse" ? new Error(message) : undefined),
      });

      const exitCode = pinHooksPath(deps);

      expect(exitCode).toBe(0);
      expect(lines).toEqual([]);
      expect(calls).toEqual([REV_PARSE_ARGS]);
    }
  );
});

describe("pinHooksPath when the core.hooksPath write fails inside a work tree", () => {
  const FAILED_WRITE: { label: string; message: string }[] = [
    {
      label: "the config file cannot be locked",
      message: "error: could not lock config file .git/config: Permission denied",
    },
    {
      label: "git refuses a dubious-ownership repository",
      message: "fatal: detected dubious ownership in repository at '/repo'",
    },
    {
      label: "the config file cannot be written",
      message: "fatal: could not write config file .git/config: Read-only file system",
    },
  ];

  it.each(FAILED_WRITE)(
    "writes one stderr line naming core.hooksPath and the failure when $label",
    ({ message }) => {
      const { deps, lines } = makeDeps({
        failOn: (args) => (args[0] === "config" ? new Error(message) : undefined),
      });

      const exitCode = pinHooksPath(deps);

      const line = onlyLine(lines);
      expect(line).toContain("core.hooksPath");
      expect(line).toContain(message);
      expect(line.endsWith("\n")).toBe(true);
      expect(exitCode).toBe(0);
    }
  );

  it("reports the failure without rethrowing, so the prepare chain stays non-fatal", () => {
    const { deps, lines } = makeDeps({
      failOn: (args) =>
        args[0] === "config"
          ? new Error("error: could not lock config file .git/config")
          : undefined,
    });

    expect(() => pinHooksPath(deps)).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe("pinHooksPath when the core.hooksPath write succeeds", () => {
  it("pins core.hooksPath to .husky, after confirming the work tree, and stays silent", () => {
    const { deps, calls, lines } = makeDeps({});

    const exitCode = pinHooksPath(deps);

    expect(exitCode).toBe(0);
    expect(lines).toEqual([]);
    expect(calls).toEqual([REV_PARSE_ARGS, CONFIG_WRITE_ARGS]);
  });
});
