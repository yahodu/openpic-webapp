import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Source-scanning pin: the **tenant-free door** must never be opened on the two
 * tenant-scoped collections the OP-134 F5a finding was about.
 *
 * **Why this exists.** `eslint`'s `no-direct-collection-access` rule forbids a
 * raw `db.collection(...)` outside `apps/web/src/server/repos/**` (schema §10.2),
 * but it permits `platformRepo(db).collection(...)` — and `platformRepo` injects
 * **no** `tenantId` (`apps/web/src/server/repos/platform.ts`: it is a bare
 * `collectionHandle(db, name)`). So the lint boundary cannot tell a deliberate
 * platform-scope reach (`subscriptions`, `dispatches`, notification types, plans)
 * from a tenant-scoped one taken through the same door. Before `5a0c8e0`,
 * `apps/web/src/server/attendee/claim.ts` did exactly that:
 *
 * ```
 * const profilesOf = (db: Db) => platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles);
 * ```
 *
 * and a second helper read `selfies` the same way (two lines, `platformRepo(db)`
 * then `.collection(COLLECTIONS.selfies)`). F5a moved both into the whitelisted
 * `crossTenantWrites` in `apps/web/src/server/repos/cross-tenant.ts` (ADR-0825 §3,
 * PR #584). Nothing then stopped the same shape from coming back — which is this
 * pin. `attendeeEventProfiles` / `selfies` are reachable only through
 * `tenantRepo(...)` (the ordinary path) or `crossTenantWrites` (the one reviewed,
 * whitelisted exception).
 *
 * **Contract pinned here** (nothing in production exports it — the scanner is
 * test-tree code, the only place a repository-file scanner belongs):
 *
 * ```
 * interface DoorViolation {
 *   file: string;        // repo-relative POSIX path, e.g. "apps/web/src/server/attendee/claim.ts"
 *   line: number;        // 1-based line of the `platformRepo` token
 *   collection: "attendeeEventProfiles" | "selfies";
 *   snippet: string;     // the trimmed `platformRepo` line, for the failure message
 * }
 * findPlatformDoorViolations(file: string, source: string): DoorViolation[]
 * ```
 *
 * **The rule.** A violation is one `platformRepo` reference whose call is followed —
 * after nothing but whitespace, so the chain may break across lines — by
 * `.collection(` and then `COLLECTIONS.` + one of the two pinned names. Both the
 * single-line form the finding lived on and the multi-line
 * `platformRepo(db)\n  .collection(COLLECTIONS.selfies)` shape count. The match
 * tolerates an argument list that itself spans lines or nests parens
 * (`platformRepo(options.db ?? getDb())`) and an optional collection type
 * argument (`.collection<ReusableSelfieDocument>(...)`). Because a chain is read
 * through a **four-line window** starting at the `platformRepo` token, one
 * offender yields exactly one violation, and the reported `line` is the line a
 * reader must open.
 *
 * The rule is **textual**, like the ADR reference guard (ADR-0302 invariant (iv)):
 * a comment or docblock that spells the forbidden chain out also reddens. That is
 * intentional — the door is meant to be named, not written.
 *
 * **Scope.** The scan walks the tracked tree,
 * `git ls-tree -r --name-only HEAD -- apps/web/src/server`, and reads each listed
 * `.ts`/`.tsx` blob **from `HEAD`** (`git show HEAD:<path>`), so the listing and
 * the text come from the same commit: an uncommitted edit can neither hide a
 * reach nor invent one. Every file **outside** `apps/web/src/server/repos/**` is
 * scanned; that directory is excluded because it *is* the reviewed collection
 * boundary — the raw `db.collection(...)` calls in `repos/cross-tenant.ts` are the
 * sanctioned ones, and `no-direct-collection-access` already forbids them
 * everywhere else.
 *
 * **Allowlist: empty.** Only `attendeeEventProfiles` and `selfies` are pinned.
 * `platformRepo` over `subscriptions`, `invitations`, `userProfiles`,
 * `notificationPreferences`, `billingTransactions`, `dispatches`, `domainEvents`,
 * plans and notification types is deliberate and must **not** redden this pin — a
 * rule over those collections needs a product decision about which of them are
 * genuinely platform-scope, so it is out of scope here.
 *
 * **Known gaps** (deliberate, and the reason the eslint boundary stays in place):
 *   - an aliased door (`const repo = platformRepo(db); repo.collection(...)`);
 *   - a collection name held in a variable, or reached by a string literal
 *     (`.collection("selfies")`) instead of `COLLECTIONS.<name>`;
 *   - `collectionHandle(db, name)` called directly;
 *   - a chain interrupted by any non-whitespace token, or one whose `.collection`
 *     starts more than four lines below the `platformRepo` token.
 *
 * **Baseline.** Green on the merged trunk (`5a0c8e0` and later): no file under
 * `apps/web/src/server` outside `repos/**` opens the door on either collection.
 * Red on the pre-`5a0c8e0` shape: restoring that `claim.ts` reports
 * `apps/web/src/server/attendee/claim.ts:86` (and `:101`) — measured, not assumed.
 *
 * @see docs/adr/ADR-0825-op134-green-review-signoff.md §3 (finding F5)
 * @see apps/web/src/server/repos/cross-tenant.ts
 * @see apps/web/src/server/repos/platform.ts
 */

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

/** The two tenant-scoped collections F5a was about (schema §15.3). */
const PINNED_COLLECTIONS = ["attendeeEventProfiles", "selfies"] as const;

/** Platform-scope collections the door may keep reaching — out of scope here. */
const OUT_OF_SCOPE_COLLECTIONS = [
  "subscriptions",
  "invitations",
  "userProfiles",
  "notificationPreferences",
  "billingTransactions",
  "dispatches",
  "domainEvents",
  "plans",
  "notificationTypes",
] as const;

/** The subtree a service file must not open the tenant-free door inside. */
const SCANNED_ROOT = "apps/web/src/server";

/** The one directory allowed to reach a collection directly (schema §10.2). */
const REPOSITORY_ROOT = "apps/web/src/server/repos/";

/** How many lines (from the `platformRepo` token) a single chain may span. */
const CHAIN_WINDOW_LINES = 4;

const DOOR_TOKEN = "platformRepo";

type PinnedCollection = (typeof PINNED_COLLECTIONS)[number];

/** One `platformRepo` chain that reaches a pinned, tenant-scoped collection. */
interface DoorViolation {
  /** Repo-relative POSIX path of the offending file. */
  readonly file: string;
  /** 1-based line of the `platformRepo` token. */
  readonly line: number;
  /** The pinned collection the chain reaches. */
  readonly collection: PinnedCollection;
  /** The trimmed `platformRepo` line, so a failure names the code. */
  readonly snippet: string;
}

/** Advance past spaces, tabs and newlines (a chain may break at any of them). */
function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text.charAt(index))) {
    index += 1;
  }
  return index;
}

