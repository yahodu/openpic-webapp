/**
 * U1 — the pure git-identity validator behind the commit-time guard.
 *
 * Root cause this pins (ADR-0309, card `t_32fd1711`): `git config user.name
 * --global` — a *mis-ordered read* — writes the literal `--global` into the
 * **local** config, and `git config --global user.name user.email` (two
 * positionals) is a *write* that sets `user.name = "user.email"`. The shared
 * checkout's repo-local identity is inherited by every worktree, so one such
 * slip silently authors every later commit `--global <--global>`.
 *
 * Contract pinned here — a pure module, no I/O, no `process.exit`:
 *
 *   module   `scripts/git/identity-guard` (sibling of `scripts/check-env.ts`)
 *   exports  `interface GitIdentity { readonly name: string | undefined;
 *                                     readonly email: string | undefined }`
 *            `isValidGitIdentity(identity): boolean`   — pure predicate
 *            `assertGitIdentity(identity): void`       — throws on invalid
 *
 * `GitIdentity` is the *resolved pair* exactly as `git config --get user.name`
 * and `git config --get user.email` report them: a string, or `undefined` when
 * the key is unset (the command exits non-zero with no output).
 *
 * An identity is INVALID when either field:
 *   1. is `undefined` or contains no non-whitespace character (git returned
 *      nothing usable); or
 *   2. trims to `--global` (git's file-scope flag text); or
 *   3. trims to `user.email` (the config key name).
 * Nothing else is rejected: this guard must not grow into an RFC-5322 email
 * validator, or it would refuse legitimate identities.
 *
 * `assertGitIdentity` throws an `Error` whose message names the offending
 * config key(s) (`user.name` / `user.email`) and carries the repair hint
 * `git config --local`, so the commit hook's CLI wrapper can print it to stderr
 * and exit non-zero. A valid identity never throws.
 */
import { describe, expect, it } from "vitest";

import {
  assertGitIdentity,
  isValidGitIdentity,
  type GitIdentity,
} from "../../../../../scripts/git/identity-guard";

const VALID: GitIdentity = {
  name: "Ashish Sam T George",
  email: "77051732+getwithashish@users.noreply.github.com",
};

const REPAIR_HINT = "git config --local";

interface AcceptCase {
  label: string;
  identity: GitIdentity;
}

const ACCEPTED: AcceptCase[] = [
  { label: "a normal name and a well-formed email", identity: VALID },
  {
    label: "a unicode name and an email with a plus tag",
    identity: { name: "Joséphine Müller", email: "jose+ci@example.co.uk" },
  },
  {
    label: "a single-word name and a plain email",
    identity: { name: "admin", email: "admin@example.com" },
  },
];

interface RejectCase {
  label: string;
  identity: GitIdentity;
  key: "user.name" | "user.email";
}

const REJECTED: RejectCase[] = [
  {
    label: "user.name is the --global flag text",
    identity: { name: "--global", email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is the --global flag text",
    identity: { name: VALID.name, email: "--global" },
    key: "user.email",
  },
  {
    label: "user.name is the user.email key text",
    identity: { name: "user.email", email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is the user.email key text",
    identity: { name: VALID.name, email: "user.email" },
    key: "user.email",
  },
  {
    label: "user.name is empty",
    identity: { name: "", email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is empty",
    identity: { name: VALID.name, email: "" },
    key: "user.email",
  },
  {
    label: "user.name is whitespace only",
    identity: { name: "   ", email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is whitespace only",
    identity: { name: VALID.name, email: "\t \n" },
    key: "user.email",
  },
  {
    label: "user.name is unset",
    identity: { name: undefined, email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is unset",
    identity: { name: VALID.name, email: undefined },
    key: "user.email",
  },
  {
    label: "user.name is the --global flag text with surrounding whitespace",
    identity: { name: " --global ", email: VALID.email },
    key: "user.name",
  },
  {
    label: "user.email is the user.email key text with trailing whitespace",
    identity: { name: VALID.name, email: "user.email " },
    key: "user.email",
  },
];

function captureError(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("assertGitIdentity threw a non-Error value");
  }
  throw new Error("expected assertGitIdentity to throw");
}

describe("isValidGitIdentity", () => {
  it.each(ACCEPTED)("accepts $label", ({ identity }) => {
    expect(isValidGitIdentity(identity)).toBe(true);
  });

  it.each(REJECTED)("rejects $label", ({ identity }) => {
    expect(isValidGitIdentity(identity)).toBe(false);
  });
});

describe("assertGitIdentity", () => {
  it("does not throw for a normal name and a well-formed email", () => {
    expect(() => {
      assertGitIdentity(VALID);
    }).not.toThrow();
  });

  it.each(REJECTED)("throws for $label, naming $key and the repair hint", ({ identity, key }) => {
    expect(() => {
      assertGitIdentity(identity);
    }).toThrow(key);

    expect(() => {
      assertGitIdentity(identity);
    }).toThrow(REPAIR_HINT);
  });

  it("names every offending key in one message when both fields are garbage", () => {
    const error = captureError(() => {
      assertGitIdentity({ name: "--global", email: "user.email" });
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("user.name");
    expect(error.message).toContain("user.email");
    expect(error.message).toContain(REPAIR_HINT);
  });
});
