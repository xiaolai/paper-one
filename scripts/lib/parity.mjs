/**
 * What both cross-engine parity harnesses do the same way.
 *
 * `word-snap-parity.mjs` and `sentence-parity.mjs` ask different questions of
 * different corpora, and each keeps its own driver and its own comparison. What
 * they share is the plumbing around those: getting rows into a snippet intact,
 * running a snippet away from this realm, and reading back the report a webview
 * sent.
 *
 * ⚠️ **THEY WERE TWO COPIES, AND `asAsciiJson` WAS IDENTICAL TO THE BYTE.** Two
 * harnesses that disagree about what "escaped down to ASCII" means is one
 * defect in two files, and the copies had already begun to drift: only one of
 * the two evaluators could be handed a timeout, so only one of them could be
 * tested for giving up at all — the other's thirty seconds were unreachable
 * from any test. The reading of a report had drifted the same way: one took its
 * stdin as an argument, so a test could hand it an open file, and the other
 * reached for descriptor 0 itself.
 */

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

/**
 * JSON, escaped down to printable ASCII.
 *
 * The corpora carry a soft hyphen, a no-break space, a word joiner, a
 * zero-width joiner, a line feed, lone astral characters, Han and kana.
 * Emitting those raw into a JS string literal is asking for one of them to be
 * eaten by a transport, a terminal or a copy-paste — and the failure would look
 * like a segmentation divergence rather than like the mangling it is. Escaped,
 * the snippet is pure ASCII and says the same thing everywhere.
 *
 * Applied to each row's COMPACT JSON, never to a pretty-printed document: in
 * pretty-printed output the newlines between fields are structure rather than
 * data, and escaping those emits a U+000A escape where the parser needs an
 * actual line break — a snippet that fails at parse. Measured, not
 * hypothetical: it is exactly what the first draft of this function did.
 */
export function asAsciiJson(rows) {
  const escape = (text) =>
    text.replace(/[^\x20-\x7E]/g, (character) => {
      return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    })
  if (rows.length === 0) return '[]'
  return '[\n  ' + rows.map((row) => escape(JSON.stringify(row))).join(',\n  ') + ',\n]'
}

/**
 * Evaluate a snippet here, in a context with no module resolver.
 *
 * The JSON round-trip is not cosmetic: it brings the report out of the vm's
 * realm and, more usefully, proves the report is something the MCP bridge can
 * actually serialise. A report the bridge mangles is a report that arrives
 * looking like a divergence.
 *
 * The timeout turns a snippet that never returns into an error rather than a
 * harness that hangs. It is a parameter so a test can watch it fire in
 * milliseconds instead of waiting out the thirty seconds.
 */
export function evaluateSnippet(snippet, { timeout = 30000 } = {}) {
  return JSON.parse(JSON.stringify(runInNewContext(snippet, undefined, { timeout })))
}

/**
 * A webview's report, from a path or — for `-` — from `stdin`, which is a file
 * descriptor read by the same call as a path.
 *
 * Blank is refused in its own words. No report is not a pass: it is a run that
 * did not happen, and in a summary the two look identical unless the exit code
 * separates them. A file of whitespace parses as nothing rather than as a
 * report, which is the same silence one step further on.
 */
export function readReport(path, stdin) {
  const raw = readFileSync(path === '-' ? stdin : path, 'utf8')
  if (raw.trim() === '') throw new Error('the report is empty')
  return JSON.parse(raw)
}