/** True for `[A-Za-z0-9_$]` — the character set an identifier token is made of. */
function isIdentifierCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 // $
  );
}

/** True when `index` is past the end of an identifier token or sits on a non-identifier. */
function isIdentifierBoundary(text: string, index: number): boolean {
  return index >= text.length || !isIdentifierCode(text.charCodeAt(index));
}

/**
 * Find the `)` that closes the `(` at `openIndex`, counting nesting so an
 * argument list like `platformRepo(options.db ?? getDb())` is read whole.
 *
 * @returns The index of the matching `)`, or `-1` when the call is unterminated.
 */
function matchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Decide whether the `platformRepo` call starting at `at` chains straight into
 * `.collection(COLLECTIONS.<pinned>)`.
 *
 * @param text - The window under inspection (whitespace, newlines included).
 * @param at - Offset of the `platformRepo` token inside `text`.
 * @returns The pinned collection reached, or `null` when the chain is anything
 *   else — a different door (`tenantRepo`), a different method, a collection
 *   outside the pin, or no chain at all.
 */
function pinnedCollectionReachedThrough(text: string, at: number): PinnedCollection | null {
  if (!text.startsWith(DOOR_TOKEN, at)) {
    return null;
  }

  // 1. The door's own argument list, wherever its `)` sits.
  let index = skipWhitespace(text, at + DOOR_TOKEN.length);
  if (text.charAt(index) !== "(") {
    return null;
  }
  const close = matchingParen(text, index);
  if (close === -1) {
    return null;
  }

  // 2. `.collection` must follow the door with nothing but whitespace between —
  //    a `;` or any other token means a different expression.
  index = skipWhitespace(text, close + 1);
  if (!text.startsWith(".collection", index)) {
    return null;
  }
  index = skipWhitespace(text, index + ".collection".length);

  // 3. An optional collection type argument, `.collection<Document>(`.
  if (text.charAt(index) === "<") {
    const typeArgumentsEnd = text.indexOf(">", index);
    if (typeArgumentsEnd === -1) {
      return null;
    }
    index = skipWhitespace(text, typeArgumentsEnd + 1);
  }
  if (text.charAt(index) !== "(") {
    return null;
  }

  // 4. The collection reference — `COLLECTIONS.<name>` only.
  index = skipWhitespace(text, index + 1);
  if (
    !text.startsWith("COLLECTIONS", index) ||
    !isIdentifierBoundary(text, index + "COLLECTIONS".length)
  ) {
    return null;
  }
  index = skipWhitespace(text, index + "COLLECTIONS".length);
  if (text.charAt(index) !== ".") {
    return null;
  }
  index = skipWhitespace(text, index + 1);
  for (const collection of PINNED_COLLECTIONS) {
    if (
      text.startsWith(collection, index) &&
      isIdentifierBoundary(text, index + collection.length)
    ) {
      return collection;
    }
  }
  return null;
}

