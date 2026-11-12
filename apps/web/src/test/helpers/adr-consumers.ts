/**
 * ADR guard, invariant (v) — every citation of a declaring record names the
 * citing file (finding F-N1). The guard's six invariants are tabulated once, in
 * `0302` §1; the decision detail for this one is §9.
 *
 * This is the question invariant (iv) cannot answer: "is the record this comment
 * cites the *right* record?" Existence is not accuracy. Nine OP-129 spec headers
 * cited a number that had never been minted; when a record with that number was
 * minted for the OP-128 lane, all nine silently became "valid" references to a
 * decision about a different feature, and the (iv) real-tree case stayed green.
 * The accuracy rule is decidable only where a record states its own consumers,
 * so it is opt-in per record: a record carrying a `Consumers:` field is
 * hard-checked against every file that cites it, and a record without one is
 * counted as `unlisted-consumer` so the debt stays visible. A token is read as
 * written when that form names a swept file; only a token naming none is
 * re-read with one trailing `:<suffix>` annotation stripped, where the suffix may
 * contain a dot (`:D1.2`), because `…/uploads:link` is a real directory name
 * (finding F-C3). See {@link checkSourceAdrConsumers} and
 * {@link checkRepositoryAdrConsumers}.
 */

import { join, posix } from "node:path";

import type {
  AdrRecordText,
  SourceAdrConsumerIssue,
  SourceAdrConsumerResult,
  SourceFileText,
} from "./adr-guard-types.js";
import {
  adrDigitsOf,
  compareSourceIssues,
  compareStrings,
  IN_SCOPE_ADR_NAME_PATTERN,
} from "./adr-guard-types.js";
import {
  collectSourceFiles,
  isSourceAdrFixturePath,
  readDirectoryEntries,
  readTextFile,
  SOURCE_ADR_REFERENCE_FIXTURE_MARKER,
  SOURCE_ADR_REFERENCE_PATTERN,
  SOURCE_SWEEP_ROOTS,
} from "./adr-source-references.js";

/**
 * The consumer declaration: exactly the `Consumers:` field label opening a list
 * item at column 0. `Consumes:` is a different field (what the decision consumes,
 * not who consumes it) and must never be read as one of these.
 */
const CONSUMERS_FIELD_PATTERN = /^-\s+\*\*Consumers:\*\*/;

/**
 * Is `line` a `Consumers` field in a plausible but non-canonical shape — an
 * indented or `*`/`+` bullet, a `>` blockquote level, an ordered-list marker,
 * `__…__` bold, the colon outside the bold, no bullet, a plain unbolded label,
 * or a heading? Reported as `consumers-malformed`, so one punctuation slip
 * cannot silently switch the rule off for its record (finding F2).
 *
 * Recognition is deliberately wider than canonicality and the peels run in
 * sequence, so the shapes compose: every blockquote level, then every heading
 * or list marker (a line can carry both, in either order), then the bold
 * markers. The caller has already ruled out the column-0 canonical form, hence
 * anything recognized here is malformed by construction. Prose is not a field
 * shape: once the markers are gone the label must open the line and, unless the
 * line is a heading, carry its colon.
 */
