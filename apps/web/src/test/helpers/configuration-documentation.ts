/**
 * Parsers for the configuration documentation, shared by
 * `apps/web/src/server/config/env-example.test.ts`.
 *
 * The spec pins `.env.example` against `docs/Configuration.md`, and both
 * directions of that pin have to read the document. The parsers live here rather
 * than inline in the spec so the loud-failure contract — a reformatted document
 * must throw, never read as "no rows" or "no names" — is itself testable against
 * fixture strings; that is the row-scope finding (F2-a) and the short-name
 * finding (F2-b) of the review of PR #987.
 *
 * Record: ADR-0995 (`docs/adr/ADR-0995-op101-config-row-scope-and-short-name-pins.md`).
 */

/**
 * Split a markdown document into its table rows.
 *
 * A table row is a line whose first non-space character is `|`, so a row keeps
 * its leading indentation (a table may sit inside a list) and a prose line that
 * merely contains a pipe is not a row.
 *
 * @param markdown - The document's text.
 * @returns The table rows, in file order, exactly as written.
 * @throws If the document carries no table row: the caller must fail loudly
 * rather than pin an empty table.
 */
export function tableRowsOf(markdown: string): string[] {
  const rows = markdown.split(/\r?\n/).filter((line) => line.trimStart().startsWith("|"));
  if (rows.length === 0) {
    throw new Error("the document carries no markdown table row (no line starts with `|`)");
  }

  return rows;
}

/**
 * Extract the backticked `UPPER_SNAKE` variable names of a markdown fragment.
 *
 * The token pattern accepts a **single** leading character, so a documented name
 * is never invisible for being short: the three-character minimum the previous
 * pin carried left direction 2 blind to `CI`, a two-character name (finding F2-b
 * of the review of PR #987). A lowercase token (`memory`), a bare number (`10`)
 * and a `-` cell are not names. Duplicates collapse to the first appearance.
 *
 * @param markdown - The fragment to read: a whole document, or its table rows.
 * @returns The named variables, in first-appearance order.
 * @throws If the fragment names no backticked variable: an empty list would make
 * every derived case vacuous.
 */
export function documentedNamesOf(markdown: string): string[] {
  const names = [...markdown.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(([, name = ""]) => name);
  if (names.length === 0) {
    throw new Error("the document names no backticked UPPER_SNAKE variable in a code span");
  }

  return [...new Set(names)];
}
