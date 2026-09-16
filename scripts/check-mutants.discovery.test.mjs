import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  COMBINATIONS,
  REPORT,
  allSourceFiles,
  ancestorsOf,
  argumentsOf,
  caseSwaps,
  caselessAt,
  changedFiles,
  commitsOf,
  coveringTests,
  entryAt,
  importsOf,
  levelsAbove,
  mutantIdentitiesIn,
  resultFileFor,
  reverseImports,
  run,
  pathsRead,
  sourceReaders,
} from './check-mutants.mjs'

/**
 * What the gate DISCOVERS, and what it refuses before it discovers anything:
 * which paths are subjects, which imports reach them, which of a test's strings
 * can reach a read, and what its own command line means.
 *
 * ⚠️ **THIS FILE MAY NOT SPELL THE NAME OF A SYNCHRONOUS FILE READ**, and the
 * fixtures below spell `readFile` instead. `sourceReaders` parses every covering
 * test whose text holds `readFile` at all, and `pathsRead` follows a name across
 * the WHOLE file rather than one scope — so a read here whose path it could
 * resolve to the gate's own source would leave this file, one of the gate's two
 * covering tests, out of the gate's own run. The last case in
 * `the reads a test's own source is followed through` asserts that it does not.
 */

/** A scratch directory, removed after `act` — after the promise settles when `act` returns one. */
function inScratch(prefix, act) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  const remove = () => rmSync(root, { recursive: true, force: true })
  onTestFinished(remove)
  const result = act(root)
  return typeof result?.then === 'function' ? result.finally(remove) : result
}

/** Writes each `name → contents` under `root`, and answers each one's absolute path. */
function plant(root, files) {
  const at = {}
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
    at[name] = file
  }
  return at
}

/** What a throw leaves behind, or `null` when nothing was thrown. */
function thrownBy(act) {
  try {
    act()
    return null
  } catch (cause) {
    return cause
  }
}

/** Why a case cannot run on Windows, by what it needs that Windows cannot make. */
const WINDOWS = process.platform === 'win32'
const WINDOWS_CANNOT = {
  closeADirectory: 'a Windows directory has no mode bits, so chmod leaves it open to this user',
}

/** A repository of its own, with the hooks and identity a runner may not have. */
const gitIn =
  (root) =>
  (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    ).trim()

/** The subjects `sourceReaders` found a reading test for, with every test taken to reach every subject. */
const subjectsRead = (subjects, tests) => [...sourceReaders(subjects, tests, () => tests).keys()]

/** A test file that reads `spelt` — written without this file itself naming a synchronous read. */
const reads = (spelt) => `import { readFile } from 'node:fs/promises'\nawait readFile(${spelt})\n`

describe('what a sweep takes for a subject', () => {
  /* ⚠️ **AN EXTENSION IS WHERE A NAME ENDS, NOT SOMETHING IT CONTAINS.** Both
     patterns are anchored at both ends, and unanchored each would answer about a
     different file than the one asked about: `vendor/src/a.ts` is not under this
     checkout's `src`, and `src/a.ts.bak` is not a module any runner loads. */
  it('takes a path that is under src or scripts and ends in a source extension, and nothing that merely spells one', () => {
    const files = [
      'src/a.ts',
      'scripts/b.mjs',
      'vendor/src/c.ts',
      'src/d.ts.bak',
      'src/e.test.ts.mjs',
      'src/f.d.ts',
      'src/g.test.ts',
    ]

    expect(allSourceFiles(files)).toEqual(['src/a.ts', 'scripts/b.mjs', 'src/e.test.ts.mjs'])
  })

  /* The same anchoring, on the other rule: what may be MUTATED. A file whose
     name carries `.test.ts` or `.d.ts` in the middle is an ordinary module. */
  it('takes a changed file that ends in a test extension for a test, and not one that merely carries one inside its name', () => {
    inScratch('mutants-subjects-', (root) => {
      gitIn(root)('init', '-q', '-b', 'main')
      plant(root, {
        'src/a.ts': 'export const a = 1\n',
        'src/b.test.ts.mjs': 'export const b = 1\n',
        'src/c.d.ts.mjs': 'export const c = 1\n',
        'src/d.test.ts': 'export const d = 1\n',
        'src/e.d.ts': 'export const e = 1\n',
        'src/f.ts.bak': 'export const f = 1\n',
        'docs/g.ts': 'export const g = 1\n',
      })

      expect(changedFiles('main', false, root).sort()).toEqual(['src/a.ts', 'src/b.test.ts.mjs', 'src/c.d.ts.mjs'])
    })
  })
})

describe('what git is asked for, and what its answer carries', () => {
  /* ⚠️ **THE REFUSAL'S WHOLE VALUE IS GIT'S OWN SENTENCE**, and `stdio` is what
     decides whether it arrives: `execFileSync` writes the child's stderr to this
     process's own whenever `stdio` is left out, and a spelling it cannot read
     leaves `stderr` empty — so the refusal still reads as a refusal and says
     nothing about why. Asked of git directly, so no wording is assumed. */
  it('carries git’s own reason into the refusal for a checkout with no commit to plan against', () => {
    inScratch('mutants-head-', (root) => {
      gitIn(root)('init', '-q')
      const said = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8' })
      expect(said.status, 'this case needs a checkout git refuses to name a HEAD for').not.toBe(0)
      expect(said.stderr.trim(), 'and one it says why about').not.toBe('')

      const refusal = thrownBy(() => commitsOf('main', false, root))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toContain(`${root} has no HEAD commit, so there is nothing to plan a sweep against — `)
      expect(refusal.message, 'git’s own sentence, not merely a longer one of this gate’s').toContain(said.stderr.trim())
    })
  })
})