/**
 * Scan one source text for platform-door reaches of the pinned collections.
 *
 * Line-by-line with a small window: every `platformRepo` token on line `n` is
 * parsed against lines `n … n + 3` joined, so the multi-line shape the finding
 * lived on is caught, one violation per token, and `line` stays the line of the
 * door rather than the line of the collection.
 *
 * @param file - Repo-relative path recorded on each violation.
 * @param source - The file's text.
 * @returns Every violation found, in source order.
 */
function findPlatformDoorViolations(file: string, source: string): DoorViolation[] {
  const lines = source.split("\n");
  const violations: DoorViolation[] = [];

  lines.forEach((text, index) => {
    let from = 0;
    for (;;) {
      const at = text.indexOf(DOOR_TOKEN, from);
      if (at === -1) {
        return;
      }
      from = at + DOOR_TOKEN.length;

      // Whole token only: not `myPlatformRepo` and not `platformRepos`.
      if (at > 0 && isIdentifierCode(text.charCodeAt(at - 1))) {
        continue;
      }
      if (!isIdentifierBoundary(text, at + DOOR_TOKEN.length)) {
        continue;
      }

      const window = lines.slice(index, index + CHAIN_WINDOW_LINES).join("\n");
      const collection = pinnedCollectionReachedThrough(window, at);
      if (collection !== null) {
        violations.push({ file, line: index + 1, collection, snippet: text.trim() });
      }
    }
  });

  return violations;
}

/**
 * Enumerate the tracked files the pin is responsible for: everything under
 * `apps/web/src/server` at `HEAD`, minus the repository layer.
 *
 * @returns Repo-relative paths, sorted, so a report is deterministic.
 * @throws If git cannot list the tree (a wrong root must never pass vacuously).
 */
function trackedServerFiles(): string[] {
  const listing = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "HEAD", "--", SCANNED_ROOT],
    {
      cwd: repoRoot,
      encoding: "utf8",
    }
  );

  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => !path.startsWith(REPOSITORY_ROOT))
    .sort();
}

/**
 * Read one tracked file's text **from `HEAD`**, not from the working copy, so the
 * listing (`git ls-tree`) and the content come from the same commit: an
 * uncommitted edit can neither hide a reach nor invent one.
 *
 * @param path - Repo-relative path as `git ls-tree` printed it.
 * @returns The blob's text.
 * @throws If the blob does not exist at `HEAD`.
 */
function readTrackedFile(path: string): string {
  return execFileSync("git", ["show", `HEAD:${path}`], { cwd: repoRoot, encoding: "utf8" });
}

