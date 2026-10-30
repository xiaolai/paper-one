import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LEDGER'S TABLE PARSER, HELD TO THE TWO ROWS THAT BROKE IT.
 *
 * `gen-feature-ledger.py` renders the companion view of
 * `dev-docs/feature-ledger.md`, and its `cells()` has silently truncated a
 * cell twice — once in its naive first version, once in the fix for that:
 *
 *   1. `split('|')` cut `MarkKind is highlight \| companion` in half.
 *   2. `re.split(r'(?<!\\)\|', row.strip().strip('|'))`, the cure, did two
 *      new versions of the same thing. `strip('|')` removes trailing pipes by
 *      the CHARACTER, so a row ending in an escaped pipe lost it and kept a
 *      dangling backslash; and a lookbehind cannot tell an escaped pipe from
 *      a real delimiter that happens to follow an escaped backslash.
 *
 * Neither failure raises anything — no missing row, no error, just a sentence
 * that stops halfway in a generated page nobody diffs. So the parser is
 * exercised directly rather than through the generator, which would go on
 * reporting "123 capabilities" either way.
 *
 * Driven through `python3` because the parser is Python and duplicating it in
 * JavaScript to test it would make the copy the thing under test — the exact
 * mistake the generator's own module docstring records about the ledger data.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'gen-feature-ledger.py')

/** `cells(row)` for each row, as the script itself computes it. */
function cells(rows) {
  const program = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("ledger", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps([module.cells(row) for row in json.loads(sys.argv[2])]))',
  ].join('\n')
  /* `-B`, so importing the script does not leave a `scripts/__pycache__/`
     behind. Nothing gitignores it, and a test that dirties the working tree
     every time it runs is a test people learn to ignore the output of. */
  const run = spawnSync('python3', ['-B', '-c', program, SCRIPT, JSON.stringify(rows)], { encoding: 'utf8' })
  if (run.error) throw new Error(`python3 could not run: ${run.error.message}`, { cause: run.error })
  if (run.status !== 0) throw new Error(`python3 failed (exit ${run.status ?? `signal ${run.signal}`}): ${run.stderr}`)
  return JSON.parse(run.stdout)
}

/* The interpreter the script's shebang names. Absent, the suite says so
   rather than passing — `context.skip` keeps the case in what Vitest
   COLLECTS, which is what the test ledger reads (WI-20.38). */
const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const havePython = probe.error === undefined && probe.status === 0

describe('the ledger’s Markdown table parser', () => {
  it('is exercised against the real script, so this is not a copy of it', (context) => {
    if (!havePython) return context.skip('python3 is not on PATH')
    expect(cells(['| a | b |'])).toEqual([['a', 'b']])
  })

  /* Row 1 of the two the audit named. `strip('|')` ate the escaped pipe's own
     `|` and left `ends with \`. */
  it('keeps an escaped pipe that ends the last cell of a row', (context) => {
    if (!havePython) return context.skip('python3 is not on PATH')
    expect(cells([String.raw`| a | ends with \||`])).toEqual([['a', 'ends with |']])
  })

  /* Row 2. `\\` is an escaped BACKSLASH, so the pipe after it delimits — the
     lookbehind saw a backslash and refused to split, yielding one cell. */
  it('splits on a delimiter that follows an escaped backslash', (context) => {
    if (!havePython) return context.skip('python3 is not on PATH')
    expect(cells([String.raw`| path C:\\| next |`])).toEqual([['path C:\\', 'next']])
  })

  it('still carries the cell the parser was originally written for', (context) => {
    if (!havePython) return context.skip('python3 is not on PATH')
    expect(cells([String.raw`| MarkKind is highlight \| companion | x |`])).toEqual([
      ['MarkKind is highlight | companion', 'x'],
    ])
  })

  /* GFM's outer pipes are optional, and an empty cell is a cell. A blind
     `[1:-1]` would drop the trailing empty one and make the row short, which
     `parse()` reports as a column-count mismatch against the header. */
  it('treats the outer pipes as optional and an empty cell as a cell', (context) => {
    if (!havePython) return context.skip('python3 is not on PATH')
    expect(cells(['a | b', '| a | b', '| a |  |'])).toEqual([
      ['a', 'b'],
      ['a', 'b'],
      ['a', ''],
    ])
  })
})
