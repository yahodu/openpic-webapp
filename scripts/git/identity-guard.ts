/**
 * Commit-time git-identity guard (OP-110 follow-up) — the pure validator.
 *
 * **Why.** A mis-ordered `git config` invocation corrupts the *shared*
 * repo-local identity: `git config user.name --global` (a read attempt) writes
 * the literal `--global` into `.git/config`, and `git config --global user.name
 * user.email` writes the key name as the value. The corruption is silent, is
 * inherited by every worktree of the shared repo, and is invisible on trunk
 * (GitHub re-authors squash commits) — so the only enforcement point that
 * catches it independently of worker discipline is a guard that runs at commit
 * time inside a worktree. See ADR-0309 (the rule) and ADR-0310 (this contract
 * and the worktree hook-firing facts).
 *
 * This module is deliberately pure: no I/O, no `process.exit`, and no
 * side-effect at import, so the contract is unit-testable in-process. Resolving
 * the identity from git (and translating a throw into an exit code plus a
 * stderr line) belongs to the CLI wrapper, `./check-identity.ts`.
 *
 * @see ./check-identity.ts
 */

/** The resolved `user.name` / `user.email` pair, exactly as `git config --get` reports it. */
export interface GitIdentity {
  /** `git config --get user.name`; `undefined` when the key is unset (non-zero exit, no output). */
  readonly name: string | undefined;
  /** `git config --get user.email`; `undefined` when the key is unset (non-zero exit, no output). */
  readonly email: string | undefined;
}

/**
 * Values that are never a real identity: the file-scope flag text git wrote
 * when a read was mis-ordered (`--global`), and the config key name git wrote
 * when two positionals were passed to a write (`user.email`).
 */
const CORRUPT_VALUES: ReadonlySet<string> = new Set(["--global", "user.email"]);

const CONFIG_KEY = {
  name: "user.name",
  email: "user.email",
} as const;

const REPAIR_HINT =
  'Repair it with `git config --local user.name "<name>"` and `git config --local user.email "<email>"`.';

/**
 * A field is usable when it carries at least one non-whitespace character and
 * its trimmed value is not one of the corruption markers. Surrounding
 * whitespace is ignored on purpose: `" --global "` is the same defect as
 * `"--global"`.
 */
function isUsableValue(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 && !CORRUPT_VALUES.has(trimmed);
}

/**
 * Whether both halves of `identity` are usable — a pure predicate, no I/O.
 *
 * Valid: any non-empty, non-whitespace value that is not a corruption marker.
 * This is not an RFC-5322 email validator; adding one would refuse legitimate
 * identities.
 */
export function isValidGitIdentity(identity: GitIdentity): boolean {
  return isUsableValue(identity.name) && isUsableValue(identity.email);
}

/**
 * Throw an {@link Error} unless `identity` is valid; return `void` otherwise.
 *
 * The message names every offending config key (both, when both are bad) and
 * carries the `git config --local` repair hint, so the CLI wrapper can print it
 * verbatim to stderr. It never calls `process.exit`.
 */
export function assertGitIdentity(identity: GitIdentity): void {
  const offending: string[] = [];

  if (!isUsableValue(identity.name)) {
    offending.push(CONFIG_KEY.name);
  }

  if (!isUsableValue(identity.email)) {
    offending.push(CONFIG_KEY.email);
  }

  if (offending.length === 0) {
    return;
  }

  throw new Error(
    `The shared repo-local git identity is corrupt: ${offending.join(" and ")} ` +
      `must be a real name and email (git wrote a flag or a config key into ` +
      `the value). ${REPAIR_HINT}`
  );
}
