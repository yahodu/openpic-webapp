/**
 * Characterization pin — the repo pre-commit hook, `.husky/pre-commit`.
 *
 * **Why this exists.** Since OP-135 the hook is a behavioural contract with a real
 * enforcement role: it refuses a corrupted repo-local git identity
 * (`scripts/git/check-identity.ts`, ADR-0309 / ADR-0310) and then runs `lint-staged`
 * over the staged set. Neither half had a test, so a future edit could silently
 * reintroduce the package-manager wrapper, or move the identity guard below the
 * `lint-staged` step, and every gate would stay green. `.husky/pre-commit` is
 * ignored by ESLint (`eslint.config.mjs` ignores `**\/.husky/**`) and has no
 * prettier parser, so this spec is the only gate the file has.
 *
 * **Why the wrapper is pinned, not just the step.** `pnpm lint-staged` makes pnpm's
 * pre-run deps-status check run; when `node_modules` is a symlink to another
 * worktree — the dispatcher's shape — pnpm re-creates the modules dir, which aborts
 * with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when there is no TTY. The
 * commit then dies and every agent has to pass `--no-verify`, which skips
 * `lint-staged` entirely. The hook therefore invokes the local binary directly.
 *
 * **Seven invariants** — six cheap assertions with no subprocess (five on the hook's
 * executable lines, one on the file's working-tree mode), plus one syntax pass, which
 * is the spec's only subprocess (F1, added after review):
 *   1. no `pnpm` / `npx` / `yarn` / `npm` / `bun` wrapper runs `lint-staged`;
 *   2. the step is exactly `node_modules/.bin/lint-staged`;
 *   3. the step stays behind an executable test of that same path, so a worktree
 *      that never installed skips it instead of installing mid-commit;
 *   4. the identity guard is **first** — nothing else executes before it — and
 *      **unconditional** — top level, never inside the `if`;
 *   5. errexit is enabled at top level before both commands and never disabled;
 *   6. the file parses as the shell it declares;
 *   7. it is executable in the working tree, so git runs it at all.
 *
 * **The guard is pinned by meaning, not by spelling (F2).** `if [ -x <path> ];
 * then`, the shellcheck-recommended `if [ -x "<path>" ]; then` and the POSIX
 * `if test -x <path>; then` run the same test, so the pin normalizes the
 * condition before comparing it (`normalizeStepCondition`). What stays pinned is
 * the meaning: the path is exactly `node_modules/.bin/lint-staged`, the test is
 * `-x`, the block body invokes that same path, and the guard appears once.
 *
 * **Why a syntax pass is not optional (F1).** Every invariant above is
 * line-oriented, so a parse error that leaves the pinned lines intact — an
 * unclosed `if`, a stray `else` after the final `fi` — reddens nothing. It lands
 * on `main` and then fails **every** commit in the repo: git refuses the hook
 * before `set -e` or the identity guard ever run. One `sh -n` case closes that.
 *
 * **Why the executable bit is pinned as well (F3).** Git does not run a hook that is
 * not executable — the commit still succeeds, so every other gate stays green — and it
 * prints only an advisory hint (`advice.ignoredHook`, on by default). A committed mode
 * flip from `100755` to `100644` therefore turns off both the identity guard and
 * `lint-staged` repo-wide while the line pin and `sh -n` both stay green. The case reads
 * the mode of the **working tree**, not of the index: git executes the mode on disk, and
 * a checkout without `core.filemode` (Windows) can flip it locally.
 *
 * **Characterization, not RED.** The hook already has this shape on the trunk, so
 * every case below is green on its first run. The pin stays load-bearing because
 * the parsing helpers (`parseHook`, `guardedStep`, `normalizeStepCondition`,
 * `wrapperInvocations`, `isErrexitOn`, `isErrexitOff`) are also exercised against
 * synthetic hook sources in the last `describe` block: a parser that silently
 * loses a line, or a predicate weakened to always say "clean", reddens there too.
 *
 * **Only executable lines are pinned.** Comment prose may be rewritten freely
 * (today's hook *quotes* `pnpm lint-staged` while arguing against it), and no line
 * number is ever hard-coded — the assertions compare the content of executable
 * lines and their relative order.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Path for assertion messages. */
