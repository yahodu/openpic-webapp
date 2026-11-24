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
 * **Key shapes (OP-140 follow-up).** `depthOneKeys` reads every way a literal
 * can name a depth-1 property, because a shape it skips is a field the guard
 * cannot see: quoted keys and static template keys are read as names, and a
 * computed name fails closed instead of being dropped. See `depthOneKeys` for
 * the decision and its rationale; the shape matrix is pinned, one case per row,
 * in the sibling spec.
 *
 * **Comments are not code (OP-140 follow-up).** A `//` run to the end of the
 * line and a `/*`-opened block comment are skipped whole: a comment never names
 * a property, and its first word must not take the key position, because then
 * the property after it would never be examined. The earlier posture — read the
 * comment as code and let its first word surface as a phantom key — was
 * replaced because the phantom is only loud for some comment shapes (a
 * documented first word, a numbered comment and a block comment were all
 * silent). The comment matrix is pinned, one case per row, in the sibling spec;
 * why the real-tree census does not move is stated there.
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
 * The error for a depth-1 property name that cannot be resolved from the text.
 *
 * Fail closed: a computed name (`[key]`, `` `${key}` ``) or an inline literal
 * spread (`...{ … }`) is not resolved by this reader, so a set returned without
 * it would look complete while an undocumented field was written — the
 * silent-pass class the guard exists to close. The message names the literal's
 * line so the route file can be opened straight away.
 *
 * @param source - The source text.
 * @param openBrace - Index of the literal's opening `{`.
 * @param reason - What the unresolved shape does, as a clause of the message.
 * @returns The error to throw.
 */