/** Scan every tracked file the pin is responsible for, sorted by path then line. */
function scanServerTree(): DoorViolation[] {
  return trackedServerFiles()
    .flatMap((file) => findPlatformDoorViolations(file, readTrackedFile(file)))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

/** Render violations as `path:line` lines, so a failure names code instead of a count. */
function describeViolations(violations: readonly DoorViolation[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.file}:${String(violation.line)} → platformRepo over ` +
      `COLLECTIONS.${violation.collection} — ${violation.snippet}`
  );
}

describe("findPlatformDoorViolations — the shapes the tenant-free door takes", () => {
  it("flags the single-line form the F5a finding lived on", () => {
    // Arrange — `claim.ts` before `5a0c8e0`, verbatim (indentation included).
    const source =
      "const profilesOf = (db: Db) => platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles);\n";

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/attendee/claim.ts", source);

    // Assert
    expect(violations).toEqual([
      {
        file: "apps/web/src/server/attendee/claim.ts",
        line: 1,
        collection: "attendeeEventProfiles",
        snippet:
          "const profilesOf = (db: Db) => platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles);",
      },
    ]);
  });

  it("flags the multi-line form, where .collection starts on the next line", () => {
    // Arrange — the `selfieCreatedAt` helper of the same pre-`5a0c8e0` file.
    const source = [
      "  const row = (await platformRepo(db)",
      "    .collection(COLLECTIONS.selfies)",
      "    .findOne({ _id: selfieId })) as { readonly createdAt?: unknown };",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/attendee/claim.ts", source);

    // Assert
    expect(violations).toEqual([
      {
        file: "apps/web/src/server/attendee/claim.ts",
        line: 1,
        collection: "selfies",
        snippet: "const row = (await platformRepo(db)",
      },
    ]);
  });

  it("flags a chain whose door call spans lines and nests parens", () => {
    // Arrange — `platformRepo(options.db ?? getDb())` is a real call shape here.
    const source = [
      "  const rows = await platformRepo(",
      "    options.db ?? getDb()",
      "  )",
      "    .collection(COLLECTIONS.selfies)",
      "    .find({});",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert — the door is reported, not the collection line.
    expect(violations).toEqual([
      {
        file: "apps/web/src/server/example.ts",
        line: 1,
        collection: "selfies",
        snippet: "const rows = await platformRepo(",
      },
    ]);
  });

  it("flags the form carrying a collection type argument", () => {
    // Arrange — `repos/cross-tenant.ts` types every handle it opens.
    const source = [
      "  return db",
      "    .collection<ClaimProfileRow>(COLLECTIONS.attendeeEventProfiles)",
      "    .findOne({});",
      "",
      "  const raw = platformRepo(db)",
      "    .collection<ReusableSelfieDocument>(COLLECTIONS.selfies)",
      "    .findOne({});",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert
    expect(violations.map((violation) => [violation.line, violation.collection])).toEqual([
      [5, "selfies"],
    ]);
  });

  it("reports the 1-based line of the platformRepo token", () => {
    // Arrange — two blank lines push the door onto line 3.
    const source = [
      'import { platformRepo } from "@/server/repos";',
      "",
      "await platformRepo(db).collection(COLLECTIONS.attendeeEventProfiles).findOne({});",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert
    expect(violations.map((violation) => violation.line)).toEqual([3]);
  });

  it("reports one violation per reach, not one per file", () => {
    // Arrange
    const source = [
      "await platformRepo(db).collection(COLLECTIONS.selfies).findOne({});",
      "await platformRepo(db)",
      "  .collection(COLLECTIONS.attendeeEventProfiles)",
      "  .findOne({});",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert
    expect(violations.map((violation) => [violation.line, violation.collection])).toEqual([
      [1, "selfies"],
      [2, "attendeeEventProfiles"],
    ]);
  });
});

describe("findPlatformDoorViolations — what the pin must not flag", () => {
  it("does not flag the tenant-scoped doors that are allowed to reach these collections", () => {
    // Arrange — the ordinary path (`tenantRepo`) and the whitelisted cross-tenant one.
    const source = [
      "  const profile = await tenantRepo(tenantKey, db)",
      "    .collection(COLLECTIONS.attendeeEventProfiles)",
      "    .findOne({ eventId });",
      "  const selfie = await tenantRepo(tenantKey, db).collection(COLLECTIONS.selfies).findOne({});",
      "  await crossTenantWrites.repointAttendeeProfile({ db, fromProfileId, toProfileId, tenantKey });",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations(
      "apps/web/src/server/attendee/selfie-submit.ts",
      source
    );

    // Assert
    expect(violations).toEqual([]);
  });

  it("does not flag a collection name that merely starts with a pinned one", () => {
    // Arrange — the boundary check must not accept a longer identifier.
    const source = "await platformRepo(db).collection(COLLECTIONS.selfiesArchive).findOne({});\n";

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert
    expect(violations).toEqual([]);
  });

  it("does not flag a door that is not chained into a collection", () => {
    // Arrange — `platformRepo` also has non-collection uses in a projection chain.
    const source = [
      'import { platformRepo } from "@/server/repos";',
      "const repo = platformRepo(db);",
      "await repo.collection(COLLECTIONS.selfies).findOne({});",
      "await Promise.all([platformRepo(db).collection(BETTER_AUTH_USER).findOne({ _id })]);",
    ].join("\n");

    // Act
    const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

    // Assert — the aliased door is a documented gap, not a violation.
    expect(violations).toEqual([]);
  });

  it.each(OUT_OF_SCOPE_COLLECTIONS)(
    "does not flag platformRepo over the platform-scope collection %s",
    (collection) => {
      // Arrange — a deliberate platform-scope reach, which this pin must not widen to.
      const source = `await platformRepo(db).collection(COLLECTIONS.${collection}).findOne({});\n`;

      // Act
      const violations = findPlatformDoorViolations("apps/web/src/server/example.ts", source);

      // Assert
      expect(violations).toEqual([]);
    }
  );
});

describe("the tracked server tree never opens the tenant-free door on profiles or selfies", () => {
  it("enumerates the tracked tree under apps/web/src/server and skips the repository layer", () => {
    // Act
    const files = trackedServerFiles();

    // Assert — a vacuous scan must fail: the listing is what makes the pin real.
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => file.startsWith("apps/web/src/server/repos/"))).toEqual([]);
    expect(files.filter((file) => !file.startsWith(`${SCANNED_ROOT}/`))).toEqual([]);
  });

  it("no file under apps/web/src/server outside repos/** reaches attendeeEventProfiles or selfies through platformRepo", () => {
    // Act
    const violations = scanServerTree();

    // Assert — the report is `path:line`, never a bare count.
    expect(describeViolations(violations)).toEqual([]);
  });
});