const HOOK_PATH = ".husky/pre-commit";

/** The identity guard's command, byte-exact (ADR-0309 / ADR-0310). */
const IDENTITY_GUARD = "node --experimental-strip-types scripts/git/check-identity.ts";

/**
 * The executable-dep guard in the hook's canonical spelling: a worktree without
 * dependencies skips the step (ADR-0310). Only the synthetic fixtures and the
 * assertion messages use this literal — every comparison against the real hook
 * goes through `isStepCondition`, so a behaviour-equivalent spelling is not a
 * regression.
 */
const STEP_CONDITION = "if [ -x node_modules/.bin/lint-staged ]; then";

/** The step itself: the local binary, never a package-manager wrapper. */
const STEP_INVOCATION = "node_modules/.bin/lint-staged";

/**
 * What every accepted guard spelling normalizes to: an `-x` test of exactly
 * `STEP_INVOCATION`. A guard on any other path — `…/prettier`, a wrapper — or
 * with any other predicate normalizes to a different string and still fails.
 */
const STEP_CONDITION_MEANING = `[ -x ${STEP_INVOCATION} ]`;

/**
 * Fail-closed mode, however it is spelled: `set -e`, `set -eu`, `set -euo pipefail`,
 * `set -o errexit`. The hook uses `set -e` today; the pin is on the effect.
 */
const ERREXIT_ON = /^set\s+(?:-[a-z]*e[a-z]*|-[a-z]*o\s+errexit)(?:\s|$)/u;

/** The inverse — `set +e` / `set +o errexit` would swallow a failing step. */
const ERREXIT_OFF = /^set\s+\+(?:[a-z]*e[a-z]*|o\s+errexit)(?:\s|$)/u;

/**
 * A `pnpm` / `npx` / `yarn` / `npm` / `bunx` / `bun` invocation of `lint-staged`,
 * whatever the flags or the binary's path. A comment is never scanned (comments are
 * stripped by `parseHook`), so today's prose that *quotes* the rejected form cannot
 * match.
 */
const PACKAGE_MANAGER_WRAPPER =
  /(?:^|[\s/])(?:pnpm|pnpx|npx|npm|yarn|bunx|bun)\s[^;&|]*\blint-staged\b/u;

interface HookLine {
  /** 1-based line number in `.husky/pre-commit`. */
  readonly number: number;
  /** The executable text, trimmed; an inline comment is stripped. */
  readonly command: string;
  /** The whitespace that preceded the command; empty when it is flush left. */
  readonly indent: string;
}

interface HookFinding {
  /** 1-based line number of the offending line. */
  readonly line: number;
  /** The offending executable text. */
  readonly command: string;
}

/** Cuts a shell comment: a `#` at the start of the line or after whitespace. */
function stripComment(raw: string): string {
  const match = /(?:^|\s)#/u.exec(raw);
  if (match === null) {
    return raw;
  }
  return raw.slice(0, match.index);
}

