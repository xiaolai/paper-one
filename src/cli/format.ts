import type { ServiceDescriptor } from '../kernel'

/**
 * What `paper` prints (WI-11.4).
 *
 * `--json` IS THE POINT, and the human format is the convenience beside it.
 * A library of two thousand books is not something a person reads off a
 * terminal — it is something a script filters, counts and diffs — and the
 * plan asks for `--json` on everything for exactly that reason. So the JSON
 * shape is the CONTRACT: whole rows, no elision, one array for a stream, the
 * answer verbatim for a `req`. Nothing here narrows what is available.
 *
 * The human format narrows what is READABLE, which is a different job: a book
 * row carries eighteen fields and a terminal shows four of them usefully.
 * Which four is declared in the table's own `output.columns`, so this file
 * holds no per-service knowledge at all.
 */

/**
 * Control characters, replaced before anything reaches a terminal.
 *
 * A book's title, an author, a highlight's text and a note are all strings
 * SOMEBODY ELSE WROTE — a publisher, an EPUB, or, over `--shelf`, another
 * device. A terminal reads C0 and C1 control sequences out of ordinary
 * output: an ANSI escape can repaint the line above, hide what a command
 * actually printed, or reach a terminal feature that answers back. Nothing in
 * this API needs to emit one, so the whole class goes.
 *
 * `--json` is untouched: `JSON.stringify` escapes control characters as
 * `\u00XX` already, and a consumer decoding that JSON is not a terminal.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * One line of text, safe to write to a terminal.
 *
 * Exported because the ERROR path needs it too: a refusal's `code` and
 * `message` come off the wire on `--shelf`, and sanitising the answer while
 * printing the failure raw would leave the hole open on the path a caller
 * reaches by doing something wrong — which is the easier one to trigger.
 */
export function plain(text: string): string {
  return text.replace(/[\t\r\n\u2028\u2029]+/g, ' ').replace(CONTROL, '\uFFFD')
}

/** A cell as a person reads it. `null` is written out, because in this API
 *  `null` means "nobody can say" and blank would read as zero or as empty. */
function cell(value: unknown): string {
  if (value === null) return '—'
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.map((one) => cell(one)).join(', ')
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return plain(JSON.stringify(value))
  /* A CELL IS ONE LINE. A tab would break the column and a newline would
   * break the ROW — an embedded one in a title turns a table into as many
   * extra lines as the title contains, which is the same "somebody else's
   * string reaches the terminal" hole the control class above closes.
   * Everything else in the class becomes the replacement character, which is
   * visible rather than silent. */
  return plain(String(value))
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The columns to show: the table's choice, else every scalar key present. */
function columnsFor(descriptor: ServiceDescriptor, rows: readonly Record<string, unknown>[]): readonly string[] {
  const declared = descriptor.output.columns
  if (declared) return declared
  const seen: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key)
  }
  return seen
}

/**
 * Rows as a padded table.
 *
 * Padded on the LAST column too — no. The last column is not padded, so a
 * line has no trailing spaces: a transcript diffed between two machines
 * should differ where the data differs, and trailing whitespace is a
 * difference that means nothing.
 */
/**
 * The widest a padded column may be, in characters.
 *
 * PADDING AMPLIFIES, and this is the bound on it. Every row is padded to the
 * widest cell in its column, so ONE long value in a non-final column widens
 * every other row to match: two thousand rows with a single ten-thousand
 * character title turned 46 KB of data into 20 MB of table — measured, a 435×
 * blow-up — and the CLI built the whole string in memory before printing a
 * line of it.
 *
 * Over-long cells are cut here and marked with an ellipsis. That is a
 * narrowing of what is READABLE, not of what is available: `--json` prints
 * whole rows with no elision, which is the contract this file's own note
 * opens with. A terminal was never going to show ten thousand characters of
 * one cell usefully.
 */
const MAX_COLUMN = 200

/** The widest of `values`, without spreading them into an argument list. */
function widest(header: number, values: readonly string[]): number {
  let most = header
  for (const value of values) if (value.length > most) most = value.length
  return most
}

export function table(descriptor: ServiceDescriptor, rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const columns = columnsFor(descriptor, rows)
  const body = rows.map((row) => columns.map((key) => clip(cell(row[key]))))
  /* ITERATIVE, NOT SPREAD. `Math.max(key.length, ...body.map(…))` passes one
   * ARGUMENT PER ROW, and the engine's argument limit is far below the number
   * of rows a library holds: measured, this threw `RangeError: Maximum call
   * stack size exceeded` at about 125 000 rows — so `paper mark list` on a
   * heavily annotated library crashed with a stack overflow instead of
   * printing, on ordinary local data with no remote involved. */
  const widths = columns.map((key, at) => widest(key.length, body.map((line) => line[at] ?? '')))
  const line = (cells: readonly string[]): string =>
    cells
      .map((value, at) => (at === cells.length - 1 ? value : value.padEnd(widths[at] ?? 0)))
      .join('  ')
      .trimEnd()
  return [line(columns), line(widths.map((width) => '─'.repeat(width))), ...body.map(line)].join('\n')
}

/** A cell, cut to `MAX_COLUMN` and marked when it was. */
function clip(value: string): string {
  return value.length <= MAX_COLUMN ? value : `${value.slice(0, MAX_COLUMN - 1)}…`
}

/** One answer as `key: value` lines, in the order the object gives them. */
export function fields(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  /* ⚠️ **`Math.max(0, ...keys.map(…))` PASSES ONE ARGUMENT PER KEY**, and the
   * engine's argument limit is finite — measured at about 125 000. `table` was
   * fixed for exactly this and `widest` was extracted for it; this call site
   * kept the spread, so the same defect survived the fix that named it.
   *
   * A row with a hundred thousand keys is not what any service returns today.
   * That is an argument about the DATA, not about the code: the bound here was
   * an engine limit nobody chose, reached by an object that is otherwise
   * perfectly ordinary, and the loop costs nothing. */
  const width = widest(0, keys)
  return keys.map((key) => `${key.padEnd(width)}  ${cell(value[key])}`.trimEnd()).join('\n')
}

/**
 * The answer, printed.
 *
 * `--json` prints the value verbatim and nothing else — no heading, no count
 * — so `paper book list --json | jq` works without a filter to strip
 * decoration. Two spaces of indent, and a trailing newline, so a transcript
 * is readable and `diff` has lines to compare.
 */
export function render(descriptor: ServiceDescriptor, value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value ?? null, null, 2)
  if (Array.isArray(value)) {
    if (value.length === 0) return 'nothing'
    return value.every(isRow) ? table(descriptor, value) : value.map((one) => cell(one)).join('\n')
  }
  if (isRow(value)) return fields(value)
  return cell(value)
}