function isMalformedConsumersField(line: string): boolean {
  let body = line.trim();
  while (body.startsWith(">")) {
    body = body.slice(1).trimStart(); // one blockquote level
  }
  if (/^#{1,6}[ \t]+\*{0,2}Consumers\b/.test(body)) {
    return true; // after the peel, so a quoted heading cannot go silent
  }

  for (;;) {
    const peeled = body.replace(/^(?:\d+[.)]|[-*+]|#{1,6})[ \t]+/, "");
    if (peeled === body) {
      break;
    }
    body = peeled;
  }
  body = body.replace(/^[*_]+/, "");
  return /^Consumers[*_]{0,3}\s*:/.test(body);
}

/**
 * A repo-relative path token in a record, e.g. `apps/web/src/server/x.ts`.
 * Brackets and `:` are part of the path (Next.js route segments), so they stay
 * in.
 */
const RECORD_PATH_TOKEN_PATTERN = /(?:apps|packages)\/[A-Za-z0-9_./[\]:-]+/g;

/**
 * A module specifier in a record, e.g. `` `@/server/rate-limit/classes` ``. A
 * trailing `[...]` group is an annotation (`@/api/v1/p/attendee-sessions[/current]`
 * names the route and its child), so it is stripped before resolution.
 */
const RECORD_SPECIFIER_TOKEN_PATTERN = /@\/[A-Za-z0-9_./[\]:-]+/g;

/** A backticked identifier in a record, e.g. `` `AUTH_ERROR_CODES` ``. */
const RECORD_BACKTICKED_NAME_PATTERN = /`([A-Za-z_$][A-Za-z0-9_$]*)`/g;

/** An exported declaration in a source file, e.g. `export function gate(`. */
const SOURCE_EXPORTED_DECLARATION_PATTERN =
  /\bexport\s+(?:const|let|var|function|class|interface|type|enum)\b|\bexport\s+async\s+function\b/g;

/** The identifier a declaration introduces, read from the text after it. */
const EXPORTED_IDENTIFIER_PATTERN = /^\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/;

/** An export list in a source file, e.g. `export { a, b as c }`. */
const SOURCE_EXPORT_LIST_PATTERN = /\bexport\s*\{([^}]*)\}/g;

/**
 * The identifier floor for the exported-symbol channel. Short generic names
 * (`GET`, `rate`, `db`) appear in hundreds of records and would verify
 * arbitrary files; six characters is the point where a name is specific enough
 * to identify a file's API. Deliberate leniency in one direction only: a false
 * accept hides a citation the record does talk about, a false failure would get
 * silenced with a wider exemption.
 */
const MIN_EXPORTED_SYMBOL_LENGTH = 6;

/**
 * Trim the punctuation a prose mention leaves on a path token. A trailing
 * `:<digits>` is a line annotation, trimmed after the punctuation so
 * `path.ts:42.` reduces to `path.ts`. A non-digit annotation (`path.ts:D1`) is
 * stripped later and only when the literal token names no swept file — see
 * {@link checkSourceAdrConsumers}.
 */
function trimPathToken(token: string): string {
  return token.replace(/[.,;:]+$/, "").replace(/:\d+$/, "");
}

/**
 * Strip one trailing `:<suffix>` annotation, e.g. `x.ts:D1` -> `x.ts`. The
 * suffix may contain a dot, so a section pointer (`x.ts:D1.2`) strips too; a
 * second `:` is left alone.
 */
function stripTrailingAnnotation(token: string): string {
  return token.replace(/:[A-Za-z0-9_.-]+$/, "");
}

/** The last segment of a path, after POSIX normalization. */
function bareFileName(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Read a record's `Consumers` field: does it declare (canonically or in a
 * malformed shape), and which lines carry a malformed shape? A malformed field
 * still declares — a slip must not switch enforcement off as a side effect of
 * being reported (finding F2).
 */
function consumersField(text: string): { declares: boolean; malformedLines: number[] } {
  const malformedLines: number[] = [];
  let declares = false;

  for (const [index, line] of text.split("\n").entries()) {
    if (CONSUMERS_FIELD_PATTERN.test(line)) {
      declares = true;
    } else if (isMalformedConsumersField(line)) {
      declares = true;
      malformedLines.push(index + 1);
    }
  }

  return { declares, malformedLines };
}

/** Strip a trailing `[...]` annotation group from a module specifier. */
function stripSpecifierAnnotation(specifier: string): string {
  return specifier.replace(/\[[^\]]*\]$/, "");
}

/** The facts a record contributes to the accuracy rule, computed once. */
interface RecordConsumerFacts {
  /** The record's file name, reported verbatim. */
  fileName: string;

  /** Does the record declare consumers, canonically or in a malformed shape? */
  declaresConsumers: boolean;

  /** 1-based lines of `Consumers`-shaped fields that are not the canonical one. */
  malformedConsumersLines: number[];

  /** Repo-relative path tokens, trimmed. */
  paths: string[];

  /** `@/…` specifiers mapped to `apps/web/src/…` and de-annotated. */
  specifiers: string[];

  /** The backticked identifiers the record names. */
  symbols: ReadonlySet<string>;

