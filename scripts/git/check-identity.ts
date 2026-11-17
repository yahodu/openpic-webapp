/**
 * Commit-time git-identity guard (OP-110 follow-up) — the CLI wrapper.
 *
 * Run as `node scripts/git/check-identity.ts` (or `pnpm check:git-identity`)
 * from a checkout or worktree. It resolves `user.name` / `user.email` exactly
 * as `git config --get` reports them, hands the pair to the pure
 * {@link assertGitIdentity}, writes the thrown message to stderr and exits `1`
 * on a corrupt identity; it exits `0` otherwise.
 *
 * The commit hook `.husky/pre-commit` calls this before `lint-staged`, so a
 * commit inside any worktree — including a fresh `git worktree add` worktree
 * that has not installed its dependencies — is refused when the shared
 * repo-local identity is corrupt. See ADR-0309 / ADR-0310.
 *
 * The CLI reads configuration through git only; it never touches `process.env`
 * and never prints the resolved values (only the offending KEY names, from the
 * validator's message).
 */
import { execFileSync } from "node:child_process";

import { assertGitIdentity, type GitIdentity } from "./identity-guard.ts";

/**
 * Read one git config key from the repository the process runs in (the merged
 * system/global/local view, which is what a commit would use). Returns
 * `undefined` when the key is unset: `git config --get` then exits non-zero
 * with no output, which is the unset case the validator models.
 */
function readIdentityField(key: "user.name" | "user.email"): string | undefined {
  try {
    const raw = execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    // `git config --get` terminates its output with a newline; that byte is the
    // transport's, not part of the configured value.
    return raw.replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

const identity: GitIdentity = {
  name: readIdentityField("user.name"),
  email: readIdentityField("user.email"),
};

try {
  assertGitIdentity(identity);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Invalid git identity"}\n`);
  process.exit(1);
}

process.exit(0);
