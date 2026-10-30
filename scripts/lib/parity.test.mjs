import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asAsciiJson, evaluateSnippet, readReport } from './parity.mjs'

/**
 * The three things both parity harnesses do the same way.
 *
 * ⚠️ **THEY WERE TWO COPIES, AND `asAsciiJson` WAS IDENTICAL TO THE BYTE.**
 * Two harnesses that disagree about what "escaped down to ASCII", "evaluated
 * away from this realm" or "a report that arrived" means is one defect in two
 * files — and the copies had already begun to drift: only one of the two
 * evaluators could be given a timeout, so only one of them could be tested for
 * giving up at all.
 */

/** One directory for the whole file, made before its first case and removed
 *  after its last. NOT at module scope: collecting a file runs its body and no
 *  hook — `vitest list` does exactly that, and `pnpm test:ledger` runs it, and
 *  so does a run whose name filter leaves no case here — so a directory made
 *  there was left behind each time. */
let scratch
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'parity-lib-'))
})
let written = 0
function tempFile(name, contents) {
  written += 1
  const path = join(scratch, `${written}-${name}`)
  writeFileSync(path, contents, 'utf8')
  return path
}

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
})

/** What a throw leaves behind, or `null` when nothing was thrown. */
function thrownBy(act) {
  try {
    act()
    return null
  } catch (cause) {
    return cause
  }
}

describe('rows escaped down to printable ASCII', () => {
  /*
   * The corpora carry soft hyphens, no-break spaces, a line feed, Han and kana,
   * and lone astral characters. Every one of them is something a transport, a
   * terminal or a copy-paste can eat — and the failure would look like a
   * segmentation divergence rather than like the mangling it is.
   */
  it('escapes everything outside printable ASCII and still parses back to the rows it was given', () => {
    const rows = [
      { id: 'soft', raw: 'co\u00adoperate' },
      { id: 'kana', raw: 'これは。' },
      { id: 'feed', raw: 'one\ntwo' },
    ]

    const text = asAsciiJson(rows)

    expect(text.match(/[^\x20-\x7E\n]/gu)).toBeNull()
    expect(runInNewContext(text)).toEqual(rows)
    /* Non-vacuity: the rows really do carry those characters, so ASCII-only
       output means they were escaped rather than that there was nothing to
       escape. */
    expect(rows.some((row) => /[^\x20-\x7E]/u.test(row.raw))).toBe(true)
  })

  /*
   * Each row's COMPACT JSON, never a pretty-printed document: in pretty-printed
   * output the newlines between fields are structure rather than data, and
   * escaping those emits a U+000A escape where the parser needs a real line
   * break — a snippet that fails at parse. Measured, not hypothetical: it is
   * what the first draft of this did.
   */
  it('writes one row per line, and the empty corpus as an empty list', () => {
    expect(asAsciiJson([])).toBe('[]')
    expect(asAsciiJson([{ a: 1 }, { b: 2 }])).toBe('[\n  {"a":1},\n  {"b":2},\n]')
  })
})

describe('a snippet evaluated away from this realm', () => {
  it('brings the value back as plain data of THIS realm', () => {
    const report = evaluateSnippet('(function () { return { ok: true, rows: [1, 2] } })()\n')

    expect(report).toEqual({ ok: true, rows: [1, 2] })
    /* The JSON round-trip is not cosmetic: it is what proves the report crossed
       out of the vm, and that the bridge could carry it. */
    expect(Object.getPrototypeOf(report)).toBe(Object.prototype)
  })

  /* Self-contained means self-contained: the snippet has to run in a webview,
     where there is no resolver to fall back on. */
  it('gives the snippet no module resolver to reach for', () => {
    const cause = thrownBy(() => evaluateSnippet("(function () { return require('node:fs') })()\n"))

    expect(types.isNativeError(cause)).toBe(true)
    expect(cause.message).toMatch(/require is not defined/u)
  })

  /*
   * A snippet that never returns has to become an error, not a harness that
   * hangs. The loop gives up by itself after a second, so a missing timeout
   * fails this case rather than hanging it.
   *
   * `isNativeError`, not `toBeInstanceOf(Error)`: Node builds this one in its
   * own realm, so `instanceof` against the test's `Error` says no to a real one.
   */
  it('gives up on a snippet that does not return in time', () => {
    const stuck =
      '(function () { const end = Date.now() + 1000; while (Date.now() < end) {} return { ok: true }; })()\n'

    const cause = thrownBy(() => evaluateSnippet(stuck, { timeout: 20 }))

    expect(types.isNativeError(cause)).toBe(true)
    expect(cause.code).toBe('ERR_SCRIPT_EXECUTION_TIMEOUT')
  })
})

describe('the report a webview sent back', () => {
  it('reads a report from a file, and from a descriptor when the path is -', () => {
    const report = { ok: true, rows: [{ id: 'a' }] }
    const file = tempFile('report.json', JSON.stringify(report))

    expect(readReport(file, 0)).toEqual(report)

    const descriptor = openSync(tempFile('stdin.json', JSON.stringify(report)), 'r')
    try {
      expect(readReport('-', descriptor)).toEqual(report)
    } finally {
      closeSync(descriptor)
    }
  })

  /*
   * ⚠️ NO REPORT IS NOT A PASS — it is a run that did not happen, and in a
   * summary the two look identical unless something says so. Whitespace is as
   * empty as nothing, and a file of it used to parse as `undefined` rather than
   * refuse.
   */
  it('refuses a report that is blank, in its own words', () => {
    for (const blank of ['', ' \n\t\n']) {
      const cause = thrownBy(() => readReport(tempFile('blank.json', blank), 0))

      expect(cause).toBeInstanceOf(Error)
      expect(cause.message).toBe('the report is empty')
    }
  })

  it('refuses a report that is not JSON, rather than answering with nothing', () => {
    const cause = thrownBy(() => readReport(tempFile('half.json', '{"ok": tr'), 0))

    expect(types.isNativeError(cause)).toBe(true)
    expect(cause.name).toBe('SyntaxError')
  })
})