describe('whether the checkout ignores case', () => {
  /* ⚠️ **EVERY CASE OF THIS USED TO HOLD WHATEVER THE ANSWER WAS ON A
     CASE-SENSITIVE FILESYSTEM** (2026-09-16): each compared `caselessAt` with
     what the filesystem had just been measured to do, so on Linux — where the
     measurement is `false` and a broken `caselessAt` also answers `false` — the
     comparison could not fail. A HARD LINK is the way round it: two names of one
     part reaching one inode is something either kind of filesystem can show,
     because a filesystem that ignores case has already made the second name. */
  it('answers yes where two spellings of one part reach one file', () => {
    inScratch('mutants-caseless-', (root) => {
      const file = path.join(root, 'Ab')
      writeFileSync(file, 'one\n')
      const other = path.join(root, 'aB')
      /* Already there where case is ignored; made where it is kept. */
      if (!existsSync(other)) linkSync(file, other)
      expect(statSync(file).ino, 'this case needs two names of one file').toBe(statSync(other).ino)

      expect(caselessAt(file)).toBe(true)
    })
  })

  /* And the answer it must not give: two names one filesystem keeps apart. Only
     a filesystem that KEEPS case can be shown this — one that ignores case
     cannot hold the second file at all — so the case is SKIPPED there in as many
     words rather than passing having asserted nothing. What it alone catches is
     a comparison that answers yes whatever the two names reach. */
  it('answers no where two spellings of one part reach two files', (context) => {
    inScratch('mutants-cased-', (root) => {
      const file = path.join(root, 'Cd')
      writeFileSync(file, 'one\n')
      const other = path.join(root, 'cD')
      if (existsSync(other)) {
        return context.skip('this filesystem ignores case, so it cannot hold two names of one part that reach two files')
      }
      writeFileSync(other, 'another\n')

      expect(caselessAt(file)).toBe(false)
    })
  })

  /* ⚠️ **WHICH PARTS ARE ASKED ABOUT AT ALL IS A QUESTION NO POSIX MACHINE CAN
     BE SHOWN THROUGH A REAL PATH** (2026-09-16). The first part is left out —
     on an absolute path it is the root, and on Windows a DRIVE LETTER, whose
     case the drive ignores whatever the filesystem under it keeps, so asked it
     would answer yes for every Windows path over the deepest part's own answer.
     On POSIX that part is empty, so it has no other spelling either and the
     rule decides nothing there. Asked of the parts directly, which is the only
     way this machine can be handed a drive. */
  it('offers the deepest part that has case first, climbs past one that has none, and never offers the first part', () => {
    expect(caseSwaps(['', 'var', 'Ab'])).toEqual([
      ['', 'var', 'aB'],
      ['', 'VAR', 'Ab'],
    ])
    /* A part named in digits has no other spelling, so the part above it is what carries the answer. */
    expect(caseSwaps(['', 'tmp', '123'])).toEqual([['', 'TMP', '123']])
    expect(caseSwaps(['C:', 'Abc'])).toEqual([['C:', 'aBC']])
    /* Nothing to ask about: a single part IS the first part, and no part is none. */
    expect(caseSwaps(['123'])).toEqual([])
    expect(caseSwaps([])).toEqual([])
  })
})

describe('the directories a path is resolved through', () => {
  /* ⚠️ **THE CHAIN ENDS BECAUSE THE PARTS RUN OUT, NOT BECAUSE A GUARD RECOGNISES
     THE ROOT** (2026-09-16). A climb that stops on `dirname(x) === x` is reached
     on POSIX only where `realpath('/')` fails, which it does not — so its mutant
     answers no differently and instead fails to TERMINATE, which a settle run
     cannot resolve either. Counted off the parts, the end of the chain is a
     list's own end, and this is the list. */
  it('answers a path and every directory above it, deepest first, ending at its root', () => {
    const { root } = path.parse(process.cwd())
    const deep = path.join(root, 'one', 'two', 'three')

    expect(ancestorsOf(deep)).toEqual([deep, path.join(root, 'one', 'two'), path.join(root, 'one'), root])
    /* The root is one directory and is named once: a chain that kept the empty
       part between it and the first name would name it twice. */
    expect(ancestorsOf(root)).toEqual([root])
  })
})

describe('what is at a path, and what cannot be looked at', () => {
  /* ⚠️ **ABSENT AND UNREADABLE ARE TWO ANSWERS** — the rule this repository
     keeps for every store, asked here of the one place both callers read a path
     through: a plan digests the working tree through it, and `writeFresh` asks
     it whether a generated name is a link before writing over it. */
  it('answers that nothing is there for a path that is absent', () => {
    inScratch('mutants-entry-', (root) => {
      const at = plant(root, { 'here.ts': 'export const here = 1\n' })

      expect(entryAt(path.join(root, 'absent.ts'))).toBe(null)
      expect(entryAt(at['here.ts'])?.isFile()).toBe(true)
    })
  })

  it('throws where it may not look inside a directory, rather than answering that nothing is there', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    inScratch('mutants-entry-', (root) => {
      const closed = path.join(root, 'closed')
      mkdirSync(closed)
      chmodSync(closed, 0o000)
      try {
        /* Root walks straight through, and this would then pass having asked nothing. */
        expect(thrownBy(() => statSync(path.join(closed, 'sub')))?.code, 'this case needs a user permissions apply to').toBe(
          'EACCES',
        )

        expect(thrownBy(() => entryAt(path.join(closed, 'sub')))?.code).toBe('EACCES')
      } finally {
        chmodSync(closed, 0o700)
      }
    })
  })
})

