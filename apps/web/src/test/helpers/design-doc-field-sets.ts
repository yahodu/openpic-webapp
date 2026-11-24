/**
 * Field-set parsers for the design doc's per-collection field tables (OP-140
 * follow-up).
 *
 * **Why this exists.** `docs/Notification and Database Design.md` §14.3 lists
 * every field the `subscriptions` collection stores, and the billing mint
 * routes are what writes those fields. The table drifted from the writers
 * **twice in one section**: `checkout` was written by ADR-0420/0421 before the
 * row existed (added in PR #857), and `currency` was written at mint long before
 * its row existed (added by the sibling docs card). No spec read the table, so
 * nothing could see the drift. This module supplies the two pure readers the
 * guard needs — one for the documented set, one for the written set — so both
 * can be pinned with synthetic strings as well as against the real tree.
 *
 * Scope: this module only *parses*. The set arithmetic (`written − meta ⊆
 * documented`) belongs to the caller, so the subtraction rule stays visible
 * where it is asserted.
 *
 * @see apps/web/src/test/unit/design-doc-subscriptions-fields.test.ts
 */

/** The §14.3 heading, byte-for-byte as the design doc writes it. */
const SUBSCRIPTIONS_HEADING = "### 14.3 `subscriptions`";

/** The header cell naming the column whose cells carry the field names. */
const FIELD_COLUMN_HEADER = "field";

/**
 * True when `line` is a markdown table line (a trimmed line that starts and
 * ends with an unescaped `|`).
 *
 * @param line - One line of markdown.
 * @returns Whether the line is part of a table.
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

/**
 * True when `line` is a markdown table's `---` separator row (only `|`, `-`,
 * `:` and spaces).
 *
 * @param line - One line of markdown.
 * @returns Whether the line separates a table header from its body.
 */
function isTableSeparator(line: string): boolean {
  return isTableRow(line) && /^[|\-: ]+$/.test(line.trim());
}

/**
 * Split one table line into its cells. Pipes escaped as `\|` (the design doc
 * uses them inside union-type cells such as `"active" \| "past_due"`) do not
 * split a cell.
 *
 * @param line - One table line, with or without outer pipes.
 * @returns The trimmed cell texts, in column order.
 */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/**
 * Turn one `Field` cell into field names: the doc packs synonyms into a single
 * cell in two ways, `` `cancelAt`, `cancelledAt`, `cancelReason` `` (commas) and
 * `` `currentPeriodStart` / `currentPeriodEnd` `` (a slash), so both separators
 * are split. Backticks are stripped and empty pieces dropped.
 *
 * @param cell - The raw `Field` cell text.
 * @returns The field names named by the cell, in cell order.
 */
function fieldNamesInCell(cell: string): string[] {
  return cell
    .replaceAll("`", "")
    .split(/[/,]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Read the documented `subscriptions` field set out of the design doc: find the
 * `### 14.3 `subscriptions`` section, take its **first** markdown table, and
 * turn the column whose header is `Field` into a sorted, duplicate-free set.
 *
 * The section and the column are both looked up rather than assumed: a
 * positional read would silently pin the `Type` column if the table were
 * reordered, and a missing section would pin an empty set — a guard that passes
 * on nothing. Both are errors here.
 *
 * @param markdown - The whole design doc, or a synthetic stand-in for it.
 * @returns The documented field names, sorted.
 * @throws If the §14.3 heading is absent, or its first table has no `Field`
 *   column.
 */
export function documentedFieldNames(markdown: string): string[] {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) => line.trimEnd() === SUBSCRIPTIONS_HEADING);
  if (headingIndex === -1) {
    throw new Error(`The design doc has no ${SUBSCRIPTIONS_HEADING} section.`);
  }

  // The section ends at the next heading of the same or a higher level, so a
  // later section's table can never stand in for this one's.
  let sectionEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{2,3} /.test(lines.at(index) ?? "")) {
      sectionEnd = index;
      break;
    }
  }

  const tableStart = lines.findIndex(
    (line, index) =>
      index > headingIndex &&
      index < sectionEnd &&
      isTableRow(line) &&
      isTableSeparator(lines[index + 1] ?? "")
  );
  if (tableStart === -1) {
    throw new Error(`${SUBSCRIPTIONS_HEADING} has no markdown table.`);
  }

  const fieldColumn = tableCells(lines.at(tableStart) ?? "").findIndex(
    (cell) => cell.toLowerCase() === FIELD_COLUMN_HEADER
  );
  if (fieldColumn === -1) {
    throw new Error(`The ${SUBSCRIPTIONS_HEADING} table has no \`Field\` column.`);
  }

  const names: string[] = [];
  for (
    let index = tableStart + 2;
    index < sectionEnd && isTableRow(lines.at(index) ?? "");
    index += 1
  ) {
    names.push(...fieldNamesInCell(tableCells(lines.at(index) ?? "").at(fieldColumn) ?? ""));
  }

  return [...new Set(names)].sort();
}