function unresolvedKeyError(source: string, openBrace: number, reason: string): Error {
  const line = source.slice(0, openBrace).split("\n").length;

  return new Error(
    `The object literal opened at line ${String(line)} ${reason}, so the written ` +
      "field set cannot be resolved from the text."
  );
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
 * String **values** are skipped whole, so a comma, brace or colon inside one
 * can never start a key. Shorthand properties count as keys: the upgrade mint
 * writes `tenantId,` with no colon, and a field written that way would
 * otherwise be invisible to the guard.
 *
 * **Quoted, template and computed keys.** A string at key position that is
 * followed (after optional whitespace) by `:` is a property name: the quotes
 * are stripped and the name counts, so `{ "taxMinor": 0, status }` reports
 * `taxMinor` as well as `status`. A template literal with no interpolation is
 * read the same way (`` `taxMinor`: 0 ``); one that does interpolate is a
 * computed name. A **computed** name — `[TAX_KEY]: 1`, or the interpolated
 * template — throws, deliberately: the name is not in the text, so a set
 * returned here would omit a field that was really written, and an incomplete
 * set makes `written − meta ⊆ documented` pass while an undocumented field
 * ships. That is the `checkout`/`currency` drift class this module exists to
 * close. Failing closed costs a red until a human names the field or teaches
 * the parser the shape; failing open costs a silent undocumented write. (Escape
 * sequences inside a quoted key are kept verbatim — a key that used one would
 * surface as a phantom name, never as a silent pass.)
 *
 * An **inline literal spread** (`...{ … }`) is refused for the same reason: its
 * keys belong to this literal's own property list, and this reader stops at the
 * nested brace, so returning a set would omit them.
 *
 * Comments are **not** code, so they are skipped whole: a `//` run to the end
 * of the line, and a `/*`-opened block comment through its closing delimiter.
 * A comment never contributes a key, and `expectKey` is left untouched across
 * one, so the property after the comment is still read. The earlier posture —
 * read the comment as code and let its first word surface as a phantom key —
 * was replaced because the phantom is only loud for *some* comment shapes: after
 * `// status is derived at mint` (a documented first word) the scanner returned
 * `["status"]` and the undocumented `taxMinor` after it was never examined; a
 * numbered comment returned no phantom at all; and a block comment whose first
 * word was the documented `currency` hid `billingCycle`. A comment taking the
 * key position therefore swallowed the next property in silence, the exact
 * fail-open this reader exists to prevent.
 *
 * **Measured limitation, and the boundary the sibling spec pins (OP-140
 * follow-up).** The block-comment branch cannot tell code from a value: a `/`
 * followed by `*` in a value expression — reachable only through a regex literal
 * such as `/[/*]/` — opens a skip that resumes at the nearest closing delimiter,
 * and this reader never re-examines what it stepped over. Keys are lost only
 * when that span crosses a **property boundary**, i.e. when it holds a `:` or a
 * top-level `,` outside strings; a *complete* comment written after a key's
 * colon and before its value is parser-safe **when its own text carries no
 * property shape** (no `:` and no top-level `,`), because the skip then ends
 * before the next property boundary and the next property is still read. A
 * comment is prose, not code, so a colon or a comma inside its *text* names no
 * property either; the sibling spec's marker detector must therefore measure
 * that span against the comment's text, and its matrix pins the three prose
 * shapes (`Cents, billed monthly`, `see the note: billed`, `{a: 1}`) as exempt.
 * No `subscriptions` write can hold
 * a regex and §14.3 documents no such field, so the sibling spec reddens on a
 * marker whose skip crosses a boundary inside an anchored mint literal, and on a
 * marker the literal never closes — not on the value position alone. The two
 * shapes this branch handles correctly are deliberately not banned there: a
 * marker inside a quoted string value never reaches this branch (the string is
 * consumed at its opening quote), and a complete block comment where a property
 * may start is skipped whole with `expectKey` intact, so the property after it
 * is still read.
 *
 * A spread and a method shorthand report their target or modifier the same way
 * (`...baseDoc` reports `baseDoc`, `async markPaid() {}` reports `async`):
 * phantom, loud, safe.
 *
 * @param source - The source text.
 * @param openBrace - Index of the literal's opening `{`.
 * @returns The depth-1 property names, in source order (not deduplicated).
 * @throws If a depth-1 property name is computed and so cannot be resolved.
 */
function depthOneKeys(source: string, openBrace: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let index = openBrace;

  while (index < source.length) {
    const char = source.charAt(index);

    if (char === '"' || char === "'" || char === "`") {
      const stringEnd = skipStringLiteral(source, index);
      let valueStart = stringEnd;
      while (valueStart < source.length && /\s/.test(source.charAt(valueStart))) {
        valueStart += 1;
      }

      // A string at key position that a colon follows is a property name, not a
      // value: strip its quotes (or backticks) and count it.
      if (expectKey && source.charAt(valueStart) === ":") {
        const closed = stringEnd - 1 > index && source.charAt(stringEnd - 1) === char;
        const name = source.slice(index + 1, closed ? stringEnd - 1 : stringEnd);
        if (char === "`" && name.includes("${")) {
          throw unresolvedKeyError(
            source,
            openBrace,
            "writes a computed property name (an interpolated template key)"
          );
        }
        keys.push(name);
      }

      index = stringEnd;
      expectKey = false;
      continue;
    }

    // A comment is not code. Skip it whole and leave `expectKey` as it is, so
    // the property after the comment is still read: letting the comment's first
    // word take the key position would consume that position and hide the
    // property (see the TSDoc for the measured shapes this replaced).
    if (char === "/" && source.charAt(index + 1) === "/") {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }

    if (char === "/" && source.charAt(index + 1) === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }

    if (char === "[") {
      // Only a `[` that would open a property name is refused; an array value
      // (`externalRefs: [...]`) reaches here with `expectKey` false.
      if (expectKey && depth === 1) {
        throw unresolvedKeyError(
          source,
          openBrace,
          "writes a computed property name (a bracketed key)"
        );
      }
      depth += 1;
      expectKey = false;
      index += 1;
      continue;
    }

    if (char === "{") {
      // A `{` at key position is only an inline literal spread (`...{ … }`):
      // its keys are this literal's own, and this reader stops at the nested
      // brace, so refusing beats returning a set that omits them.
      if (expectKey && depth === 1) {
        throw unresolvedKeyError(
          source,
          openBrace,
          "spreads an inline object literal (its keys belong to this literal)"
        );
      }
      depth += 1;
      expectKey = depth === 1;
      index += 1;
      continue;
    }

    if (char === "(") {
      depth += 1;
      expectKey = false;
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