describe('the imports a covering test is found through', () => {
  /* The resolution order is vite's own, and the extension list is part of it:
     a specifier with no extension is answered by the first file that exists. */
  it('answers a relative specifier with the one file that exists, and strips a query or a fragment first', () => {
    inScratch('mutants-imports-', (root) => {
      const at = plant(root, {
        'a.mjs': "import './data'\nimport './q.ts?raw'\nimport './h.ts#frag'\n",
        'data.json': '{}\n',
        'q.ts': 'export const q = 1\n',
        'h.ts': 'export const h = 1\n',
      })

      expect(importsOf(at['a.mjs']).sort()).toEqual([at['data.json'], at['h.ts'], at['q.ts']].sort())
    })
  })

  /* ⚠️ **A BARE SPECIFIER IS NOT A PATH, AND A DIRECTORY BESIDE ONE MAKES IT
     LOOK LIKE ONE.** `vitest.mjs` planted beside a test that imports `vitest`
     answers the package's name as a file, so a rule that read every specifier as
     relative would attribute the import to the wrong module — and one that read
     `.` or `..` as bare would miss a directory's own index, which this tree
     imports. */
  it('follows a relative specifier and nothing else, and reaches a directory through its index', () => {
    inScratch('mutants-relative-', (root) => {
      const at = plant(root, {
        'index.mjs': 'export const above = 1\n',
        'sub/a.mjs': "import 'vitest'\nimport '.'\nimport 'node:path'\n",
        'sub/b.mjs': "import '..'\n",
        'sub/index.mjs': 'export const here = 1\n',
        'sub/vitest.mjs': 'export const notThePackage = 1\n',
      })

      expect(importsOf(at['sub/a.mjs'])).toEqual([at['sub/index.mjs']])
      expect(importsOf(at['sub/b.mjs'])).toEqual([at['index.mjs']])
    })
  })
})