  /** The whole markdown, for the bare-file-name channel. */
  text: string;
}

/** Read one record's identification surface. */
function recordConsumerFacts(record: AdrRecordText): RecordConsumerFacts {
  const paths = [...record.text.matchAll(RECORD_PATH_TOKEN_PATTERN)]
    .map((match) => trimPathToken(match[0]))
    .filter((token) => token.length > "apps/".length);

  const specifiers = [...record.text.matchAll(RECORD_SPECIFIER_TOKEN_PATTERN)]
    .map((match) => stripSpecifierAnnotation(trimPathToken(match[0])))
    .filter((token) => token.length > "@/".length)
    // `@/x` names `apps/web/src/x` for a module, and `apps/web/src/app/x` for an
    // App Router route: records write `@/api/v1/p/attendee-sessions[/current]`
    // for the route as well as `@/server/db/indexes` for the module, and both
    // must resolve or the channel would only ever work for one of them.
    .flatMap((token) => [`apps/web/src/${token.slice(2)}`, `apps/web/src/app/${token.slice(2)}`]);

  const symbols = new Set(
    [...record.text.matchAll(RECORD_BACKTICKED_NAME_PATTERN)].map((match) => match[1] ?? "")
  );
  symbols.delete("");

  const consumers = consumersField(record.text);

  return {
    fileName: record.fileName,
    declaresConsumers: consumers.declares,
    malformedConsumersLines: consumers.malformedLines,
    paths,
    specifiers,
    symbols,
    text: record.text,
  };
}

/** Does `text` mention `token` as a whole name (not as part of a longer one)? */
function mentionsToken(text: string, token: string): boolean {
  const isNameCharacter = (character: string): boolean => /[A-Za-z0-9_$-]/.test(character);
  let index = text.indexOf(token);

  while (index !== -1) {
    const before = text.charAt(index - 1);
    const after = text.charAt(index + token.length);
    const boundaryBefore = before === "" || (!isNameCharacter(before) && before !== ".");
    const boundaryAfter = after === "" || !isNameCharacter(after);

    if (boundaryBefore && boundaryAfter) {
      return true;
    }
    index = text.indexOf(token, index + 1);
  }

  return false;
}

/** The identifiers a source file exports, minus the ones below the floor. */
function exportedIdentifiers(text: string): string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(SOURCE_EXPORTED_DECLARATION_PATTERN)) {
    const rest = text.slice(match.index + match[0].length);
    const declared = EXPORTED_IDENTIFIER_PATTERN.exec(rest)?.[1];
    if (declared !== undefined) {
      names.add(declared);
    }
  }

  for (const list of text.matchAll(SOURCE_EXPORT_LIST_PATTERN)) {
    for (const entry of (list[1] ?? "").split(",")) {
      const alias =
        entry
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? "";
      const name = alias.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        names.add(name);
      }
    }
  }

  return [...names].filter((name) => name.length >= MIN_EXPORTED_SYMBOL_LENGTH);
}

/**
 * Does `facts` identify the file at `sourcePath`, given the identifiers that
 * file exports? The four channels are, in the order the module docblock states
 * them: repo-relative path (exact or directory prefix), `@/` module specifier
 * (exact, plus a swept extension, or directory prefix), the bare file name as a
 * whole token — only when that name is in `uniqueBareNames` — and an exported
 * identifier the record names in backticks.
 *
 * The bare-name gate is finding F1: a name several swept files share names none
 * of them, or one record's mention of `route.ts` would verify every route in the
 * tree.
 */
function identifiesFile(
  facts: RecordConsumerFacts,
  sourcePath: string,
  exported: readonly string[],
  uniqueBareNames: ReadonlySet<string>
): boolean {
  const normalized = posix.normalize(sourcePath);

  if (
    facts.paths.some(
      (candidate) =>
        normalized === candidate || normalized.startsWith(`${candidate.replace(/\/+$/, "")}/`)
    )
  ) {
    return true;
  }

  if (
    facts.specifiers.some(
      (candidate) =>
        normalized === candidate ||
        normalized.startsWith(`${candidate.replace(/\/+$/, "")}/`) ||
        normalized.startsWith(`${candidate}.`)
    )
  ) {
    return true;
  }

  const bareName = bareFileName(sourcePath);
  if (bareName.length > 0 && uniqueBareNames.has(bareName) && mentionsToken(facts.text, bareName)) {
    return true;
  }

  return exported.some((name) => facts.symbols.has(name));
}

