import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A test file's ENVIRONMENT must be declared where a reader looks, because
 * Vitest reads it from anywhere in the file.
 *
 * ⚠️ **`speech.test.ts` RAN 43 CASES IN jsdom WHILE ITS OWN HEADER ARGUED IT HAD
 * NO DOM, AND THE HEADER IS WHAT PUT IT THERE.** Vitest finds the environment by
 * matching a regular expression against the WHOLE FILE — not the first line, not
 * the leading docblock — so a sentence explaining which token a file would opt in
 * with WAS that token. The file had a `document`, one case used it, and three
 * paragraphs of reasoning about running under `node` were false.
 *
 * It is the same shape as this repository's `Stryker disable` trap, recorded in
 * AGENTS.md: to a grep it is a directive, to the tool it is prose. The fix is the
 * same both times — ask the tool, not the text — and this is the asking.
 *
 * ⚠️ **THE NEEDLE IS ASSEMBLED FROM HALVES, and a check of this shape that spells
 * it out matches ITSELF.** `reanchor.source.test.ts` learned that: a test that
 * searches the tree for a string is in the tree. Joining the halves is the whole
 * fix, and it is why no path is excluded from the walk below — excluding this
 * file would hide a real declaration added to it later.
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = ['@vitest', 'environment'].join('-')
/** Vitest's own, from `vitest/src/node/plugins/…`: `@vitest|jest`, then a word. */
const PRAGMA = new RegExp(`@(?:vitest|jest)${'-'}environment\\s+?([\\w-]+)`, 'u')

const SCAN = ['src', 'scripts']
const IS_TEST = /\.test\.[^./]+$/u

function testFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(at)
      else if (IS_TEST.test(entry.name)) found.push(at)
    }
  }
  for (const root of SCAN) walk(path.join(REPO_ROOT, root))
  return found.sort()
}

/**
 * How much of the file is the LEADING comment block — blank lines, `//` lines
 * and `/* … *\/` blocks, up to the first line of code.
 *
 * Deliberately crude, and the crudeness is safe in the direction that matters: a
 * declaration this misses is reported, and a reader then moves it to line 1,
 * where nothing can miss it.
 */
function leadingComment(source) {
  let chars = 0
  let inBlock = false
  for (const line of source.split('\n')) {
    const text = line.trim()
    if (inBlock) {
      chars += line.length + 1
      if (text.includes('*/')) inBlock = false
      continue
    }
    if (text === '' || text.startsWith('//')) {
      chars += line.length + 1
      continue
    }
    if (text.startsWith('/*')) {
      chars += line.length + 1
      if (!text.includes('*/')) inBlock = true
      continue
    }
    break
  }
  return chars
}

/**
 * Whether this source names the environment somewhere Vitest will read and a
 * reader will not — `null` when it names it nowhere, which decides nothing.
 */
function decidedByProse(source) {
  const match = PRAGMA.exec(source)
  if (!match) return null
  return match.index >= leadingComment(source)
}

describe('every test file declares its environment where Vitest looks first', () => {
  it('has no file whose environment is decided by prose', () => {
    const offenders = testFiles()
      .filter((file) => decidedByProse(readFileSync(file, 'utf8')) === true)
      .map((file) => path.relative(REPO_ROOT, file))
    expect(
      offenders,
      'a mention of the token anywhere in a file IS the declaration — move it to the leading comment, or say it another way',
    ).toEqual([])
  })

  /* ⚠️ **AND THE FAILURE DIRECTION, WHICH IS THE ONE THAT MATTERS.** The case
     above passes on a tree that is clean and on a check that cannot see
     anything; this is the file as it actually was — the declaration removed from
     line 1, the prose left where it stood — and the check has to call it out. No
     fixture on disk, because a `*.test.mjs` under `scripts/` is collected and
     run: the defect is reproduced in memory instead. */
  it('reports the shape the file had, and passes the shape it has', () => {
    const speech = readFileSync(path.join(REPO_ROOT, 'src/kernel/ui/reader/speech.test.ts'), 'utf8')
    expect(decidedByProse(speech), 'the real file, as it is today').toBe(false)

    /* The historical shape, reassembled: imports first, and then a header
       sentence explaining what a file would opt in WITH. That sentence was the
       opt-in. The real file cannot serve as this fixture any more — its header
       deliberately never writes the token out — so the shape is rebuilt from
       the same halves this check's own needle is made of. */
    const asItWas = `import { it } from 'vitest'\n\n/**\n * files opt in with \`// ${TOKEN} jsdom\`, so adding it here is one line.\n */\n`
    expect(decidedByProse(asItWas), 'prose after the imports decides it').toBe(true)
    expect(decidedByProse(`// ${TOKEN} jsdom\n${asItWas}`), 'declared first, and it does not').toBe(
      false,
    )
  })

  /* ⚠️ **THE KNOWN POSITIVE, because a detector that finds nothing looks exactly
     like a clean result.** The case above asserts an empty list, so a walk that
     read no files and a walk that read every one are told apart only here: the
     token really is in the tree, the regular expression really does match it,
     and it really is inside a leading comment where it is declared properly. */
  it('finds the declarations that are there, which is what makes the empty list evidence', () => {
    const declared = testFiles().filter((file) => PRAGMA.test(readFileSync(file, 'utf8')))
    expect(declared.length, `no file in the tree contains ${TOKEN}`).toBeGreaterThan(10)

    const speech = readFileSync(path.join(REPO_ROOT, 'src/kernel/ui/reader/speech.test.ts'), 'utf8')
    expect(PRAGMA.exec(speech)?.[1], 'the file this check was written for').toBe('jsdom')
    expect(PRAGMA.exec(speech).index, 'and it declares it on the first line').toBeLessThan(
      leadingComment(speech),
    )
  })
})