describe('the reads a test’s own source is followed through', () => {
  /* ⚠️ **A NAME A COLLECTION CARRIES IS A NAME THE CALLBACK READS**, and which
     methods hand each element to one is a LIST — a method missing from it leaves
     every path a test spells that way a part that cannot be known, so the
     subject is swept against a test that will fail the dry run. Each of the
     seven is asked, because each of the seven is in this tree. */
  it('follows the collection into every method that hands a callback each of its elements', () => {
    inScratch('mutants-over-each-', (root) => {
      const at = plant(root, { 'subject.mjs': 'export const s = 1\n' })
      const over = (method) =>
        plant(root, {
          [`${method}.test.mjs`]:
            `import { readFile } from 'node:fs/promises'\nconst files = [${JSON.stringify(at['subject.mjs'])}]\n` +
            `files.${method}((one) => readFile(one))\n`,
        })[`${method}.test.mjs`]

      for (const method of ['map', 'flatMap', 'forEach', 'filter', 'find', 'some', 'every']) {
        expect(subjectsRead([at['subject.mjs']], [over(method)]), method).toEqual([at['subject.mjs']])
      }
    })
  })

  /* And a method that hands a callback something else — `reduce` hands it the
     value built so far — carries no such name. The callback's own body is not a
     value either: a walk that EXCLUDES a file spells that file's name inside one. */
  it('follows nothing from a method that hands its callback something other than each element', () => {
    inScratch('mutants-reduce-', (root) => {
      const at = plant(root, { 'subject.mjs': 'export const s = 1\n' })
      const test = plant(root, {
        'reduce.test.mjs':
          `import { readFile } from 'node:fs/promises'\nconst files = [${JSON.stringify(at['subject.mjs'])}]\n` +
          'files.reduce((one) => readFile(one), 0)\n',
      })['reduce.test.mjs']

      expect(subjectsRead([at['subject.mjs']], [test])).toEqual([])
    })
  })

  /* The promise-shaped read is followed too: a test that awaits one reads the
     file exactly as the synchronous call does, and Stryker rewrites the same text. */
  it('follows a read spelt as the promise it answers with', () => {
    inScratch('mutants-promise-', (root) => {
      const at = plant(root, {
        'subject.mjs': 'export const s = 1\n',
        'promise.test.mjs': reads(JSON.stringify(path.join(root, 'subject.mjs'))),
        'other.test.mjs': `import { stat } from 'node:fs/promises'\nawait stat(${JSON.stringify(path.join(root, 'subject.mjs'))})\n`,
      })

      expect(subjectsRead([at['subject.mjs']], [at['promise.test.mjs']])).toEqual([at['subject.mjs']])
      /* Asking after a file without reading a byte of it sees nothing a mutant changes. */
      expect(subjectsRead([at['subject.mjs']], [at['other.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **`import.meta.url` IS THE ONLY META PROPERTY THAT IS A PATH**, and any
     other property spelt `url` is a value this gate cannot know. Read either way
     round, a `new URL` base that cannot be known would name the test's own
     directory — and then every path built on it would name a file. */
  it('takes a base from the test’s own url and from nothing else that is spelt like one', () => {
    inScratch('mutants-url-', (root) => {
      const at = plant(root, {
        'subject.mjs': 'export const s = 1\n',
        'own.test.mjs': reads("new URL('./subject.mjs', import.meta.url)"),
        'meta.test.mjs': reads("new URL('./subject.mjs', import.meta.filename)"),
        'named.test.mjs': `const where = { url: 1 }\n${reads("new URL('./subject.mjs', where.url)")}`,
      })

      expect(subjectsRead([at['subject.mjs']], [at['own.test.mjs']])).toEqual([at['subject.mjs']])
      expect(subjectsRead([at['subject.mjs']], [at['meta.test.mjs']])).toEqual([])
      expect(subjectsRead([at['subject.mjs']], [at['named.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **ONLY `new URL` BUILDS A PATH, AND A TEST CONSTRUCTS PLENTY OF OTHER
     THINGS FROM A NAME AND A BASE.** Read as URLs they would resolve against
     the test's own directory and name whatever sits there — so a subject would
     be left out of its own sweep for a read of it that never happens. */
  it('builds a path from new URL and from no other constructor handed the same two arguments', () => {
    inScratch('mutants-constructor-', (root) => {
      const at = plant(root, {
        'subject.mjs': 'export const s = 1\n',
        'url.test.mjs': reads("new URL('./subject.mjs', import.meta.url)"),
        'other.test.mjs': `class Held {}\n${reads("new Held('./subject.mjs', import.meta.url)")}`,
      })

      expect(subjectsRead([at['subject.mjs']], [at['url.test.mjs']])).toEqual([at['subject.mjs']])
      expect(subjectsRead([at['subject.mjs']], [at['other.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **A BOUND IS A BOUND, AND THE LAST COMBINATION UNDER IT IS STILL
     FOLLOWED.** Past it the answer is a part that cannot be known, which blocks
     nothing — so a bound one place too tight loses a read that is really there,
     and one place too loose is the `RangeError` this gate crashed with. Asked
     of the bound itself rather than of a number written again here, which would
     be a second place to keep. */
  it('expands a URL built from as many combinations as the bound allows, and cannot know one built from more', () => {
    inScratch('mutants-combinations-', (root) => {
      /* Handed to a callback rather than walked with `for…of`: a loop variable
         is ALSO a declaration with no initializer of its own, which carries a
         value that cannot be known and would spend one of the combinations
         being counted here. */
      const spelt = (count) =>
        "import { readFile } from 'node:fs/promises'\n" +
        `const names = ${JSON.stringify([...Array.from({ length: count - 1 }, (_, at) => `./n${at}.mjs`), './leaf.mjs'])}\n` +
        'names.map((one) => readFile(new URL(one, import.meta.url)))\n'
      const at = plant(root, {
        'leaf.mjs': 'export const leaf = 1\n',
        'at-the-bound.test.mjs': spelt(COMBINATIONS),
        'past-the-bound.test.mjs': spelt(COMBINATIONS + 1),
      })

      expect(subjectsRead([at['leaf.mjs']], [at['at-the-bound.test.mjs']])).toEqual([at['leaf.mjs']])
      expect(subjectsRead([at['leaf.mjs']], [at['past-the-bound.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **A SPELLING TWICE OVER IS NOT A SECOND WAY, AND UNTIL 2026-09-16 IT
     COUNTED AS ONE.** The bound counts the ways a path may be SPELT, so a list
     carrying the same path 4 096 times spent the whole of it and the read beside
     them was lost. The duplicates were also what made these lists large enough
     to matter: 1 332 297 paths over this file's 5 900-line sibling where 2 773
     are distinct — and with `joined`'s guard taken away, that was the difference
     between exhausting 1.5 GB, which a sweep can report only as a wall-clock
     timeout it could not settle, and a wrong answer in a second and a half,
     which `expands a path built from exactly as many names as it will` asserts.
     So the assertion is left here beside the fix: one of each, and the bound
     counts what it says it counts. */
  it('counts a path spelt over and over as one way of spelling it, however far past the bound the spellings run', () => {
    inScratch('mutants-repeated-', (root) => {
      const overAndOver = [...Array.from({ length: COMBINATIONS }, () => 'spelt-again.mjs'), 'leaf.mjs']
      const at = plant(root, {
        'leaf.mjs': 'export const leaf = 1\n',
        'repeated.test.mjs':
          "import { readFile } from 'node:fs/promises'\n" +
          "import path from 'node:path'\n" +
          `const under = ${JSON.stringify(root)}\n` +
          `const spellings = ${JSON.stringify(overAndOver)}\n` +
          'spellings.map((one) => readFile(path.join(under, one)))\n',
      })

      expect(subjectsRead([at['leaf.mjs']], [at['repeated.test.mjs']])).toEqual([at['leaf.mjs']])
    })
  })

  /* ⚠️ **A SPECIFIER THAT CANNOT BE KNOWN MUST NAME NOTHING, NOT THE FILE CALLED
     `null`.** `new URL(null, base)` is a real URL — the constructor stringifies
     its first argument — so a gate that handed one through would block whatever
     sits beside the test under that name. The subject here is that file. */
  it('names no file at all from a specifier it cannot know, and never the one called null beside the test', () => {
    inScratch('mutants-unknown-', (root) => {
      const at = plant(root, {
        null: 'not a module\n',
        'unknown.test.mjs': reads('new URL(process.env.WHICH, import.meta.url)'),
      })

      expect(subjectsRead([at.null], [at['unknown.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **A CALL THIS DOES NOT KNOW ANSWERS "CANNOT BE KNOWN", NOT NOTHING.**
     The switch over a call's name ends in a default that says so, and a sweep
     that lost it would answer `undefined` for every unrecognised call — which
     `namesFile` would then read as a path that names nothing, quietly turning a
     test that DOES read the subject into one that blocks nothing. The subject
     here is spelt through a function the gate has no rule for, so only the
     default decides it (2026-09-16, found by the sweep). */
  it('answers a read spelt through a call it knows no rule for with the part it cannot know, not with nothing', () => {
    /* ⚠️ **`null` AND `undefined` ARE NOT THE SAME ANSWER HERE, THOUGH EVERY
       READER OF THIS LIST SKIPS BOTH.** The switch over a call's name ends in a
       default that says "a part that cannot be known"; without it `valuesOf`
       falls out answering nothing, and `flatMap` folds that in as a value of its
       own. Every path this gate resolves is then built on a hole that reads as
       absent rather than as unknowable — and a sweep that cannot tell the two
       apart is one turn from naming a file it was never told about. Found by the
       sweep, 2026-09-16: nothing else in this suite could see it. */
    expect(pathsRead("import { readFile } from 'node:fs/promises'\nawait readFile(decide('x'))\n", 'a.test.mjs')).toEqual([
      null,
    ])
    /* Non-vacuous: a call it DOES know answers with the path itself. */
    expect(pathsRead("import { readFile } from 'node:fs/promises'\nawait readFile(join('one', 'two.mjs'))\n", 'a.test.mjs')).toEqual([
      'one/two.mjs',
    ])
  })

  /* ⚠️ **AND THIS FILE ITSELF MUST NOT BE ONE OF THEM.** `pathsRead` follows a
     name across the whole file, so a fixture's parameter sharing a name with one
     bound to a real path is enough to make this a reader of the gate — which
     would leave one of the gate's two covering tests out of the gate's own run,
     silently, while every case here still passed. */
  it('is no reader of the gate’s own source, whatever its fixtures spell', () => {
    expect(subjectsRead(['scripts/check-mutants.mjs'], [fileURLToPath(import.meta.url)])).toEqual([])
  })
})

describe('the modules a subject is reached through', () => {
  /* ⚠️ **THE CLIMB NAMES THE LEVEL IT STOPPED AT, AND THE LOG IS WHERE A READER
     SEES HOW A SUBJECT WAS REACHED.** A level that carried a module already
     passed, or a placeholder for a module nothing imports, would name modules
     that reach nothing — and the next level would then be climbed from them. */
  it('climbs to the nearest level a test reaches, and names that level and nothing else', () => {
    inScratch('mutants-climb-', (root) => {
      const at = plant(root, {
        's.mjs': 'export const s = 1\n',
        'a.mjs': "import './s'\nimport './b'\n",
        'b.mjs': "import './s'\n",
        'd.mjs': "import './s'\n",
        'c.mjs': "import './a'\n",
        't.test.mjs': "import './c'\n",
      })
      const importers = reverseImports([at['a.mjs'], at['b.mjs'], at['c.mjs'], at['d.mjs'], at['s.mjs']])

      const reached = coveringTests(at['s.mjs'], [at['t.test.mjs']], importers)

      expect(reached.tests).toEqual([at['t.test.mjs']])
      expect(reached.through.map((one) => path.basename(one))).toEqual(['c.mjs'])
    })
  })

  /* ⚠️ **THE CLIMB IS A LIST TO WALK NOW, AND ONLY THE LIST ITSELF CAN SAY SO.**
     `coveringTests` stops at the first level a test reaches, so a level PAST
     that one changes no answer it gives — which is why the guard that ends the
     climb had to be asked about here. What the `for (;;)` it replaced did
     instead was not answer at all: with `next.length === 0` never true it ran
     on, a 40-minute sweep reported it as a wall-clock timeout, and the settle
     run at four times the deadline reported it as one again (2026-09-16). The
     turns are counted off the graph's keys, which are more than any climb needs,
     so a graph with more keys than levels is the case that says the guard ends
     the list rather than the count ending it. */
  it('lists the levels nearest first and stops at the one that is empty, however many turns the graph allows', () => {
    const importers = new Map([
      ['s.mjs', ['a.mjs']],
      ['a.mjs', ['b.mjs']],
      ['elsewhere.mjs', ['nothing-to-do-with-it.mjs']],
    ])

    expect(levelsAbove('s.mjs', importers)).toEqual([['a.mjs'], ['b.mjs']])
  })

  /* ⚠️ **AND THE SUBJECT IS NEVER OFFERED BACK, WHICH ONLY A CYCLE ASKS.** The
     climb is reached only when no test imports the subject, so a level carrying
     the subject again adds no test and cannot be told from one that does not —
     anywhere but here. Nor is any file a nearer level already held, which is
     what keeps the climb finite in the first place.

     This graph has exactly as many keys as it has levels, which is the OTHER
     end of the count: the climb ends because it has walked the list, not
     because a level came back empty. Both ends answer the same list. */
  it('never offers the subject again, nor any file a nearer level already held', () => {
    const importers = new Map([
      ['s.mjs', ['a.mjs']],
      ['a.mjs', ['b.mjs', 's.mjs']],
    ])

    expect(levelsAbove('s.mjs', importers)).toEqual([['a.mjs'], ['b.mjs']])
  })
})

describe('the mutants Stryker is counted to have made', () => {
  /* ⚠️ **ONE ORDER, OR TWO ENDS OF A SWEEP NAME A DIFFERENT MUTANT FIRST.** A
     plan's identities and a report's are compared as sets and printed as lists,
     and the instrumenter's own order puts two mutants of one location in the
     order it happened to make them — `true` before `false` for a condition. So
     the order is imposed here: where it sits, then which mutator, then what it
     replaces. */
  it('lists them in one order — where each sits, then its mutator, then its replacement', async () => {
    await inScratch('mutants-order-', async (root) => {
      const at = plant(root, { 'pick.mjs': "export const pick = (a, b) => (a === b ? 'same' : 'other')\n" })

      const identities = await mutantIdentitiesIn(at['pick.mjs'])

      expect(identities.map((one) => [one.location.start.column, one.mutatorName, one.replacement])).toEqual([
        [21, 'ArrowFunction', '() => undefined'],
        [32, 'ConditionalExpression', 'false'],
        [32, 'ConditionalExpression', 'true'],
        [32, 'EqualityOperator', 'a !== b'],
        [42, 'StringLiteral', '""'],
        [51, 'StringLiteral', '""'],
      ])
    })
  })
})

describe('the command line a sharded sweep is given', () => {
  const plan = (...args) => argumentsOf(['--plan', 'p.json', ...args])
  const shard = (spec) => argumentsOf(['--shard', spec, '--manifest', 'p.json', '--results', 'out'])

  /* ⚠️ **A NUMBER IS WHOLE TO ITS LAST CHARACTER.** `Number` trims whitespace,
     so a count read from an unanchored pattern would take `3 ` for three — and a
     pattern that matched one digit would refuse every count past nine. */
  it('reads a count of any length, and refuses one that is not whole to its last character', () => {
    expect(plan('--shards', '12')).toMatchObject({ shards: 12 })

    const refusal = thrownBy(() => plan('--shards', '3 '))

    expect(refusal).toBeInstanceOf(Error)
    expect(refusal.message).toBe('--shards needs a whole number of at least 1, and was given "3 "')
  })

  /* And the same at both ends of a shard spec, with the index too large to be a
     whole number refused for what it is rather than as an index out of range. */
  it('reads an index and a count of any length, and refuses an index too large to be whole as no whole number', () => {
    expect(shard('12/20')).toMatchObject({ index: 12, count: 20 })
    expect(shard('2/20')).toMatchObject({ index: 2, count: 20 })

    const refusal = thrownBy(() => shard('99999999999999999999/2'))

    expect(refusal).toBeInstanceOf(Error)
    expect(refusal.message).toBe('--shard needs <index>/<count>, two whole numbers, and was given "99999999999999999999/2"')
  })
})

describe('the name a subject’s result is written under', () => {
  /* The readable half is a slug of the basename: every run of unusable
     characters folded into ONE dash, trimmed at both ends and nowhere else, and
     cut to forty characters so the whole name fits what a filesystem allows. */
  it('folds each run of unusable characters into one dash, trims only the ends, and keeps forty characters', () => {
    const digest = '-'.length + 16 + '.result.json'.length

    expect(resultFileFor('src/a  b.ts').startsWith('a-b.ts-')).toBe(true)
    expect(resultFileFor('src/a.ts').startsWith('a.ts-')).toBe(true)
    expect(resultFileFor('src/a__').startsWith('a-')).toBe(true)
    const long = resultFileFor(`src/${'a'.repeat(80)}.ts`)
    expect(long.startsWith(`${'a'.repeat(40)}-`)).toBe(true)
    expect(long.length).toBe(40 + digest)
  })
})

/**
 * A whole sweep over a directory of its own, with git, the lock and Stryker
 * stood in for and both streams captured. `root` is the checkout the sweep is
 * given, which is not always a directory that is there — see the cases that hand
 * it one it may not resolve.
 */
async function sweep(root, { argv = [], subjects = [], tree = [], ...options } = {}) {
  const said = { stdout: '', stderr: '' }
  const code = await run(argv, {
    root,
    stdout: { write: (text) => void (said.stdout += text) },
    stderr: { write: (text) => void (said.stderr += text) },
    changed: () => subjects,
    files: () => tree,
    lock: () => () => {},
    stryker: () => {
      throw new Error('no subject here should have reached Stryker')
    },
    commits: () => ({ head: 'a'.repeat(40), mergeBase: 'b'.repeat(40) }),
    worktree: () => ({}),
    tracked: () => [],
    clock: ticking(),
    ...options,
  })
  return { code, ...said }
}

/**
 * A checkout a sweep can read how to run its tests from: the two config files
 * `testOptionsOf` loads before it writes or locks anything, and the install they
 * resolve `vitest/config` through.
 */
function checkout(root, files = {}) {
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'))
  return plant(root, {
    'vitest.config.ts':
      'export default { test: {\n' +
      "  passWithNoTests: true,\n  projects: [\n" +
      "    { extends: true, test: { name: 'scripts', include: ['scripts/**/*.test.mjs'], environment: 'node' } },\n" +
      '  ],\n} }\n',
    'vite.config.ts': "export default { plugins: [] }\n",
    ...files,
  })
}

/** A clock that moves on 250 ms each time it is read, so a duration a sweep records is one a test can name. */
function ticking() {
  let now = 0
  return () => (now += 250)
}

/** How a sweep names a module it reached a subject through: relative to where it runs, and separated by `/`. */
const throughName = (file) => path.relative(process.cwd(), file).split(path.sep).join('/')

/** Stands in for Stryker: writes the report each run was given, in order, and leaves no sandbox behind. */
function strykerAnswering(root, ...reports) {
  const asked = []
  const stryker = async () => {
    const answer = reports[asked.length]
    asked.push(answer)
    if (answer !== undefined) writeFileSync(path.join(root, REPORT), JSON.stringify(answer))
    return true
  }
  return { stryker, asked }
}

/** A report as Stryker writes one: the file's own source, and every mutant it counted, killed. */
async function killedReport(subject, source, ...extra) {
  const counted = await mutantIdentitiesIn(subject)
  return {
    files: {
      [subject]: {
        source,
        mutants: [...extra, ...counted.map((identity, id) => ({ id: `counted-${id}`, static: false, status: 'Killed', ...identity }))],
      },
    },
  }
}

const BARREL = "export { x } from './x'\n"
const WITH_A_MUTANT = "export const s = 'row'\n"

describe('what a whole sweep says it did', () => {
  /* ⚠️ **WHAT IS LEFT OUT IS PRINTED, SUBJECT BY SUBJECT AND TEST BY TEST.** A
     silent exclusion list is the thing this gate exists not to become; a list
     run together into one line is the same list nobody can read. */
  it('names every covering test it leaves out, under the subject it was left out of', async () => {
    await inScratch('mutants-left-out-', async (root) => {
      const at = plant(root, { 'src/one.ts': BARREL, 'src/two.ts': BARREL })
      const reading =
        "import { readFile } from 'node:fs/promises'\nimport './one'\nimport './two'\n" +
        `await readFile(${JSON.stringify(at['src/one.ts'])})\nawait readFile(${JSON.stringify(at['src/two.ts'])})\n`
      plant(root, { 'src/a.test.mjs': reading, 'src/b.test.mjs': reading })
      const tests = [path.join(root, 'src/a.test.mjs'), path.join(root, 'src/b.test.mjs')]

      const result = await sweep(root, {
        subjects: ['src/one.ts', 'src/two.ts'],
        tree: ['src/one.ts', 'src/two.ts', 'src/a.test.mjs', 'src/b.test.mjs'],
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        'check-mutants: 2 file(s) are mutated without the covering tests that read their source text',
      )
      expect(result.stdout).toContain(
        `  ${at['src/one.ts']} — no covering test remains; left out:\n` +
          `    ${tests[0]} — reads its source text\n` +
          `    ${tests[1]} — reads its source text\n` +
          `  ${at['src/two.ts']} — no covering test remains; left out:\n` +
          `    ${tests[0]} — reads its source text\n` +
          `    ${tests[1]} — reads its source text\n`,
      )
    })
  })

  /* And how it was reached, when no test imports it directly: every module of
     the level the climb stopped at, named as the log names one. */
  it('names every module it reached a subject through, and clears a sandbox before the run and after it', async () => {
    await inScratch('mutants-through-', async (root) => {
      const at = checkout(root, {
        'src/s.ts': WITH_A_MUTANT,
        'src/a.ts': "import './s'\n",
        'src/b.ts': "import './s'\n",
        'src/t.test.mjs': "import './a'\nimport './b'\n",
        '.stryker-tmp/left/over.ts': 'export {}\n',
      })
      const { stryker } = strykerAnswering(root, await killedReport(at['src/s.ts'], WITH_A_MUTANT))

      const result = await sweep(root, {
        subjects: ['src/s.ts'],
        tree: ['src/s.ts', 'src/a.ts', 'src/b.ts', 'src/t.test.mjs'],
        stryker,
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        `  [1/1] ${at['src/s.ts']} — through ${throughName(at['src/a.ts'])}, ${throughName(at['src/b.ts'])}\n`,
      )
      /* One left by another run went whole, and the stand-in left none for the
         removal after the run to find. */
      expect(existsSync(path.join(root, '.stryker-tmp'))).toBe(false)
    })
  })

  /* A file with nothing to kill passes, and is NAMED — beside the files that
     were swept, in the same summary, so a reader can tell the two apart. */
  it('names a reached file with no mutant to kill beside the files it swept', async () => {
    await inScratch('mutants-nothing-', async (root) => {
      const at = checkout(root, {
        'src/barrel.ts': BARREL,
        'src/s.ts': WITH_A_MUTANT,
        'src/t.test.mjs': "import './barrel'\nimport './s'\n",
      })
      const { stryker } = strykerAnswering(root, await killedReport(at['src/s.ts'], WITH_A_MUTANT))

      const result = await sweep(root, {
        subjects: ['src/barrel.ts', 'src/s.ts'],
        tree: ['src/barrel.ts', 'src/s.ts', 'src/t.test.mjs'],
        stryker,
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(
        'check-mutants: 1 file(s) had no mutant to kill — Stryker made none, or every one is disabled beside the code — ' +
          `so they pass without any test having been tried against them:\n  ${at['src/barrel.ts']}\n`,
      )
      expect(result.stdout).toContain('check-mutants: every mutant was killed\n')
    })
  })

  /* ⚠️ **A COUNT THAT CANNOT BE TAKEN IS A REFUSAL, AND WHICH QUESTION IT LEAVES
     UNANSWERED DEPENDS ON WHEN IT WAS ASKED.** Before discovery it is whether a
     test must reach the file; after it, whether Stryker has anything to run in
     it — and a refusal that named neither would send a reader to the wrong half. */
  it('refuses a reached subject Stryker cannot count the mutants in, naming the question left unanswered', async () => {
    await inScratch('mutants-uncountable-', async (root) => {
      const at = plant(root, {
        'src/broken.ts': 'export const = =\n',
        'src/broken.test.mjs': "import './broken'\n",
      })

      const result = await sweep(root, { subjects: ['src/broken.ts'], tree: ['src/broken.ts', 'src/broken.test.mjs'] })

      expect(result.code).toBe(2)
      expect(
        result.stderr.startsWith(
          `check-mutants: Stryker cannot count the mutants in ${at['src/broken.ts']}, ` +
            'so whether Stryker has anything to run in it is unknown — ',
        ),
        result.stderr,
      ).toBe(true)
    })
  })

  /* ⚠️ **A REPORT'S MUTANTS ARE MATCHED BY IDENTITY, WHATEVER SHAPE THEY ARRIVE
     IN.** A report is a file this gate did not write, so one of its mutants may
     be anything at all — and the refusal names the FIRST difference in identity
     order, which means an identity with nothing in it must still take its place
     in that order rather than stop the comparison. */
  it('refuses a report holding mutants it never counted, naming the first of them in identity order', async () => {
    await inScratch('mutants-unlike-', async (root) => {
      const at = checkout(root, { 'src/s.ts': WITH_A_MUTANT, 'src/t.test.mjs': "import './s'\n" })
      const uncounted = {
        id: 'uncounted',
        status: 'Killed',
        mutatorName: 'Zzz',
        replacement: 'z',
        location: { start: { line: 9, column: 9 }, end: { line: 9, column: 9 } },
      }
      /* The shapeless one FIRST, so the order a refusal names them in is the
         identity order rather than the order the report happened to list. */
      const { stryker } = strykerAnswering(root, await killedReport(at['src/s.ts'], WITH_A_MUTANT, null, uncounted))

      const result = await sweep(root, {
        subjects: ['src/s.ts'],
        tree: ['src/s.ts', 'src/t.test.mjs'],
        stryker,
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('check-mutants: the report does not match the file swept in 1 file(s)')
      expect(result.stderr).toContain(
        `  ${at['src/s.ts']} — it holds the mutant Zzz at 9:9-9:9 replaced with "z", which this sweep did not count\n`,
      )

      /* And where a location is not a number at all, it still takes its place in
         that order by name rather than falling in wherever the report listed it:
         `!` sorts before every digit, so this one is named ahead of the mutant at
         line 9 although the report lists it after. */
      const spelt = {
        id: 'spelt',
        status: 'Killed',
        mutatorName: 'Yyy',
        replacement: 'y',
        location: { start: { line: '!', column: 1 }, end: { line: '!', column: 1 } },
      }
      const second = await sweep(root, {
        subjects: ['src/s.ts'],
        tree: ['src/s.ts', 'src/t.test.mjs'],
        stryker: strykerAnswering(root, await killedReport(at['src/s.ts'], WITH_A_MUTANT, uncounted, spelt)).stryker,
      })

      expect(second.code).toBe(1)
      expect(second.stderr).toContain(
        `  ${at['src/s.ts']} — it holds the mutant Yyy at !:1-!:1 replaced with "y", which this sweep did not count\n`,
      )
    })
  })
})

describe('the paths a sharded sweep resolves before it writes anything', () => {
  const planning = (root, manifest, options) => sweep(root, { argv: ['--plan', manifest, '--shards', '1'], ...options })

  /* ⚠️ **`..` IS REFUSED RATHER THAN RESOLVED, AND THE CHECKOUT'S OWN PATH IS
     ONE OF THE PATHS THAT RULE IS FOR.** `path.resolve` collapses `link/..`
     textually, which is not what the filesystem does — so a checkout named that
     way would be checked as one place and written in another. */
  it('refuses a checkout whose own path does not say plainly where it goes', async () => {
    await inScratch('mutants-dots-', async (root) => {
      mkdirSync(path.join(root, 'sub'))
      const climbing = `${root}${path.sep}sub${path.sep}..`
      const manifest = path.join(root, 'plan.json')

      const result = await planning(climbing, manifest)

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: ${climbing} has a ".." in it, and a path this gate writes to or reads a plan from ` +
          'must say plainly where it goes — pass one without\n',
      )
      expect(existsSync(manifest)).toBe(false)
    })
  })

  /* And a checkout it may not look at is a failure to resolve, thrown as it
     came — not a path that is merely not there yet, which is the one thing the
     climb above it exists to join back on. */
  it('throws where it may not resolve the checkout’s own path, rather than climbing past it', async (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    await inScratch('mutants-closed-', async (root) => {
      const closed = path.join(root, 'closed')
      mkdirSync(path.join(closed, 'inner'), { recursive: true })
      chmodSync(closed, 0o000)
      try {
        /* Root walks straight through, and this would then pass having asked nothing. */
        expect(thrownBy(() => statSync(path.join(closed, 'inner')))?.code, 'this case needs a user permissions apply to').toBe(
          'EACCES',
        )

        const cause = await planning(path.join(closed, 'inner'), path.join(root, 'plan.json')).then(
          () => null,
          (thrown) => thrown,
        )

        expect(cause).toBeInstanceOf(Error)
        expect(cause.code).toBe('EACCES')
        expect(cause.syscall, 'the failure that resolving it raised, not one met later on the way past it').toBe('realpath')
      } finally {
        chmodSync(closed, 0o700)
      }
    })
  })

  /* ⚠️ **A PATH THAT IS NOT THERE YET IS STILL RESOLVED THROUGH THE DIRECTORIES
     THAT ARE.** A plan is written at a name nothing has made, so the deepest
     ancestor that exists is what says where it goes — and a gate that took the
     name as given would compare a path inside the checkout with one that reads
     as though it were outside, and compare nothing at all. */
  it('resolves a plan’s own path through the directories above it that exist, and refuses it where they land on an input', async () => {
    await inScratch('mutants-unmade-', async (root) => {
      mkdirSync(path.join(root, 'actual'))
      /* The checkout reached through a link of its own, so that resolving it is
         something this case can see on any filesystem. */
      symlinkSync(path.join(root, 'actual'), path.join(root, 'checkout'))
      const manifest = path.join(root, 'checkout', 'unmade', 'a.ts')

      const result = await sweep(path.join(root, 'checkout'), {
        argv: ['--plan', manifest, '--shards', '1'],
        worktree: () => ({ 'unmade/a.ts': 'f'.repeat(64) }),
      })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: --plan ${manifest} overlaps unmade/a.ts, an input this plan fingerprints — its shards leave the ` +
          'manifest out of drift detection, so an input there could change unseen; write the plan apart from every input\n',
      )
    })
  })

  /* ⚠️ **A LINK IS TWO PLACES, AND BOTH ARE ASKED ABOUT.** A plan written at a
     name that is clean, through a link onto an input the plan fingerprints, would
     replace that input — and its shards leave the manifest's own path out of
     drift detection, so the replacement would never be noticed. */
  it('refuses a plan at a name a link takes onto an input, though the name itself is clear', async () => {
    await inScratch('mutants-link-', async (root) => {
      plant(root, { 'src/a.ts': 'export const a = 1\n' })
      const manifest = path.join(root, 'plan.json')
      symlinkSync(path.join(root, 'src'), manifest)

      const result = await planning(root, manifest, { worktree: () => ({ 'src/a.ts': 'f'.repeat(64) }) })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: --plan ${manifest} overlaps src/a.ts, an input this plan fingerprints — its shards leave the ` +
          'manifest out of drift detection, so an input there could change unseen; write the plan apart from every input\n',
      )
    })
  })
})