/**
 * One source file's written-field scan: how many anchored object literals were
 * found (so a caller can refuse a scan that found none) and the property names
 * they write.
 */
export interface WrittenFieldReport {
  /** Number of object literals the anchors opened. */
  readonly literalCount: number;
  /** The depth-1 property names across every anchored literal, sorted. */
  readonly keys: string[];
}

/**
 * Skip a quoted string in TypeScript source, backslash escapes included, and
 * return the index just past its closing quote.
 *
 * @param source - The source text.
 * @param openQuoteIndex - Index of the opening quote character.
 * @returns Index just past the closing quote, or `source.length` if unterminated.
 */
function skipStringLiteral(source: string, openQuoteIndex: number): number {
  const quote = source.charAt(openQuoteIndex);
  let index = openQuoteIndex + 1;

  while (index < source.length) {
    if (source.charAt(index) === "\\") {
      index += 2;
      continue;
    }
    if (source.charAt(index) === quote) {
      return index + 1;
    }
    index += 1;
  }

  return index;
}

/**
 * Collect the property names at **bracket depth 1** of the object literal that
 * opens at `openBrace`.
 *
 * Depth 1 is the literal's own property list, so a nested object contributes
 * its parent key only: `{ dunning: { attemptCount: 0 } }` yields `dunning`, not
 * `attemptCount` — the doc documents the nested shape in the parent row's
 * `Purpose` cell. Arrays and call parentheses nest the same way, so keys inside
 * `statusHistory: [{ … }]` are not literal properties.
 *
 * Strings are skipped whole, so a comma, brace or colon inside a value can
 * never start a key. Shorthand properties count as keys: the upgrade mint
 * writes `tenantId,` with no colon, and a field written that way would
 * otherwise be invisible to the guard.
 *
 * Comments inside a literal are read as code. Neither mint literal carries one,
 * and a comment that did would surface as a phantom key — a loud red, never a
 * silent pass.
 *
 * @param source - The source text.
 * @param openBrace - Index of the literal's opening `{`.
 * @returns The depth-1 property names, in source order (not deduplicated).
 */
function depthOneKeys(source: string, openBrace: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let index = openBrace;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '"' || char === "'" || char === "`") {
      index = skipStringLiteral(source, index);
      expectKey = false;
      continue;
    }

    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      expectKey = depth === 1;
      index += 1;
      continue;
    }

    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
      index += 1;
      continue;
    }

    if (char === "," && depth === 1) {
      expectKey = true;
      index += 1;
      continue;
    }

    if (expectKey && /[A-Za-z_$]/.test(char)) {
      let nameEnd = index + 1;
      while (nameEnd < source.length && /[\w$]/.test(source.charAt(nameEnd))) {
        nameEnd += 1;
      }
      keys.push(source.slice(index, nameEnd));
      let valueStart = nameEnd;
      while (valueStart < source.length && /\s/.test(source.charAt(valueStart))) {
        valueStart += 1;
      }
      index = source.charAt(valueStart) === ":" ? valueStart + 1 : nameEnd;
      expectKey = false;
      continue;
    }

    index += 1;
  }

  return keys;
}

/**
 * Scan one source file for the object literals it writes and return the
 * property names at depth 1.
 *
 * An **anchor** is the code that opens a write, e.g. `subscriptions.insertOne(`
 * or `$set:`. Every occurrence of an anchor is scanned, and the literal is the
 * first `{` at or after the anchor, so `$set: {` and `$set:\n{` are the same
 * anchor. Anchors keep the scan blind to unrelated literals in the same file
 * (`findOne` filters, audit payloads), which a bare `{` sweep would count.
 *
 * @param source - One route file's whole text.
 * @param anchors - The write-opening substrings to scan for.
 * @returns The literal count and the sorted, duplicate-free key set.
 */
export function scanWrittenFields(source: string, anchors: readonly string[]): WrittenFieldReport {
  const keys: string[] = [];
  let literalCount = 0;

  for (const anchor of anchors) {
    let from = 0;
    for (;;) {
      const anchorIndex = source.indexOf(anchor, from);
      if (anchorIndex === -1) {
        break;
      }
      const openBrace = source.indexOf("{", anchorIndex);
      if (openBrace === -1) {
        throw new Error(`The anchor \`${anchor}\` opens no object literal.`);
      }
      keys.push(...depthOneKeys(source, openBrace));
      literalCount += 1;
      from = openBrace + 1;
    }
  }

  return { literalCount, keys: [...new Set(keys)].sort() };
}
