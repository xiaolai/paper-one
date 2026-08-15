/**
 * Reads a module's own source back and strips it down to code, so a test can
 * assert that an identifier appears nowhere but the prose.
 *
 * Test-only. The `.testkit.ts` suffix is deliberate: vitest collects
 * `*.test.ts` and `*.spec.ts`, so this file is imported by tests without being
 * run as one, and nothing in `src/` imports it, so it never reaches a bundle.
 *
 * It lives here rather than inside a single test file because two modules in
 * this directory — `classify.ts` and `snapWordRange.ts` — both have to prove
 * they are DOM-free, and two copies of a hand-written scanner is one scanner
 * that drifts.
 */

/** Comments and string contents removed, so a scan for identifiers cannot be
 *  answered by the module's own prose. Both outputs come from one pass because
 *  a `//` inside a string literal is not a comment, and a quote inside a
 *  comment does not open a string. */
export function scan(source: string): { withoutComments: string; codeOnly: string } {
  let withoutComments = ''
  let codeOnly = ''
  let i = 0
  while (i < source.length) {
    const pair = source.slice(i, i + 2)
    if (pair === '//') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (pair === '/*') {
      i += 2
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1
      i += 2
      continue
    }
    const char = source[i] ?? ''
    if (char === "'" || char === '"' || char === '`') {
      const opened = i
      i += 1
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      withoutComments += source.slice(opened, i)
      codeOnly += char + char
      continue
    }
    withoutComments += char
    codeOnly += char
    i += 1
  }
  return { withoutComments, codeOnly }
}

/** Every module specifier the source imports from. */
export function importSpecifiers(withoutComments: string): string[] {
  const matches = withoutComments.matchAll(/\bimport\b[^;\n]*?['"]([^'"]+)['"]/g)
  return [...matches].map((match) => match[1] ?? '')
}

/** Word-bounded on purpose: `RangeError` is not `Range`, and a module that
 *  throws one must not trip a purity scan. */
export const DOM_IDENTIFIERS = /\b(document|window|Selection|Range|Node|getComputedStyle)\b/g
