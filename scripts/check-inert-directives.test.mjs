import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  REPO,
  disableDirectives,
  inertDirectives,
  inertStrykerDirectives,
  main,
  sentinelFor,
  sentinelled,
} from './check-inert-directives.mjs'

/**
 * `check-inert-directives`: a suppression is honest only if its tool runs.
 *
 * The gate has to turn on the MANIFEST rather than on the tree, and both
 * directions matter: it must find a directive for a tool nothing declares, and
 * it must go quiet the moment that tool is declared — otherwise installing the
 * linter would leave a check demanding the removal of the very comments the
 * linter needs, and the only way out would be to delete the gate.
 */

const SCRIPT = fileURLToPath(new URL('./check-inert-directives.mjs', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(files, manifest = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'inert-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'f', ...manifest }))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const DISABLE = '// eslint-disable-next-line react-hooks/exhaustive-deps\n'

describe('a suppression with no tool behind it', () => {
  it('is reported, with the file and line', () => {
    const root = fixture({ 'src/a.ts': `const x = 1\n${DISABLE}const y = 2\n` })
    expect(inertDirectives(root).found).toEqual([{ file: 'src/a.ts', line: 2, tool: 'eslint' }])
  })

  it.each([
    ['prettier', '// prettier-ignore\n'],
    ['biome', '// biome-ignore lint/style/noVar: reason\n'],
  ])('covers %s too, not just eslint', (tool, comment) => {
    const root = fixture({ 'src/a.ts': comment })
    expect(inertDirectives(root).found.map((f) => f.tool)).toEqual([tool])
  })
})

describe('a suppression whose tool is declared', () => {
  /* THE HALF THAT MAKES THE GATE SAFE TO ADOPT. Installing ESLint must turn
     this check off by itself; a gate that would then demand the deletion of
     every directive the new linter needs is a gate that gets deleted. */
  it.each([['dependencies'], ['devDependencies']])('is left alone when in %s', (field) => {
    const root = fixture({ 'src/a.ts': DISABLE }, { [field]: { eslint: '^9.0.0' } })
    const { found, live } = inertDirectives(root)
    expect(found).toEqual([])
    expect(live).toEqual(['eslint'])
  })

  it('still reports a DIFFERENT tool that is not declared', () => {
    // Installing one linter says nothing about the others.
    const root = fixture(
      { 'src/a.ts': `${DISABLE}// prettier-ignore\n` },
      { devDependencies: { eslint: '^9.0.0' } },
    )
    expect(inertDirectives(root).found.map((f) => f.tool)).toEqual(['prettier'])
  })

  it('goes quiet for all three at once, each found by its own package name', () => {
    /* One package per tool, and the names differ from the tools' own — biome's
       especially. A test that only ever declares `eslint` leaves the other two
       names free to be anything. */
    const root = fixture(
      { 'src/a.ts': `${DISABLE}// prettier-ignore\n// biome-ignore lint/style/noVar: reason\n` },
      { devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0', '@biomejs/biome': '^2.0.0' } },
    )
    const { found, live } = inertDirectives(root)
    expect(found).toEqual([])
    expect(live).toEqual(['eslint', 'prettier', 'biome'])
  })
})

describe('what the walk reaches', () => {
  it('finds a suppression in a nested directory', () => {
    const root = fixture({ 'src/deep/down/a.ts': DISABLE })
    expect(inertDirectives(root).found).toEqual([
      { file: 'src/deep/down/a.ts', line: 1, tool: 'eslint' },
    ])
  })

  it('reads a stylesheet, where a prettier-ignore is just as inert', () => {
    const root = fixture({ 'src/a.css': '/* prettier-ignore */\n.a { color: red }\n' })
    expect(inertDirectives(root).found).toEqual([{ file: 'src/a.css', line: 1, tool: 'prettier' }])
  })

  it('leaves a file that is not source alone, whatever it says', () => {
    const root = fixture({ 'src/notes.txt': DISABLE })
    expect(inertDirectives(root).found).toEqual([])
  })

  it('does not report itself or its own test', () => {
    /* This file names every pattern it hunts, so without the exclusion it is
       its own finding — and so is the file you are reading. */
    const root = fixture({
      'scripts/check-inert-directives.mjs': DISABLE,
      'scripts/check-inert-directives.test.mjs': DISABLE,
      'scripts/other.mjs': DISABLE,
    })
    expect(inertDirectives(root).found).toEqual([
      { file: 'scripts/other.mjs', line: 1, tool: 'eslint' },
    ])
  })
})

/**
 * THE SECOND RULE: a `Stryker disable` that ignores no mutant.
 *
 * Every fixture below is a string, so the words in it are string CONTENT and
 * never a directive of this file's own — which is one of the things the rule
 * has to get right, and is asserted on its own further down.
 *
 * The three shapes are each written the way they were found on this branch.
 * Each is a real comment in a real position, and Stryker honours none of them.
 */

const ABOVE_CATCH = `export function f(x) {
  try {
    return x + 1
  // Stryker disable next-line BlockStatement: a catch clause takes no leading comment
  } catch {
    return x - 1
  }
}
`

const AFTER_THE_LAST_STATEMENT = `export function f(x) {
  if (x) {
    return x + 1
    // Stryker disable next-line ArithmeticOperator: trails the statement above it
  }
  return 0
}
`

const BETWEEN_CHAINED_CALLS = `export const r = [1, 2]
  .flatMap((x) => [x + 1])
  // Stryker disable next-line ArithmeticOperator: leads no node at all
  .sort((a, b) => a - b)
`

const HONOURED = `export function f(x) {
  // Stryker disable next-line ArithmeticOperator: the next line is a statement, so this one lands
  return x + 1
}
`

const INERT = 'a Stryker disable directive that ignores no mutant'

describe('a Stryker disable that ignores no mutant', () => {
  it.each([
    ['above a catch clause, which takes no leading comment', ABOVE_CATCH, 4],
    ["after a block's last statement, where it trails the one above", AFTER_THE_LAST_STATEMENT, 4],
    ['between two chained calls, where it leads no node', BETWEEN_CHAINED_CALLS, 3],
  ])('is reported %s', async (_shape, body, line) => {
    const root = fixture({ 'src/a.ts': body })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([{ file: 'src/a.ts', line, why: INERT }])
    expect([files, checked]).toEqual([1, 1])
  })

  it('leaves alone one that does ignore a mutant', async () => {
    const root = fixture({ 'src/a.ts': HONOURED })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([])
    expect([files, checked]).toEqual([1, 1])
  })

  it('covers the block form, and reports a mutator that never occurs below it', async () => {
    /* `publish.ts` carried exactly this: a whole-file `disable OptionalChaining`
       over a file with no optional chaining anywhere in it. */
    const root = fixture({
      'src/live.ts': '// Stryker disable ArithmeticOperator: everything below\nexport const a = 1 + 1\n',
      'src/dead.ts': '// Stryker disable OptionalChaining: nothing below uses one\nexport const a = 1 + 1\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([
      { file: 'src/dead.ts', line: 1, why: INERT },
    ])
  })

  it('leaves alone a disable/restore block that ignores something inside it', async () => {
    const root = fixture({
      'src/a.ts':
        '// Stryker disable ArithmeticOperator: inside the block\nexport const a = 1 + 1\n// Stryker restore ArithmeticOperator\nexport const b = 2 + 2\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([])
  })

  it('counts `all` as covering whatever it ignores', async () => {
    const root = fixture({
      'src/a.ts': 'export function f(x) {\n  // Stryker disable next-line all: covers the line below\n  return x + 1\n}\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([])
  })

  it('tells two directives that share a reason apart', async () => {
    /* Matching on the reason's own WORDS would call both of these live. Twelve
       directives in this tree share a reason with another in the same file. */
    const root = fixture({
      'src/a.ts':
        'export function f(x) {\n  // Stryker disable next-line ArithmeticOperator: the same words\n  return x + 1\n}\n' +
        'export function g(x) {\n  if (x) {\n    return x + 2\n    // Stryker disable next-line ArithmeticOperator: the same words\n  }\n  return 0\n}\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([
      { file: 'src/a.ts', line: 8, why: INERT },
    ])
  })

  it('reports one whose reason is blank, which Stryker reads as no reason and leaves live', async () => {
    const root = fixture({
      'src/a.ts':
        'export function f(x) {\n  // Stryker disable next-line ArithmeticOperator:' + '   \n  return x + 1\n}\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([
      { file: 'src/a.ts', line: 2, why: INERT },
    ])
  })

  it.each([
    /* Stryker's regex allows ONE space before the word and makes the reason
       itself optional, so both of these are directives it honours — and a rule
       that demanded a space, or words after the colon, would call them inert. */
    ['written with no space after the slashes', '  //Stryker disable next-line ArithmeticOperator: no space\n'],
    ['ended at a bare colon, which Stryker reads as no reason', '  // Stryker disable next-line ArithmeticOperator:\n'],
  ])('leaves alone one %s', async (_how, directive) => {
    const root = fixture({ 'src/a.ts': `export function f(x) {\n${directive}  return x + 1\n}\n` })
    const { found, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([])
    expect(checked).toBe(1)
  })

  it.each([['ts'], ['tsx'], ['js'], ['jsx'], ['mjs'], ['cjs']])(
    'reads a .%s, because Stryker does',
    async (extension) => {
      const root = fixture({
        [`src/a.${extension}`]: 'function f(x) {\n  if (x) {\n    return x + 1\n    // Stryker disable next-line ArithmeticOperator: trails the statement above it\n  }\n  return 0\n}\n',
      })
      expect((await inertStrykerDirectives(root)).found).toEqual([
        { file: `src/a.${extension}`, line: 4, why: INERT },
      ])
    },
  )

  it('leaves a stylesheet alone, which Stryker cannot read at all', async () => {
    /* `walk` returns `.css` too, for the linter rule above. Handing one to a
       JavaScript parser would make every stylesheet with the word in it an
       unreadable-file finding. */
    const root = fixture({
      'src/a.css': '/* Stryker disable next-line ArithmeticOperator: a stylesheet is not source */\n.a { color: red }\n',
    })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([])
    expect([files, checked]).toEqual([0, 0])
  })

  it('reports one naming a mutator that does not exist', async () => {
    const root = fixture({
      'src/a.ts':
        'export function f(x) {\n  // Stryker disable next-line ArithmaticOperator: a typo names no mutator, so it disables none\n  return x + 1\n}\n',
    })
    expect((await inertStrykerDirectives(root)).found).toEqual([
      { file: 'src/a.ts', line: 2, why: INERT },
    ])
  })
})

describe('what is not a directive', () => {
  /* ⚠️ A COMMENT EXPLAINING THE RULE IS NOT ONE, and neither is a fixture in a
     string. Stryker's regex is anchored to the start of the comment's own text,
     and a string is not a comment at all — so both answers come from asking
     Stryker rather than from a rule about which lines look like directives. */
  it.each([
    [
      'prose in a line comment that merely names one',
      '// A Stryker disable next-line ArithmeticOperator here would ignore nothing.\nexport const a = 1 + 1\n',
    ],
    [
      'prose in a block comment, where the text begins after the opener',
      '/* Worth saying: Stryker disable next-line ArithmeticOperator is not read here. */\nexport const a = 1 + 1\n',
    ],
    [
      'prose in a JSDoc block, whose text begins with a star',
      '/**\n * Stryker disable next-line ArithmeticOperator: prose, because the value starts with a star.\n */\nexport const a = 1 + 1\n',
    ],
    [
      'a directive inside a template literal, the way a test fixture holds one',
      'export const source = `\n// Stryker disable next-line ArithmeticOperator: fixture text\nconst b = 1 + 1\n`\n',
    ],
    [
      'a directive inside a quoted string',
      "export const line = '// Stryker disable next-line ArithmeticOperator: fixture text'\n",
    ],
  ])('does not read %s as one', async (_what, body) => {
    const root = fixture({ 'src/a.ts': body })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([])
    expect([files, checked]).toEqual([0, 0])
  })

  it('does not read a file that carries none of the text, however broken it is', async () => {
    /* The speed rule, pinned by its consequence: a file with no `Stryker
       disable` in it is never parsed, so one that cannot be parsed at all
       passes in silence — where the same file WITH a directive is a finding. */
    const root = fixture({ 'src/broken.ts': 'export const = = =\n' })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toEqual([])
    expect([files, checked]).toEqual([0, 0])
  })

  it('looks under src and scripts and nowhere else', async () => {
    const root = fixture({ 'other/a.ts': ABOVE_CATCH, 'scripts/a.mjs': ABOVE_CATCH })
    expect((await inertStrykerDirectives(root)).found).toEqual([
      { file: 'scripts/a.mjs', line: 4, why: INERT },
    ])
  })
})

describe('a file Stryker cannot read', () => {
  it('is a finding in its own words, not a silent pass', async () => {
    const root = fixture({
      'src/a.ts': 'export const = = =\n// Stryker disable next-line ArithmeticOperator: never checked\n',
    })
    const { found, files, checked } = await inertStrykerDirectives(root)
    expect(found).toHaveLength(1)
    expect(found[0].file).toBe('src/a.ts')
    expect(found[0].line).toBe(1)
    expect(found[0].why).toMatch(/^Stryker cannot read this file: /u)
    /* Nothing in it was checked, and the counts have to say so rather than
       report it as a file whose directives all passed. */
    expect([files, checked]).toEqual([0, 0])
  })
})

describe('the directives themselves', () => {
  it('reads a disable and skips a restore', () => {
    const comments = [
      { value: ' Stryker disable next-line Foo: why', start: 0, loc: { start: { line: 1 } } },
      { value: ' Stryker restore Foo', start: 40, loc: { start: { line: 2 } } },
      { value: ' ordinary prose', start: 70, loc: { start: { line: 3 } } },
    ]
    expect(disableDirectives(comments).map((d) => d.line)).toEqual([1])
  })

  it.each([
    [' Stryker disable Foo:  ', true],
    [' Stryker disable Foo: real', false],
    [' Stryker disable Foo', false],
  ])('reads %j as blank=%s', (value, blank) => {
    const comments = [{ value, start: 0, loc: { start: { line: 1 } } }]
    expect(disableDirectives(comments)[0].blank).toBe(blank)
  })

  it('plants a sentinel over each reason and leaves a blank one alone', () => {
    const source = '// Stryker disable next-line Foo: first\n// Stryker disable next-line Bar:  \n'
    const directives = disableDirectives([
      { value: ' Stryker disable next-line Foo: first', start: 0, loc: { start: { line: 1 } } },
      { value: ' Stryker disable next-line Bar:  ', start: 40, loc: { start: { line: 2 } } },
    ])
    const out = sentinelled(source, directives)
    expect(out).toBe(`// Stryker disable next-line Foo:${sentinelFor(0)}\n// Stryker disable next-line Bar:  \n`)
    expect(out.split('\n')).toHaveLength(source.split('\n').length)
  })

  it('gives every directive a sentinel of its own', () => {
    expect(sentinelFor(0)).not.toBe(sentinelFor(1))
  })
})

function collected() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk
      return true
    },
  }
}

describe('the report', () => {
  it('says how many Stryker directives it checked, and in how many files', async () => {
    const root = fixture({ 'src/a.ts': HONOURED })
    const out = collected()
    expect(await main(out, root)).toBe(0)
    expect(out.text).toContain('check-inert-directives: 0 inert of 1 Stryker directive(s) in 1 file(s)')
  })

  it('exits 1 for an inert Stryker directive, names it, and says what to do', async () => {
    const root = fixture({ 'src/a.ts': ABOVE_CATCH })
    const out = collected()
    expect(await main(out, root)).toBe(1)
    expect(out.text).toContain(`src/a.ts:4  ${INERT}`)
    expect(out.text).toContain('check-inert-directives: 1 inert of 1 Stryker directive(s) in 1 file(s)')
    /* The whole of the advice, not its first line. Every line of it names one
       of the three shapes or what to do about them, so a line that went missing
       would take a cause with it and nothing would say so. */
    expect(out.text).toContain(
      '\nA `Stryker disable` that ignores no mutant is a claim that somebody looked\n' +
        'at that mutant and found it unobservable, with nothing behind it — and the\n' +
        'mutant comes back a survivor with no explanation beside it. Three spellings\n' +
        'do this, each because the comment leads no node:\n' +
        '  - above a `} catch {`, which takes no leading comment;\n' +
        "  - after a block's last statement, above a closing `}, [deps])`;\n" +
        '  - between two chained calls, above a `.sort(…)`.\n' +
        'Move it above the statement whose mutant it names, or delete it and keep the\n' +
        'reason as prose.\n',
    )
  })

  it('exits 1 for an inert linter suppression, and prints that advice instead', async () => {
    const root = fixture({ 'src/a.ts': DISABLE })
    const out = collected()
    expect(await main(out, root)).toBe(1)
    expect(out.text).toContain('src/a.ts:1  suppresses eslint, which this repo does not run')
    expect(out.text).toContain(
      '\nA suppression for a tool that never runs is a claim that a rule was\n' +
        'considered and waived, with nothing behind it. Either install and gate\n' +
        'the tool — then the directive is true and this check goes quiet on its\n' +
        'own — or delete the directive and keep the reason as prose.\n',
    )
    expect(out.text).not.toContain('Move it above the statement whose mutant it names')
  })

  it('names the linters this repo declares, and separates them when there are two', async () => {
    const root = fixture(
      { 'src/a.ts': 'export const a = 1\n' },
      { devDependencies: { eslint: '^9.0.0', prettier: '^3.0.0' } },
    )
    const out = collected()
    expect(await main(out, root)).toBe(0)
    expect(out.text).toContain('check-inert-directives: 0 inert; linters declared: eslint, prettier\n')
  })

  it('exits 0 and says so on both counts when a tree is clean', async () => {
    const root = fixture({ 'src/a.ts': 'export const a = 1 + 1\n' })
    const out = collected()
    expect(await main(out, root)).toBe(0)
    expect(out.text).toBe(
      'check-inert-directives: 0 inert; linters declared: none\n' +
        'check-inert-directives: 0 inert of 0 Stryker directive(s) in 0 file(s)\n',
    )
  })
})

describe('the tree the CLI reads', () => {
  it('is the directory holding this script, not the script itself', () => {
    /* Only the process entry hands `REPO` to `main`, and no test in process
       reaches the entry — the spawned run below does, but a spawned child
       never runs the mutant under test. So a wrong root passed every test here
       and would have failed only as a CLI. It is asserted directly instead. */
    expect(existsSync(join(REPO, 'scripts', 'check-inert-directives.mjs'))).toBe(true)
    expect(existsSync(join(REPO, 'package.json'))).toBe(true)
  })
})

describe('the CLI', () => {
  it('exits 0 on this repository and names what it looked for', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
    /* ⚠️ **WHETHER IT RAN AT ALL, BEFORE WHAT IT SAID.** `spawnSync` reports a
       failure to START in `error` and leaves `stdout` an empty string — so
       asserting on the output first turns "the process never ran" into
       `expected '' to contain 'check-inert-directives: 0 inert'`, which reads
       as the script printing the wrong thing.
       That is exactly how this failed once inside `test:coverage`: nine vitest
       workers each spawning node on a ten-core machine under external load,
       and a fork that could not be had. The script itself was fine — 0.25 s,
       exit 0, and it walks only `src` and `scripts` — but the message sent the
       diagnosis at the script for as long as it took to run it by hand.
       Same rule as `codesign` and `actool` elsewhere in this repo: read the
       status of the thing you care about, and read it first. */
    expect(run.error, `the script never ran: ${run.error?.message ?? ''}`).toBeUndefined()
    expect(run.status, `exited ${run.status} — stderr: ${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('check-inert-directives: 0 inert')
    /* Says which linters it found, so "0 inert" cannot be read as "checked" by
       a reader who does not know whether it looked at anything. */
    expect(run.stdout).toMatch(/linters declared: (none|\w)/)
    /* And the same guard for the Stryker rule, which is the one with a scan
       behind it: a run that instrumented nothing would report zero inert too,
       so the count it checked and the files it read are part of the answer.
       This repository carries hundreds of them, in most of its sources. */
    const scanned = /check-inert-directives: 0 inert of (\d+) Stryker directive\(s\) in (\d+) file\(s\)/u.exec(
      run.stdout,
    )
    expect(scanned, `no Stryker line in:\n${run.stdout}`).not.toBeNull()
    expect(Number(scanned[1])).toBeGreaterThan(100)
    expect(Number(scanned[2])).toBeGreaterThan(10)
  })
})