/** The executable lines of a shell source, in file order (comment lines dropped). */
function parseHook(source: string): HookLine[] {
  return source.split("\n").flatMap((raw, index) => {
    const code = stripComment(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    const command = code.trim();
    if (command.length === 0) {
      return [];
    }
    const indent = /^[ \t]*/u.exec(code)?.[0] ?? "";
    return [{ number: index + 1, command, indent }];
  });
}

/** The one executable line whose command is exactly `command`; throws a named error when absent. */
function requireLine(lines: readonly HookLine[], command: string): HookLine {
  const found = lines.find((line) => line.command === command);
  if (found === undefined) {
    throw new Error(`${HOOK_PATH} has no executable line \`${command}\`.`);
  }
  return found;
}

/** The first line that switches errexit on; throws a named error when the hook never does. */
function requireErrexit(lines: readonly HookLine[]): HookLine {
  const found = lines.find((line) => ERREXIT_ON.test(line.command));
  if (found === undefined) {
    throw new Error(`${HOOK_PATH} never enables errexit (\`set -e\`).`);
  }
  return found;
}

/** Drops one matched pair of quotes around a shell word; anything else is unchanged. */
function unquote(word: string): string {
  const quoted = /^(["'])(.*)\1$/u.exec(word);
  return quoted?.[2] ?? word;
}

/**
 * The *meaning* of an `if` condition, so the pin is not coupled to one spelling
 * of it (F2). Three edits are behaviour-preserving and must not redden:
 *
 *   - quotes around the path — exactly what a shellcheck pass recommends, and
 *     without them a path containing a space would word-split;
 *   - the POSIX `test -x <path>` spelling of `[ -x <path> ]`;
 *   - any amount of whitespace, including none before `;`.
 *
 * Anything else is returned verbatim, so it can only ever match itself: the path,
 * the `-x` predicate and the `if … ; then` shape stay pinned.
 */
function normalizeStepCondition(command: string): string {
  const subject = /^if\s+(.+?)\s*;\s*then$/u.exec(command)?.[1];
  if (subject === undefined) {
    return command;
  }
  const testOperand = /^test\s+-x\s+(.+)$/u.exec(subject)?.[1];
  if (testOperand !== undefined) {
    return `[ -x ${unquote(testOperand.trim())} ]`;
  }
  const bracketOperand = /^\[\s+-x\s+(.+?)\s+\]$/u.exec(subject)?.[1];
  if (bracketOperand !== undefined) {
    return `[ -x ${unquote(bracketOperand.trim())} ]`;
  }
  return command;
}

/** True when `command` is the executable-dep guard, in any accepted spelling. */
function isStepCondition(command: string): boolean {
  return normalizeStepCondition(command) === STEP_CONDITION_MEANING;
}

/** The one executable line that guards the step; throws a named error when absent. */
function requireStepCondition(lines: readonly HookLine[]): HookLine {
  const found = lines.find((line) => isStepCondition(line.command));
  if (found === undefined) {
    throw new Error(`${HOOK_PATH} has no \`if [ -x ${STEP_INVOCATION} ]; then\` guard.`);
  }
  return found;
}

interface GuardedStep {
  readonly condition: HookLine;
  readonly close: HookLine;
  /** The executable lines between `then` and `fi`. */
  readonly body: readonly HookLine[];
}

/** The `if … -x node_modules/.bin/lint-staged … ; then … fi` block, as executable lines. */
function guardedStep(lines: readonly HookLine[]): GuardedStep {
  const condition = requireStepCondition(lines);
  const after = lines.filter((line) => line.number > condition.number);
  const close = after.find((line) => line.command === "fi");
  if (close === undefined) {
    throw new Error(
      `${HOOK_PATH}: the \`${condition.command}\` block is never closed with \`fi\`.`
    );
  }
  return { condition, close, body: after.filter((line) => line.number < close.number) };
}

/** Every executable line that runs `lint-staged` through a package-manager wrapper. */
function wrapperInvocations(lines: readonly HookLine[]): HookFinding[] {
  return lines
    .filter((line) => PACKAGE_MANAGER_WRAPPER.test(line.command))
    .map((line) => ({ line: line.number, command: line.command }));
}

/**
 * Every executable line before `line` that is not an errexit switch. Anything left
 * here executed *before* `line`, which is what "first step" forbids for the guard.
 */
function commandsBefore(lines: readonly HookLine[], line: HookLine): HookLine[] {
  return lines.filter(
    (candidate) => candidate.number < line.number && !ERREXIT_ON.test(candidate.command)
  );
}

/**
 * Read once. The path is a literal (not `HOOK_PATH`) so
 * `security/detect-non-literal-fs-filename` stays quiet; `vitest run` executes from
 * the repo root, so the relative path is the repo's hook. The raw source is kept
 * because the syntax case feeds the *same bytes* to `sh -n` on stdin, so the parse
 * check can never read a different revision of the file than the line pin asserts on.
 */
const HOOK_SOURCE = readFileSync(".husky/pre-commit", "utf8");
const hook = parseHook(HOOK_SOURCE);

describe(".husky/pre-commit", () => {
  describe("its syntax", () => {
    it("parses as the shell it declares", () => {
      // `sh -n`, not `bash -n`: the hook's shebang is `#!/usr/bin/env sh`, so `sh` is
      // the interpreter git actually runs it with. A bashism (`[[ … ]]`, `function`)
      // passes `bash -n` and still aborts every commit; `sh -n` rejects it. The source
      // arrives on stdin, so this is the one subprocess in the spec and reads no path.
      const check = spawnSync("sh", ["-n"], { input: HOOK_SOURCE, encoding: "utf8" });
      const diagnostic = (check.error?.message ?? check.stderr).trim();

      expect(
        check.status,
        `\`sh -n\` rejected ${HOOK_PATH} (exit ${String(check.status)}): ` +
          `${diagnostic === "" ? "no diagnostic" : diagnostic}. A hook that cannot be ` +
          "parsed keeps every other case in this spec green, lands on main, and then fails " +
          "every commit in the repo: git refuses the hook before `set -e` or the identity " +
          "guard ever run. Fix the syntax; never delete this case."
      ).toBe(0);
    });
  });

  describe("its executable bit", () => {
    it("is executable, so git actually runs it", () => {
      // Git executes the mode on disk, not the mode recorded in the index, so this reads
      // the working tree: a hook that lost its bit — a committed `chmod 644`, a Windows
      // checkout without `core.filemode` — is not run by git at all: the commit still
      // succeeds and git prints only an advisory hint (`advice.ignoredHook`) even though
      // the index still says `100755`. The path is a literal for the same
      // `security/detect-non-literal-fs-filename` reason as `HOOK_SOURCE`.
      const mode = statSync(".husky/pre-commit").mode;

      expect(
        mode & 0o111,
        "a non-executable hook is not run by git: the commit still succeeds, so the " +
          "identity guard and lint-staged stop running and every gate stays green. " +
          "(Git prints an advisory hint only — `advice.ignoredHook`.) Restore the bit " +
          "(`chmod 755 .husky/pre-commit`) and commit the mode change."
      ).not.toBe(0);
    });
  });

  describe("the lint-staged step", () => {
    it("does not run lint-staged through a package-manager wrapper", () => {
      expect(
        wrapperInvocations(hook),
        "`pnpm lint-staged` triggers pnpm's deps-status check, which reinstalls and then " +
          "aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when node_modules is a " +
          "symlink to another worktree and there is no TTY; the commit dies and every agent " +
          "has to pass --no-verify, which skips lint-staged entirely. Invoke the local " +
          "binary instead."
      ).toEqual([]);
    });

    it("invokes lint-staged only as the local binary", () => {
      expect(
        hook
          .filter((line) => line.command.includes("lint-staged") && !isStepCondition(line.command))
          .map((line) => line.command)
      ).toEqual([STEP_INVOCATION]);
    });

    it("guards the step on the local binary being executable", () => {
      expect(
        hook.filter((line) => isStepCondition(line.command)),
        "ADR-0310: a worktree that has not run `pnpm install` has no dependencies, so the " +
          "step must be skipped rather than triggering an install mid-commit. The guard must " +
          "appear exactly once, in any behaviour-equivalent spelling."
      ).toHaveLength(1);
    });

    it("runs the local binary itself", () => {
      expect(hook.filter((line) => line.command === STEP_INVOCATION)).toHaveLength(1);
    });

    it("runs the local binary from inside the executable-dep guard", () => {
      const step = guardedStep(hook);

      expect(step.body.map((line) => line.command)).toContain(STEP_INVOCATION);
      expect(requireLine(step.body, STEP_INVOCATION).indent).not.toBe("");
    });
  });

  describe("the identity guard", () => {
    it("runs exactly once", () => {
      expect(hook.filter((line) => line.command === IDENTITY_GUARD)).toHaveLength(1);
    });

    it("is the first command the hook executes", () => {
      expect(
        commandsBefore(hook, requireLine(hook, IDENTITY_GUARD)).map((line) => line.command),
        "ADR-0309 / ADR-0310: the corrupted-identity refusal is the hook's FIRST step, so it " +
          "must run before any other command — an install, a check or anything else that " +
          "could fail first would let a corrupted identity reach the commit."
      ).toEqual([]);
    });

    it("runs before the lint-staged step", () => {
      expect(
        requireLine(hook, IDENTITY_GUARD).number,
        "ADR-0309 / ADR-0310: a corrupted repo-local identity (user.name / user.email set to " +
          "`--global` / `user.email`) is refused before anything else runs, so the commit is " +
          "refused even when lint-staged would pass."
      ).toBeLessThan(guardedStep(hook).condition.number);
    });

    it("runs as a top-level, unconditional command", () => {
      const guard = requireLine(hook, IDENTITY_GUARD);

      expect(guard.indent, "the identity guard must not be nested inside any shell block").toBe("");
      expect(guardedStep(hook).body.map((line) => line.command)).not.toContain(IDENTITY_GUARD);
    });
  });

  describe("fail-closed mode", () => {
    it("is enabled", () => {
      expect(
        requireErrexit(hook).command,
        "the hook must run `set -e`: a failing lint-staged (a staged .ts with an eslint parse " +
          "error aborts with rc=1) has to abort the commit, not be swallowed."
      ).toMatch(ERREXIT_ON);
    });

    it("is enabled at top level", () => {
      expect(
        hook
          .filter((line) => ERREXIT_ON.test(line.command) && line.indent !== "")
          .map((line) => line.command),
        "errexit must be switched on outside any shell block, or it does not apply to the " +
          "commands that follow."
      ).toEqual([]);
    });

    it("is enabled before the identity guard", () => {
      expect(requireErrexit(hook).number).toBeLessThan(requireLine(hook, IDENTITY_GUARD).number);
    });

    it("is enabled before the lint-staged step", () => {
      expect(requireErrexit(hook).number).toBeLessThan(guardedStep(hook).condition.number);
    });

    it("is never disabled", () => {
      expect(
        hook.filter((line) => ERREXIT_OFF.test(line.command)).map((line) => line.command),
        "`set +e` (or `set +o errexit`) re-enables swallowing a failure, so a failing " +
          "lint-staged would stop aborting the commit."
      ).toEqual([]);
    });
  });
});

describe("the hook-shape predicates", () => {
  /** A synthetic hook with today's executable shape; the comment quotes the rejected form. */
  const BASELINE = [
    "#!/usr/bin/env sh",
    "set -e",
    "",
    IDENTITY_GUARD,
    "",
    "# The binary is invoked directly, not via `pnpm lint-staged`: pnpm's pre-run",
    STEP_CONDITION,
    `  ${STEP_INVOCATION}`,
    "fi",
  ].join("\n");

  it("reads only the executable lines, so a comment naming the wrapper is not an invocation", () => {
    expect(
      parseHook(BASELINE).map((line) => line.command),
      "comment prose may name `pnpm lint-staged`; only executed lines are pinned"
    ).toEqual(["set -e", IDENTITY_GUARD, STEP_CONDITION, STEP_INVOCATION, "fi"]);
  });

  it("flags a reintroduced package-manager wrapper", () => {
    const wrapper = parseHook(BASELINE.replace(`  ${STEP_INVOCATION}`, "  pnpm lint-staged"));

    expect(wrapperInvocations(wrapper).map((finding) => finding.command)).toEqual([
      "pnpm lint-staged",
    ]);
  });

  it("flags a wrapper invoked through its path", () => {
    const renamed = parseHook(
      BASELINE.replace(`  ${STEP_INVOCATION}`, "  ./node_modules/.bin/pnpm lint-staged")
    );

    expect(wrapperInvocations(renamed).map((finding) => finding.command)).toEqual([
      "./node_modules/.bin/pnpm lint-staged",
    ]);
  });

  it("flags a wrapper invoked with flags", () => {
    const flagged = parseHook(
      BASELINE.replace(`  ${STEP_INVOCATION}`, "  npx --no-install lint-staged --concurrent 1")
    );

    expect(wrapperInvocations(flagged).map((finding) => finding.command)).toEqual([
      "npx --no-install lint-staged --concurrent 1",
    ]);
  });

  it("reports the indentation of a nested command", () => {
    const lines = parseHook(BASELINE);

    expect(requireLine(lines, STEP_INVOCATION).indent).toBe("  ");
    expect(requireLine(lines, IDENTITY_GUARD).indent).toBe("");
  });

  it("sees the commands executed before the identity guard", () => {
    const moved = parseHook(BASELINE.replace("set -e", "set -e\npnpm install --frozen-lockfile"));

    expect(
      commandsBefore(moved, requireLine(moved, IDENTITY_GUARD)).map((line) => line.command)
    ).toEqual(["pnpm install --frozen-lockfile"]);
  });

  it("treats every errexit spelling as fail-closed and `set +e` as its opposite", () => {
    const lines = parseHook(["set -eu", "set -o errexit", "set +e"].join("\n"));

    expect(
      lines.filter((line) => ERREXIT_ON.test(line.command)).map((line) => line.command)
    ).toEqual(["set -eu", "set -o errexit"]);
    expect(
      lines.filter((line) => ERREXIT_OFF.test(line.command)).map((line) => line.command)
    ).toEqual(["set +e"]);
  });

  it("rejects a hook whose guarded step is never closed", () => {
    expect(() => guardedStep(parseHook(BASELINE.replace("\nfi", "")))).toThrow(
      /is never closed with `fi`/u
    );
  });

  it("accepts the shellcheck-recommended quoted guard path", () => {
    const quoted = parseHook(
      BASELINE.replace(STEP_CONDITION, `if [ -x "${STEP_INVOCATION}" ]; then`)
    );

    expect(
      guardedStep(quoted).body.map((line) => line.command),
      "quoting the path is exactly what a shellcheck pass recommends and changes nothing at " +
        "run time, so it must not force a contributor to edit the pin"
    ).toEqual([STEP_INVOCATION]);
  });

  it("accepts the `test -x` spelling of the guarded step", () => {
    const posix = parseHook(
      BASELINE.replace(STEP_CONDITION, `if test -x ${STEP_INVOCATION}; then`)
    );

    expect(
      guardedStep(posix).body.map((line) => line.command),
      "`test -x PATH` and `[ -x PATH ]` are the same POSIX test, so the pin is on the test " +
        "and not on its spelling"
    ).toEqual([STEP_INVOCATION]);
  });

  it("still rejects a guard on any binary other than the local lint-staged", () => {
    const otherBinary = parseHook(
      BASELINE.replace(STEP_CONDITION, "if [ -x node_modules/.bin/prettier ]; then")
    );

    expect(
      () => guardedStep(otherBinary),
      "the tolerance is for spelling only: the guarded path stays exactly " +
        "`node_modules/.bin/lint-staged`"
    ).toThrow(/has no `if \[ -x node_modules\/\.bin\/lint-staged \]; then` guard/u);
  });
});