/**
 * Check that every `ADR-NNNN` reference in `sources` points at a record that
 * names the citing file, when the record declares who its consumers are
 * (finding F-N1). Pure — it never touches the filesystem.
 *
 * The reference population is exactly {@link checkSourceAdrReferences}'s, with
 * the same per-line `adr-fixture` exemption inside `apps/web/src/test` and the
 * same case-sensitive token, so the two reports reconcile. Each citation is
 * classified once: a reference whose record is missing is counted in
 * `danglingReferences` and left to invariant 4; a citation of a record without a
 * `Consumers:` field is `unlisted-consumer`; a citation of a declaring record
 * that identifies the file is `verifiedReferences`; everything else is a
 * `consumer-mismatch` issue. A record whose `Consumers` field is not the
 * canonical shape still declares and still hard-checks its citations, and its
 * offending line is an `issues` entry of its own (`consumers-malformed`), so a
 * hand-written slip fails the report instead of silently disabling the rule.
 *
 * Duplicate numbers do not make this throw or go vacuous: a citation is declared
 * when *any* record with that number declares, and verified when any of them
 * identifies the citing file — reporting duplicates stays
 * {@link checkAdrNumbers}' job.
 *
 * @param sources - The source files to scan, in any order.
 * @param records - The `docs/adr` records: bare file name plus whole text.
 * @returns The accuracy report; `ok` is `false` exactly when a declaring record
 * does not claim a file that cites it.
 * @example
 * ```ts
 * checkSourceAdrConsumers(
 *   [{ path: "apps/web/src/server/x.ts", text: "// see ADR-0146-a.md" }],
 *   [{ fileName: "ADR-0146-a.md", text: "- **Consumers:** `apps/web/src/server/x.ts`" }]
 * );
 * // { ok: true, issues: [], verifiedReferences: 1, declaredRecords: ["0146"], … }
 * ```
 */
