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
 * Row scope alone was still too wide (finding F1 of the review of PR #989): a
 * row's *mention* of a name in a neighbour's cell satisfied the pin, so a
 * variable whose own row was deleted stayed green wherever the doc happened to
 * cross-reference it. `variableCellNamesOf` narrows the pin to the name a row
 * **owns** — the single backticked token of its first (`Variable`) cell.
 *
 * Records: ADR-0995 (`docs/adr/ADR-0995-op101-config-row-scope-and-short-name-pins.md`),
 * ADR-0997 (`docs/adr/ADR-0997-op101-config-row-owner-pins.md`).
 */

/**
 * A markdown table delimiter cell: three or more dashes with optional alignment
 * colons (`---`, `:---`, `---:`, `:---:`).
 */
const SEPARATOR_CELL = /^:?-{3,}:?$/;

/**
 * A row's variable cell: exactly one backticked `UPPER_SNAKE` token and nothing
 * else, so prose, two names and a bare `-` are not owners.
 */
const VARIABLE_CELL = /^`([A-Z][A-Z0-9_]*)`$/;

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

/**
 * Split one table row into its trimmed cells.
 *
 * The row may carry leading indentation and the outer pipes are optional on a
 * single line; both are stripped before the split. A pipe inside a code span is
 * not special-cased, because `docs/Configuration.md` carries none (a `|` there
 * would have to be escaped, and no row does).
 *
 * @param row - One table row, as returned by {@link tableRowsOf}.
 * @returns The row's cells, trimmed, in column order.
 */
function cellsOf(row: string): string[] {
  let cells = row.trim();
  if (cells.startsWith("|")) {
    cells = cells.slice(1);
  }
  if (cells.endsWith("|")) {
    cells = cells.slice(0, -1);
  }

  return cells.split("|").map((cell) => cell.trim());
}

/**
 * Extract the variable names that table rows **own** in their first cell.
 *
 * A row owns a name only when its first (`Variable`) cell is exactly one
 * backticked `UPPER_SNAKE` token. Two structural row shapes are skipped rather
 * than read as owners: a delimiter row (`| --- | --- |`) and a header row — a row
 * whose successor is a delimiter row, which is how markdown defines a table's
 * header. Every other row that does not open with a single backticked token
 * (`| plain prose | … |`, `| \`A\` / \`B\` | … |`) throws: a reformatted table must
 * fail loudly, never quietly shrink to the rows that still parse.
 *
 * @param rows - Table rows, as returned by {@link tableRowsOf}.
 * @returns The owned names, in first-appearance order, deduplicated.
 * @throws If `rows` is empty, if no row owns a name, or if a body row's first
 * cell is not a single backticked `UPPER_SNAKE` variable.
 */
export function variableCellNamesOf(rows: readonly string[]): string[] {
  if (rows.length === 0) {
    throw new Error("the document carries no markdown table row (no line starts with `|`)");
  }

  const names: string[] = [];
  for (const [index, row] of rows.entries()) {
    const cells = cellsOf(row);
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) {
      continue;
    }

    const nextRow = rows.at(index + 1);
    if (nextRow !== undefined && cellsOf(nextRow).every((cell) => SEPARATOR_CELL.test(cell))) {
      continue;
    }

    const match = VARIABLE_CELL.exec(cells[0] ?? "");
    if (match === null) {
      throw new Error(
        `the table row \`${row.trim()}\` does not open with a single backticked UPPER_SNAKE variable in its first cell`
      );
    }

    names.push(match[1] ?? "");
  }

  if (names.length === 0) {
    throw new Error(
      "no markdown table row declares a backticked UPPER_SNAKE variable in its first cell"
    );
  }

  return [...new Set(names)];
}
