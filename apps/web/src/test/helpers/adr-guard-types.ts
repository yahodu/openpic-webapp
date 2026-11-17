/**
 * Shared types and comparators for the ADR-number guard.
 *
 * The guard is one module per invariant behind the frozen barrel
 * `adr-numbering.ts`; the six invariants are tabulated once, in `0302`
 * (`## Decision`, the six-row invariant table).
 * Everything here is read by two or more of the invariant modules, or by the
 * specs directly: the report and issue shapes (a spec imports six of them from
 * this path), the ADR file-name pattern and its digit extractor (invariants
 * (i), (iv) and (v) all read a name), and the deterministic comparators that
 * keep a report identical for any input order.
 *
 * No filesystem access and no invariant logic lives here, so this module never
 * imports an invariant module.
 */

/**
 * The strict, canonical ADR file name: a four-digit number and a lowercase
 * `[a-z0-9]`-only dashed slug ending in `.md`. Deliberately anchored — a wrong
 * number length, an uppercase slug or another extension is malformed.
 */
const ADR_FILE_NAME_PATTERN = /^ADR-(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/**
 * The scope predicate: which file names the guard even looks at. Case-sensitive,
 * so a lowercase `adr-…` is not an ADR reference; `docs/adr/README.md` and any
 * other non-ADR markdown are ignored silently.
 */
export const IN_SCOPE_ADR_NAME_PATTERN = /^ADR-.*\.md$/;

/** A single numbering defect found by {@link checkAdrNumbers}. */
export interface AdrNumberIssue {
  /**
   * `duplicate` — two or more well-formed file names share one number;
   * `malformed` — one in-scope file name does not match the strict pattern;
   * `lane-range-overlap` — two ledger rows reserve intersecting closed ranges
   * (ADR-0300 §10), reported with `number: null` and the two `holders`;
   * `lane-range-malformed` — one ledger row is range-shaped but not an accepted
   * closed ascending pair (finding F1), reported with `number: null` and that
   * row's holder once.
   */
  code: "duplicate" | "malformed" | "lane-range-overlap" | "lane-range-malformed";

  /** The shared four-digit prefix, e.g. `"0146"`; `null` when unparseable. */
  number: string | null;

  /** The file names that triggered the issue, sorted ascending. */
  files: string[];
}

/** The report shape returned by {@link checkAdrNumbers} and {@link checkAdrDirectory}. */
export interface AdrCheckResult {
  /** `true` exactly when {@link AdrCheckResult.issues} is empty. */
  ok: boolean;

  /** The defects found, deterministically ordered (see {@link checkAdrNumbers}). */
  issues: AdrNumberIssue[];
}

/**
 * Extract the four-digit prefix of a *well-formed* ADR file name.
 *
 * @param fileName - A bare file name (no directory), e.g. `ADR-0146-a.md`.
 * @returns The four-digit prefix as written, e.g. `"0146"`; `null` when the name
 * does not match the strict pattern.
 */
export function adrDigitsOf(fileName: string): string | null {
  const match = ADR_FILE_NAME_PATTERN.exec(fileName);
  if (match === null) {
    return null;
  }
  return match[1] ?? null;
}

/** Deterministic, locale-independent string order (CI logs must be stable). */
export function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * One source file handed to {@link checkSourceAdrReferences}. `path` is carried
 * through into the report verbatim (repo-relative, POSIX separators), so the
 * caller decides how a file is named and the check stays pure.
 */
export interface SourceFileText {
  /** Repo-relative POSIX path, e.g. `apps/web/src/server/notifications/digest.ts`. */
  path: string;

  /** The whole file text; lines are split on `"\n"`. */
  text: string;
}

/**
 * One in-source `ADR-NNNN` reference with no `docs/adr/ADR-NNNN-*.md` file.
 *
 * `number` keeps the digits **as written** (leading zeros included) so the
 * failure message can be pasted into a search; `line` is 1-based so it matches
 * an editor's gutter.
 */
export interface SourceAdrReferenceIssue {
  /** Always `"dangling-reference"`; the discriminant for this issue family. */
  code: "dangling-reference";

  /** Repo-relative POSIX path of the source file that carries the reference. */
  file: string;

  /** 1-based line number of the reference. */
  line: number;

  /** The four-digit ADR number as written, e.g. `"0764"`. */
  number: string;
}

/** The report shape returned by {@link checkSourceAdrReferences}. */
export interface SourceAdrReferenceResult {
  /** `true` exactly when {@link SourceAdrReferenceResult.issues} is empty. */
  ok: boolean;

  /**
   * One entry per dangling reference — not per number and not per file — sorted
   * by `file`, then `line`, then `number`, so the report is identical for the
   * same sources in any input order.
   */
  issues: SourceAdrReferenceIssue[];

  /** References the rule evaluated (exempt ones are counted separately). */
  checkedReferences: number;

  /** References skipped because a fixture-tree line carries the marker. */
  exemptReferences: number;
}

/** Order source-reference issues: file, then line, then number. */
export function compareSourceIssues(
  left: { readonly file: string; readonly line: number; readonly number: string },
  right: { readonly file: string; readonly line: number; readonly number: string }
): number {
  const byFile = compareStrings(left.file, right.file);
  if (byFile !== 0) {
    return byFile;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return compareStrings(left.number, right.number);
}

/**
 * One ADR record as the accuracy sweep reads it: the bare file name (so a
 * report can say *which* record a citation resolved to) and the whole
 * markdown. The caller decides where the text comes from, so
 * {@link checkSourceAdrConsumers} stays pure and testable without fixtures on
 * disk.
 */
export interface AdrRecordText {
  /** Bare file name, e.g. `ADR-0302-adr-number-guard-contract.md`. */
  fileName: string;

  /** The record's whole markdown. */
  text: string;
}

/**
 * One accuracy finding.
 *
 * `consumer-mismatch` — the cited record declares a `Consumers:` field and does
 * not name the citing file. `consumers-malformed` — a record carries a
 * `Consumers`-shaped line that is not the canonical field, so reading it as "no
 * declaration" would enforce nothing without saying so. Both are failures.
 * `unlisted-consumer` — the cited record declares no `Consumers:` field at all,
 * so there is no claim to check; the citation is reported (and counted) in its
 * own channel, never as a failure, because 1206 of this head's 1238 references
 * point at records written before the field existed and a hard failure would
 * demand a 175-record docs programme. Enforcement is therefore **per record**:
 * the moment a record adds `Consumers:`, every citation of it is hard-checked,
 * and nothing is exempt by file or directory.
 */
export interface SourceAdrConsumerIssue {
  /** `consumer-mismatch` and `consumers-malformed` fail; `unlisted-consumer` is reported only. */
  code: "consumer-mismatch" | "unlisted-consumer" | "consumers-malformed";

  /** Repo-relative POSIX path of the citing file; for `consumers-malformed`, the record's file name. */
  file: string;

  /** 1-based line of the reference; for `consumers-malformed`, of the offending line in the record. */
  line: number;

  /** The four digits as written, e.g. `"0786"`. */
  number: string;

  /** The cited record's bare file name; for `consumers-malformed`, the record's own. */
  record: string;
}

/** The report shape returned by {@link checkSourceAdrConsumers}. */
export interface SourceAdrConsumerResult {
  /** `true` exactly when {@link SourceAdrConsumerResult.issues} is empty. */
  ok: boolean;

  /** One `consumer-mismatch` per citation the declaring record does not claim, plus one `consumers-malformed` per non-canonical field. */
  issues: SourceAdrConsumerIssue[];

  /** One `unlisted-consumer` per citation of a record that declares nothing. */
  unlisted: SourceAdrConsumerIssue[];

  /** References the accuracy rule evaluated (the cited record exists, not exempt). */
  checkedReferences: number;

  /** References skipped because a fixture-tree line carries the marker. */
  exemptReferences: number;

  /**
   * References whose record does not exist. Invariant 4 owns them; this counter
   * lets the two reports be reconciled
   * (`checkedReferences + danglingReferences === checkSourceAdrReferences(...).checkedReferences`).
   */
  danglingReferences: number;

  /** Evaluated references the cited record names. */
  verifiedReferences: number;

  /** Numbers (as written) of the records that declare consumers, ascending. */
  declaredRecords: string[];
}

/**
 * One markdown record handed to {@link checkAdrRecordLinks}.
 *
 * `path` is carried through into the report verbatim (repo-relative, POSIX
 * separators), so the caller decides how a record is named and the check stays
 * pure — it never touches the filesystem.
 */
export interface AdrRecordLinkFileText {
  /** Repo-relative POSIX path, e.g. `docs/adr/ADR-0782-op129-attendee-session-edge-pins.md`. */
  path: string;

  /** The record's whole markdown; lines are split on `"\n"`. */
  text: string;
}

/**
 * One markdown link target in a record with no `docs/adr` file of that exact
 * name (finding F3).
 *
 * `target` keeps the target **as written** (`#fragment` included) so the reader
 * can paste it back into the record, while `file` and `line` name the record and
 * the line that carries it.
 */
export interface AdrRecordLinkIssue {
  /** Always `"dangling-reference"`; the same discriminant the source sweep uses. */
  code: "dangling-reference";

  /** Repo-relative POSIX path of the record that carries the link. */
  file: string;

  /** 1-based line number of the link, matching an editor's gutter. */
  line: number;

  /**
   * The link target as written, `#fragment` included, so a report can quote it
   * back into the record, e.g. a renamed record's old file name.
   */
  target: string;
}

/** The report shape returned by {@link checkAdrRecordLinks}. */
export interface AdrRecordLinkResult {
  /** `true` exactly when {@link AdrRecordLinkResult.issues} is empty. */
  ok: boolean;

  /**
   * One entry per dangling link **occurrence** — not per target and not per
   * record — sorted by `file`, then `line`, then `target`.
   */
  issues: AdrRecordLinkIssue[];

  /** ADR-shaped link targets the rule evaluated. */
  checkedLinks: number;

  /** Records swept, so "no issues" can never be a vacuous pass. */
  scannedRecords: number;
}