export function checkSourceAdrConsumers(
  sources: readonly SourceFileText[],
  records: readonly AdrRecordText[]
): SourceAdrConsumerResult {
  const factsByNumber = new Map<string, RecordConsumerFacts[]>();
  for (const record of [...records].sort((left, right) =>
    compareStrings(left.fileName, right.fileName)
  )) {
    const digits = adrDigitsOf(record.fileName);
    if (digits === null) {
      continue;
    }
    const seen = factsByNumber.get(digits);
    const facts = recordConsumerFacts(record);
    if (seen === undefined) {
      factsByNumber.set(digits, [facts]);
    } else {
      seen.push(facts);
    }
  }

  const declaredRecords = [...factsByNumber.entries()]
    .filter(([, facts]) => facts.some((entry) => entry.declaresConsumers))
    .map(([digits]) => digits)
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));

  const issues: SourceAdrConsumerIssue[] = [];
  const unlisted: SourceAdrConsumerIssue[] = [];
  let checkedReferences = 0;
  let exemptReferences = 0;
  let danglingReferences = 0;
  let verifiedReferences = 0;

  // The bare-name channel only identifies a file whose bare name is unique
  // across the swept population (finding F1).
  const bareNameCounts = new Map<string, number>();
  for (const source of sources) {
    const name = bareFileName(source.path);
    bareNameCounts.set(name, (bareNameCounts.get(name) ?? 0) + 1);
  }
  const uniqueBareNames = new Set(
    [...bareNameCounts].filter(([, count]) => count === 1).map(([name]) => name)
  );

  // Literal first, annotation second: a token whose written form names a swept
  // file is read as written, and only a token naming none is re-read with one
  // trailing `:<suffix>` stripped. The order is load-bearing — `…/uploads:link`
  // is a real directory, so stripping first would collapse it onto the
  // colon-free sibling's directory and verify both files.
  const normalizedSources = sources.map((source) => posix.normalize(source.path));
  const namesAFile = (token: string): boolean =>
    normalizedSources.some(
      (path) => path === token || path.startsWith(`${token.replace(/\/+$/, "")}/`)
    );
  for (const entries of factsByNumber.values()) {
    for (const entry of entries) {
      entry.paths = entry.paths.map((token) =>
        namesAFile(token) ? token : stripTrailingAnnotation(token)
      );
      entry.specifiers = entry.specifiers.map((candidate) =>
        namesAFile(candidate) ? candidate : stripTrailingAnnotation(candidate)
      );
    }
  }

  // Reported per record, not per citation: a malformed field in a record nobody
  // cites is still a failure (finding F2).
  for (const [digits, facts] of factsByNumber) {
    for (const entry of facts) {
      for (const line of entry.malformedConsumersLines) {
        issues.push({
          code: "consumers-malformed",
          file: entry.fileName,
          line,
          number: digits,
          record: entry.fileName,
        });
      }
    }
  }

  for (const source of sources) {
    const exported = exportedIdentifiers(source.text);

    for (const [index, line] of source.text.split("\n").entries()) {
      const references = [...line.matchAll(SOURCE_ADR_REFERENCE_PATTERN)];
      if (references.length === 0) {
        continue;
      }

      if (
        isSourceAdrFixturePath(source.path) &&
        line.includes(SOURCE_ADR_REFERENCE_FIXTURE_MARKER)
      ) {
        exemptReferences += references.length;
        continue;
      }

      for (const reference of references) {
        const number = reference[1] ?? "";
        const facts = factsByNumber.get(number);
        if (facts === undefined) {
          danglingReferences += 1;
          continue;
        }

        checkedReferences += 1;
        const citedRecord = facts[0]?.fileName ?? "";
        if (!facts.some((entry) => entry.declaresConsumers)) {
          unlisted.push({
            code: "unlisted-consumer",
            file: source.path,
            line: index + 1,
            number,
            record: citedRecord,
          });
          continue;
        }

        if (facts.some((entry) => identifiesFile(entry, source.path, exported, uniqueBareNames))) {
          verifiedReferences += 1;
          continue;
        }

        issues.push({
          code: "consumer-mismatch",
          file: source.path,
          line: index + 1,
          number,
          record: citedRecord,
        });
      }
    }
  }

  issues.sort(compareSourceIssues);
  unlisted.sort(compareSourceIssues);

  return {
    ok: issues.length === 0,
    issues,
    unlisted,
    checkedReferences,
    exemptReferences,
    danglingReferences,
    verifiedReferences,
    declaredRecords,
  };
}

/**
 * Apply {@link checkSourceAdrConsumers} to a real working tree: read the records
 * out of `<root>/docs/adr/`, then every source file under `<root>/apps/` and
 * `<root>/packages/` — the same roots, extensions and skipped directories as
 * {@link checkRepositoryAdrReferences}, so the two sweeps see one population.
 *
 * @param root - Absolute path to the repository root.
 * @returns The same report shape as {@link checkSourceAdrConsumers}.
 * @throws If `docs/adr`, `apps` or `packages` cannot be read, so a wrong root
 * fails loudly instead of reporting a vacuous pass.
 */
export function checkRepositoryAdrConsumers(root: string): SourceAdrConsumerResult {
  // Read the ADR directory first: a bad root throws here, before any source is
  // collected, so "nothing to check" can never be a false pass.
  const records: AdrRecordText[] = readDirectoryEntries(join(root, "docs/adr"))
    .filter((entry) => entry.isFile() && IN_SCOPE_ADR_NAME_PATTERN.test(entry.name))
    .map((entry) => ({
      fileName: entry.name,
      text: readTextFile(join(root, "docs/adr", entry.name)),
    }));

  const paths: string[] = [];
  for (const top of SOURCE_SWEEP_ROOTS) {
    collectSourceFiles(root, join(root, top), paths);
  }
  paths.sort(compareStrings);

  const sources = paths.map((path) => ({ path, text: readTextFile(join(root, path)) }));

  return checkSourceAdrConsumers(sources, records);
}
