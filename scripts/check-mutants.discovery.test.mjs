import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  matchedSurvivors,
  mutantIdentitiesIn,
  resultFileFor,
  reverseImports,
  run,
  pathsRead,
  sourceReaders,
  survivorIdentity,
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
  /* ⚠️ **WHERE THE INSTALL IS MUST BE FOUND, NOT ASSUMED — AND TWO WRONG
     ASSUMPTIONS ABOUT IT EACH LOOKED RIGHT** (2026-09-17, both reproduced).

     It was the bare name `node_modules` handed to `path.resolve`, which resolves
     such a name against `process.cwd()`. From the repository that is the repository's install; from
     anywhere else it is a path that does not exist, and the link dangles. That
     is why a base measurement of a module the GATE imports — `lib/entry.mjs`,
     `lib/specifiers.mjs` — could never be made: it sweeps this very file inside
     a Stryker sandbox whose cwd is not the repository, so every case that loads
     the generated config died with `Cannot find package 'vitest' imported from
     <scratch>/vitest.mutants.mjs.timestamp-*.mjs`, and the measurement refused.

     ⚠️ **AND `../node_modules` FROM THIS FILE IS NOT THE ANSWER EITHER.**
     Measured inside a live sandbox rather than assumed: Stryker does NOT link
     an install into its sandbox when the project's `node_modules` is itself a
     symbolic link, which is exactly what a base worktree has. The sandbox has
     none at all, and ordinary imports resolve only because Node walks UP to the
     worktree's. A fixed relative depth therefore points at nothing.

     So it is SEARCHED for, upwards, which is what Node itself does — and the
     first one that exists is the one every other import in this process already
     resolved through. `fileURLToPath`, never `.pathname`: see AGENTS.md. */
  symlinkSync(installAbove(fileURLToPath(new URL('.', import.meta.url))), path.join(root, 'node_modules'))
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

describe('what makes a survivor here the same survivor as one at the merge base', () => {
  /** Every mutant Stryker's own instrumenter makes in `source`, identified as a survivor of it would be. */
  const identifiedIn = async (source, name = 'subject.ts') =>
    await inScratch('mutants-identity-', async (root) => {
      const at = plant(root, { [name]: source })
      return (await mutantIdentitiesIn(at[name])).map((mutant) => survivorIdentity(mutant, source, name))
    })

  /** Those of one mutator, in the order they sit in the file. */
  const byMutator = async (source, mutatorName, name) => (await identifiedIn(source, name)).filter((one) => one.mutatorName === mutatorName)

  /* ⚠️ **STRYKER GIVES BOTH RETURNS ONE REPLACEMENT**, so an identity made of a
     mutator and a replacement lets a line the change REWROTE inherit the debt of
     the line it replaced. Reproduced here against the instrumenter itself rather
     than described. */
  it('separates two returns Stryker replaces with the same text, by the text that was there', async () => {
    const source = 'class Reader {\n  read() {\n    return "old"\n  }\n}\nexport function other() {\n  return "new"\n}\n'

    const strings = await byMutator(source, 'StringLiteral')
    const blocks = await byMutator(source, 'BlockStatement')

    expect(strings.map((one) => one.replacement)).toEqual(['""', '""'])
    expect(strings.map((one) => one.original)).toEqual(['"old"', '"new"'])
    expect(blocks.map((one) => one.replacement)).toEqual(['{}', '{}'])
    expect(blocks.map((one) => one.original)).toEqual(['{\nreturn "old"\n}', '{\nreturn "new"\n}'])
  })

  it('carries the chain of enclosing declarations, so one class’s method is not another’s', async () => {
    const source = 'export class One {\n  read() {\n    return null\n  }\n}\nexport class Two {\n  read() {\n    return null\n  }\n}\n'

    const blocks = await byMutator(source, 'BlockStatement')

    expect(blocks.map((one) => one.scope)).toEqual([
      ['One', 'read'],
      ['Two', 'read'],
    ])
    expect(blocks.map((one) => one.original)).toEqual(['{\nreturn null\n}', '{\nreturn null\n}'])
  })

  it('tells a nested function from one of the same name nested somewhere else', async () => {
    const source =
      'export function outer() {\n  function read() {\n    return "same"\n  }\n  return read\n}\n' +
      'export function other() {\n  function read() {\n    return "same"\n  }\n  return read\n}\n'

    const strings = await byMutator(source, 'StringLiteral')

    expect(strings.map((one) => one.scope)).toEqual([
      ['outer', 'read'],
      ['other', 'read'],
    ])
  })

  /* ⚠️ **`['run', 'ArrowFunction']` IS WHAT THIS CASE ASSERTED UNTIL 2026-09-17**,
     and the callback's own call is in the name now — see the pair below, which is
     what the kind alone let through. `Constructor` is the other half: nothing
     holds it in a call, so it keeps its bare kind, and that is the branch a
     mutation of the call test would take away. */
  it('names a scope by what declares it, by its kind where nothing does, and by the call where one holds it', async () => {
    const source =
      'export const run = () => {\n  return [1].map(() => "each")\n}\n' +
      'export const held = { read: () => "held" }\n' +
      'export class Keeps {\n  kept = () => "kept"\n  constructor() {\n    this.made = "made"\n  }\n}\n'

    const strings = await byMutator(source, 'StringLiteral')

    expect(strings.map((one) => [one.original, one.scope])).toEqual([
      ['"each"', ['run', 'ArrowFunction 1/1 in ArrayLiteralExpression.map()']],
      ['"held"', ['read']],
      ['"kept"', ['Keeps', 'kept']],
      ['"made"', ['Keeps', 'Constructor']],
    ])
  })

  /**
   * ⚠️ **AND THE CALLEE'S OWN SPELLING, NEVER THE CALL'S TEXT.** A call holds its
   * arguments, the callback among them, so a name taken from the call would put a
   * callback's whole body inside the identity of every mutant in it — which is the
   * 68 593-character identity `statementAround` exists to avoid, arriving through
   * the fix for it. A callee that is not a name answers with its KIND, so nothing
   * here grows with the code around it, and a class field is untouched by all of
   * this because nothing holds it in a call at all.
   */
  it('spells a callee as far as it is a name, answers anything else with its kind, and leaves a class field small', async () => {
    const chained = await byMutator('export function f(one) {\n  one.two.three(() => "deep")\n}\n', 'StringLiteral')
    const curried = await byMutator('export function f(pick) {\n  pick()(() => "curried")\n}\n', 'StringLiteral')
    const built = await byMutator('export function f(Thing) {\n  return new Thing(() => "made")\n}\n', 'StringLiteral')
    /* A class big enough that any identity taking the text around the field would
       be enormous — the measured failure was 68 593 characters. */
    const wide = 'export class Reader {\n  #disposed = false\n' + '  step() {\n    return "step"\n  }\n'.repeat(40) + '}\n'
    const [field] = await byMutator(wide, 'BooleanLiteral')

    expect(chained.map((one) => one.scope)).toEqual([['f', 'ArrowFunction 1/1 in one.two.three()']])
    expect(curried.map((one) => one.scope)).toEqual([['f', 'ArrowFunction 1/1 in CallExpression()']])
    expect(built.map((one) => one.scope)).toEqual([['f', 'ArrowFunction 1/1 in Thing()']])
    expect([field.scope, field.statement]).toEqual([['Reader'], '#disposed = false'])
    expect(JSON.stringify(field).length).toBeLessThan(200)
  })

  /**
   * ⚠️ **TWO CALLBACKS TO ONE CALL SHARED ONE IDENTITY, SO PERMISSION PASSED
   * BETWEEN THEM** (a second opinion's fifth round, 2026-09-17, reproduced with
   * real instrumenter mutants). `p.then(onResolve, onReject)` named both arrows
   * `ArrowFunction in p.then`. Swap the two bodies and update both tests with
   * them — both suites pass, both sides show four survivors, and the success
   * callback's NEW survivor is paid for by the rejection callback's old one.
   *
   * The position in the argument list is what separates `then`'s two roles, and
   * a call's own literal arguments are what separate one registration from
   * another. Neither grows with the code inside the callback, which is the
   * constraint that rules out simply taking the call's text.
   */
  it('separates two callbacks passed to one call, by where each sits and by the call’s own literals', async () => {
    const both = await byMutator('export function check(p) {\n  return p.then(() => "yes", () => "no")\n}\n', 'StringLiteral')
    const bus = await byMutator('export function on(bus) {\n  bus.on("publish", () => "a")\n  bus.on("delete", () => "b")\n}\n', 'StringLiteral')

    expect(both.map((one) => one.scope)).toEqual([
      ['check', 'ArrowFunction 1/2 in p.then()'],
      ['check', 'ArrowFunction 2/2 in p.then()'],
    ])
    /* Same position, same callee, different registration — told apart by the
       literal the call carries, and by nothing that grows with the callback.
       The registration literals are themselves mutants, and sit in `on`. */
    expect(bus.map((one) => one.scope)).toEqual([
      ['on'],
      ['on', 'ArrowFunction 2/2 in bus.on("publish")'],
      ['on'],
      ['on', 'ArrowFunction 2/2 in bus.on("delete")'],
    ])
  })

  /* ⚠️ **AND A LITERAL'S TEXT IS TAKEN FROM THE LITERAL, NEVER FROM THE TREE.**
     The first version asked `getText()` for anything that was not a string —
     which reads `node.getSourceFile().text`, and a node reached this way has no
     source file bound to it. It threw `Cannot read properties of undefined
     (reading 'text')` out of TypeScript and took a whole SHARD down with it: no
     receipt, and an aggregate that could say only that the sweep was incomplete.
     The unit tests above did not catch it because every one of them passed a
     STRING, which is the one branch that never asked the tree. Found 2026-09-17
     by the first sharded run that ran to the end. */
  it('takes a call’s numeric and boolean literals without asking the tree for their text', async () => {
    const numbered = await byMutator('export function f(bus) {\n  bus.on(404, () => "a")\n}\n', 'StringLiteral')
    const flagged = await byMutator('export function f(bus) {\n  bus.on(true, () => "b")\n}\n', 'StringLiteral')

    expect(numbered.map((one) => one.scope)).toEqual([['f', 'ArrowFunction 2/2 in bus.on(404)']])
    expect(flagged.map((one) => one.scope)).toEqual([['f', 'ArrowFunction 2/2 in bus.on(true)']])
  })

  it('counts a top-level statement as sitting in no declaration at all', async () => {
    const [top] = await byMutator('export const greeting = "top"\n', 'StringLiteral')

    expect(top.scope).toEqual([])
  })

  /* ⚠️ **A MUTANT OF A WHOLE SCOPE IS IN THAT SCOPE, NOT BESIDE IT.** An
     `ArrowFunction` mutant replaces the arrow entire, so its text begins exactly
     where the arrow does — and a walk that descended only into children beginning
     STRICTLY before it would stop at the declaration above, leaving two arrows
     of the same text in the same nameless place and each able to answer for the
     other. */
  it('names the arrow a whole-arrow mutant replaces, though the mutant begins exactly where the arrow does', async () => {
    const arrows = await byMutator('export const pick = () => 1\nexport const other = () => 1\n', 'ArrowFunction')

    expect(arrows.map((one) => [one.original, one.scope])).toEqual([
      ['( ) => 1', ['pick']],
      ['( ) => 1', ['other']],
    ])
  })

  /* ⚠️ **TEXT SPANNING TWO DECLARATIONS SITS IN NEITHER.** A node holding a
     mutant must begin before it AND end after it. Asked only about the end, the
     first sibling reaching past the mutant would claim it, and a survivor would
     be filed under a declaration it is only half inside. */
  it('counts a mutant whose text spans two declarations as sitting in neither', () => {
    const source = 'export function one() {\n  return 1\n}\nexport function two() {\n  return 2\n}\n'
    const spanning = { mutatorName: 'BlockStatement', replacement: '{}', location: { start: { line: 2, column: 3 }, end: { line: 5, column: 11 } } }

    expect(survivorIdentity(spanning, source, 'subject.ts')).toEqual({
      mutatorName: 'BlockStatement',
      replacement: '{}',
      original: 'return 1\n}\nexport function two ( ) {\nreturn 2',
      /* Nothing encloses it, so there is no statement to name and its own text
         answers for it — the same answer as a mutant of a whole scope. */
      statement: 'return 1\n}\nexport function two ( ) {\nreturn 2',
      scope: [],
    })
  })

  /* Re-indenting is not rewriting: a block that moves under a new guard, or a
     file run through a formatter, keeps every line break it had and changes only
     the spaces around them, so it is the same code and keeps its pairing. */
  it('reads any run of spaces around a line break as that one break, however deeply the code is indented', async () => {
    const [tight] = await byMutator('export function f() {\n  return "x"\n}\n', 'BlockStatement')
    const [loose] = await byMutator('export function f() {\n\n      return "x"\n\n}\n', 'BlockStatement')

    expect(tight).toEqual(loose)
    expect(tight.original).toBe('{\nreturn "x"\n}')
  })

  /* ⚠️ **SPACING WITHIN A LINE IS WHAT THE OLD RULE FAILED AT.** `\s*[\n\r]\s*`
     as one space left `a+b` and `a + b` two identities for one expression, so a
     formatter that spaced an operator billed the change for the debt under it —
     which is the very case a normalisation exists for. */
  it('reads any spacing within a line as one space, so a formatter’s operator keeps its pairing', async () => {
    const [spaced] = await byMutator('export const g = (a, b) => a  +  b\n', 'ArithmeticOperator')
    const [tightly] = await byMutator('export const g = (a, b) => a+b\n', 'ArithmeticOperator')
    const [plain] = await byMutator('export const g = (a, b) => a + b\n', 'ArithmeticOperator')

    expect(spaced).toEqual(plain)
    expect(tightly).toEqual(plain)
    expect(plain.original).toBe('a + b')
  })

  /* ⚠️ **A LINE BREAK INSIDE A LITERAL IS PART OF THE STRING, AND THE OLD RULE
     READ IT AS A SPACE** (review, 2026-09-17, reproduced against the
     instrumenter): two templates carrying different text had one identity, so a
     survivor of one answered for a survivor of the other. A token's own text is
     carried exactly as it was written. */
  it('separates two templates whose text differs only by a line break, which is text and not layout', async () => {
    const [across] = await byMutator('export const t = (n) => `a\nb`\n', 'StringLiteral')
    const [along] = await byMutator('export const t = (n) => `a b`\n', 'StringLiteral')

    expect(across.original).toBe('`a\nb`')
    expect(along.original).toBe('`a b`')
    expect(across).not.toEqual(along)
  })

  /* ⚠️ **AND A LINE BREAK BETWEEN TWO TOKENS CAN BE A STATEMENT ENDING.**
     `return` ⏎ `1` returns nothing and `return 1` returns 1 — automatic semicolon
     insertion, and one identity for both until the break was kept. */
  it('separates a return a line break ends from one that carries a value, which the same tokens spell', async () => {
    const [split] = await byMutator('export function f() {\n  return\n  1\n}\n', 'BlockStatement')
    const [carried] = await byMutator('export function f() {\n  return 1\n}\n', 'BlockStatement')

    expect(split.original).toBe('{\nreturn\n1\n}')
    expect(carried.original).toBe('{\nreturn 1\n}')
    expect(split).not.toEqual(carried)
  })

  /**
   * ## The statement the mutated text sits in
   *
   * ⚠️ **TWO CALLS OF ONE METHOD WERE ONE DEBT, AND A DEVELOPER WAS BILLED FOR
   * BOTH** (measured 2026-09-17 on the acceptance run). The mutated text of an
   * `OptionalChaining` mutant is the callee and NOT the call, so
   * `noteRenderer?.setAttribute('max-column-count', '1')` and the `('flow',
   * 'scrolled')` line below it had one identity between them — three of them in
   * that scope, four at the merge base, and every one refused as ambiguous
   * although not a character of any had changed. These are the run's own two
   * lines.
   */
  it('separates two calls of one method that differ only in what they are passed', async () => {
    const source =
      'export function f(noteRenderer) {\n' +
      "  noteRenderer?.setAttribute('max-column-count', '1')\n" +
      "  noteRenderer?.setAttribute('flow', 'scrolled')\n" +
      '}\n'

    const chained = await byMutator(source, 'OptionalChaining')

    expect(chained.map((one) => one.original)).toEqual(['noteRenderer ?. setAttribute', 'noteRenderer ?. setAttribute'])
    expect(chained.map((one) => one.statement)).toEqual([
      "noteRenderer ?. setAttribute ( 'max-column-count' , '1' )",
      "noteRenderer ?. setAttribute ( 'flow' , 'scrolled' )",
    ])
    expect(chained[0]).not.toEqual(chained[1])
  })

  /* ⚠️ **AND THREE SPELLINGS OF ONE GUARD ARE STILL ONE IDENTITY, BY
     CONSTRUCTION.** `runSearch`'s three `if (signal.aborted) return` are the same
     statement, mutated the same way, in the same scope: no text can tell them
     apart, which is why `matchedSurvivors` counts them rather than refusing them.
     The claim that they collide is measured here rather than assumed. */
  it('gives three identical statements in one scope one identity between them', async () => {
    const source = 'export function runSearch(signal) {\n' + '  if (signal.aborted) return\n'.repeat(3) + '}\n'

    const guards = (await identifiedIn(source)).filter((one) => one.original === 'signal . aborted')

    expect(guards.map((one) => one.statement)).toEqual(Array.from({ length: 6 }, () => 'if ( signal . aborted ) return'))
    expect([...new Set(guards.map((one) => one.replacement))].sort()).toEqual(['false', 'true'])
    expect(new Set(guards.map((one) => JSON.stringify(one))).size).toBe(2)
  })

  /* A statement is asked for INSIDE the mutant's own scope, so a guard that moved
     under another guard — deeper indentation, the same statement — keeps its
     pairing, exactly as the text of the mutant itself does. */
  it('reads a statement’s indentation as layout, so one moved under a new guard keeps its pairing', async () => {
    const [flat] = await byMutator('export function f(go) {\n  go("x")\n}\n', 'StringLiteral')
    const [nested] = await byMutator('export function f(go) {\n  if (go) {\n        go("x")\n  }\n}\n', 'StringLiteral')

    expect(flat.statement).toBe('go ( "x" )')
    expect(nested).toEqual(flat)
  })

  /**
   * ⚠️ **A CLASS IS A STATEMENT, AND TAKING ONE WOULD BE AN IDENTITY OF 68 593
   * CHARACTERS** (measured on `src/kernel/ui/reader/session.ts`, whose
   * `#disposed = false` is the file's one mutant sitting in no statement of its
   * own scope, and whose only other is a default parameter's value). Every edit
   * anywhere in the class would then re-bill it — the exact complaint this
   * comparison exists to answer, wearing the fix's own clothes.
   *
   * So the walk stops at the scope the mutant sits in, and what it answers there
   * is the smallest thing written around the mutant that the scope is made of:
   * the field, the parameter.
   */
  it('names the field a class holds rather than the whole class, and a parameter rather than the whole function', async () => {
    const source = 'export class Reader {\n  #disposed = false\n}\nexport function attach(view, remove = false) {\n  return [view, remove]\n}\n'

    const booleans = await byMutator(source, 'BooleanLiteral')

    expect(booleans.map((one) => [one.scope, one.statement])).toEqual([
      [['Reader'], '#disposed = false'],
      [['attach'], 'remove = false'],
    ])
  })

  /* ⚠️ **THE ACCEPTANCE RUN'S OWN PREMISE, MEASURED.** It adds ONE COMMENT to an
     untouched file and asks what that costs — which is a question about this
     field, since a statement's span begins after its leading trivia. Between two
     statements a comment changes nothing. INSIDE one it is an edit: two tokens
     that sat on one line now sit on two, so the statement's text changes and
     every survivor in it is re-billed. */
  it('reads a comment between two statements as no change, and one written inside a statement as a change', async () => {
    const [plain] = await byMutator('export function f(go) {\n  go("x", 1)\n}\n', 'StringLiteral')
    const [after] = await byMutator('export function f(go) {\n  // a note\n  go("x", 1)\n}\n', 'StringLiteral')
    const [within] = await byMutator('export function f(go) {\n  go("x",\n  // a note\n  1)\n}\n', 'StringLiteral')

    expect(after).toEqual(plain)
    expect(within.statement).toBe('go ( "x" ,\n1 )')
    expect(within).not.toEqual(plain)
  })

  /* And a mutant OF a whole scope sits in no statement of that scope either — the
     arrow is the scope. Its own text is the answer, which is what it would have
     been with no statement at all, and `scope` is what tells two of them apart. */
  it('answers a whole-arrow mutant with its own text, since the arrow is the scope it would ask', async () => {
    const arrows = await byMutator('export const pick = () => 1\nexport const other = () => 1\n', 'ArrowFunction')

    expect(arrows.map((one) => one.statement)).toEqual(['( ) => 1', '( ) => 1'])
    expect(arrows[0]).not.toEqual(arrows[1])
  })

  /* The subject is parsed as its own name says, because a `.tsx` read as a `.ts`
     is another tree: `<b>` is a type assertion there, `call("x")` becomes a
     method of an object literal, and what encloses the mutant changes with it. */
  it('parses the subject by its own name, so JSX in a .tsx file is JSX', async () => {
    const source = 'export const View = () => <b>{call("x")}</b>\n'

    await inScratch('mutants-jsx-', async (root) => {
      const at = plant(root, { 'View.tsx': source })
      const [mutant] = (await mutantIdentitiesIn(at['View.tsx'])).filter((one) => one.mutatorName === 'StringLiteral')

      expect(survivorIdentity(mutant, source, 'View.tsx').scope).toEqual(['View'])
      expect(survivorIdentity(mutant, source, 'View.ts').scope).toEqual(['View', 'call'])
    })
  })

  it('refuses a mutant at no place in the source rather than identifying it as nothing at all', () => {
    const mutant = { mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 9, column: 1 }, end: { line: 9, column: 4 } } }

    const refusal = thrownBy(() => survivorIdentity(mutant, 'export const a = 1\n', 'a.ts'))

    expect(refusal).toBeInstanceOf(Error)
    expect(refusal.message).toMatch(/^check-mutants: StringLiteral at 9:1-9:4 replaced with "\\"\\"" is at no place in a\.ts — /u)
  })
})

describe('which survivor at the merge base answers for which survivor here', () => {
  /** A survivor as each side of a comparison carries one. `from` is the base file that may answer for it. */
  const survivor = (file, identity = {}, from = file) => ({
    file,
    from,
    identity: { mutatorName: 'StringLiteral', replacement: '""', original: '"x"', statement: 'first ( "x" )', scope: [], ...identity },
  })
  const why = (atBase, atHead) => matchedSurvivors(atBase, atHead).added.map((one) => one.why)
  const paired = (atBase, atHead) => matchedSurvivors(atBase, atHead).authorised.map(({ base, here }) => [base.file, here.file])
  /** Every mutant of one mutator the real instrumenter makes in `source`, as survivors of `a.ts` — what a run in which none was killed leaves. */
  const survivorsOf = (source, mutatorName = 'StringLiteral') =>
    inScratch('mutants-occurrence-', async (root) => {
      const at = plant(root, { 'a.ts': source })
      const mutants = (await mutantIdentitiesIn(at['a.ts'])).filter((one) => one.mutatorName === mutatorName)
      return mutants.map((mutant) => ({ file: 'a.ts', from: 'a.ts', identity: survivorIdentity(mutant, source, 'a.ts') }))
    })

  it('answers for a survivor of the same file with the same identity, and adds nothing', () => {
    const match = matchedSurvivors([survivor('a.ts')], [survivor('a.ts')])

    expect(match.authorised).toEqual([{ base: survivor('a.ts'), here: survivor('a.ts') }])
    expect(match.added).toEqual([])
  })

  it('does not answer for a survivor whose text is not the text that was there', () => {
    expect(why([survivor('a.ts', { original: '"log"' })], [survivor('a.ts', { original: '"secret"' })])).toEqual([
      'the merge base has no survivor with this identity in a.ts',
    ])
  })

  it('does not let one mutator’s survivor answer for another’s, nor one replacement’s for another’s', () => {
    expect(why([survivor('a.ts', { mutatorName: 'BooleanLiteral' })], [survivor('a.ts', { mutatorName: 'StringLiteral' })])).toEqual([
      'the merge base has no survivor with this identity in a.ts',
    ])
    expect(why([survivor('a.ts', { replacement: 'true' })], [survivor('a.ts', { replacement: 'false' })])).toEqual([
      'the merge base has no survivor with this identity in a.ts',
    ])
  })

  it('does not let a survivor of one scope answer for the same code in another', () => {
    expect(why([survivor('a.ts', { scope: ['One', 'read'] })], [survivor('a.ts', { scope: ['Two', 'read'] })])).toEqual([
      'the merge base has no survivor with this identity in a.ts',
    ])
  })

  /* ⚠️ **AND NOT ONE STATEMENT'S FOR ANOTHER'S**, which is the whole of what the
     statement buys: the same mutated text in the same scope, in a call the merge
     base never made, is not the debt the merge base had. */
  it('does not let a survivor of one statement answer for the same code in another', () => {
    expect(why([survivor('a.ts', { statement: 'second ( "x" )' })], [survivor('a.ts', { statement: 'third ( "x" )' })])).toEqual([
      'the merge base has no survivor with this identity in a.ts',
    ])
  })

  /* ⚠️ **ONE SURVIVOR AT THE MERGE BASE ANSWERS FOR ONE HERE, AND NO MORE.**
     Otherwise copying an accepted survivor launders it into as many as the change
     cares to make. Which of the two is named decides nothing — they are the same
     statement mutated the same way in the same scope — but the count does. */
  it('answers for one of two survivors here that share an identity the merge base has once', () => {
    const match = matchedSurvivors([survivor('a.ts')], [survivor('a.ts'), survivor('a.ts')])

    expect(match.authorised).toHaveLength(1)
    expect(match.added.map((one) => one.why)).toEqual([
      'the merge base has 1 survivor(s) with this identity in a.ts, and each of them answers for another survivor here',
    ])
  })

  /* And the merge base having MORE of an identity than this change does answers
     for every one here, with nothing owed for the ones it no longer has: a
     deleted occurrence is not a debt anybody can pay. */
  it('answers for the one survivor here where the merge base had two of its identity', () => {
    const match = matchedSurvivors([survivor('a.ts'), survivor('a.ts')], [survivor('a.ts')])

    expect(match.authorised).toHaveLength(1)
    expect(match.added).toEqual([])
  })

  /**
   * ⚠️ **THE THREE GUARDS THE COUNTING IS FOR** — `runSearch`'s three
   * `if (signal.aborted) return`, which no text-based identity can tell apart.
   * Three there and three here is three answered and nothing owed; a fourth here
   * is one the merge base has nothing left for, whichever of the four is named.
   */
  it('answers for three identical survivors with the three the merge base had, and owes a fourth', () => {
    const three = () => [survivor('a.ts'), survivor('a.ts'), survivor('a.ts')]

    const kept = matchedSurvivors(three(), three())
    expect(kept.authorised).toHaveLength(3)
    expect(kept.added).toEqual([])

    const grown = matchedSurvivors(three(), [...three(), survivor('a.ts')])
    expect(grown.authorised).toHaveLength(3)
    expect(grown.added.map((one) => one.why)).toEqual([
      'the merge base has 3 survivor(s) with this identity in a.ts, and each of them answers for another survivor here',
    ])
  })

  /**
   * ⚠️ **A COUNT LAUNDERED A NEW OCCURRENCE, AND THIS IS THE SOURCE PAIR IT WAS
   * REPRODUCED WITH** (review, 2026-09-17). `second`'s deleted call and `third`'s
   * new one carried the same mutated `"x"` in the same scope, so counting two
   * against two authorised both and billed the change for nothing — the deleted
   * occurrence paying for the new one.
   *
   * The identity carries the STATEMENT now, so the two are not the same identity
   * at all: `first("x")` keeps its pairing and `third("x")` is what the change
   * added. The identities are built here by the real instrumenter rather than
   * written by hand, because the whole claim is about what it makes of these two.
   */
  it('adds a new occurrence the merge base never had, and keeps the pairing of the one beside it', async () => {
    const wasThere = 'export function f(first, second, third) {\n  first("x")\n  second("x")\n}\n'
    const isHere = 'export function f(first, second, third) {\n  first("x")\n  third("x")\n}\n'

    const [atBase, atHead] = await Promise.all([survivorsOf(wasThere), survivorsOf(isHere)])

    expect(atBase).toHaveLength(2)
    expect(atBase.map((one) => one.identity.statement)).toEqual(['first ( "x" )', 'second ( "x" )'])
    expect(atHead.map((one) => one.identity.statement)).toEqual(['first ( "x" )', 'third ( "x" )'])
    const match = matchedSurvivors(atBase, atHead)
    expect(match.authorised.map(({ here }) => here.identity.statement)).toEqual(['first ( "x" )'])
    expect(match.added.map((one) => [one.here.identity.statement, one.why])).toEqual([
      ['third ( "x" )', 'the merge base has no survivor with this identity in a.ts'],
    ])
  })

  /**
   * ⚠️ **AND THE STATEMENT ANSWERS NOTHING INSIDE A CALLBACK, BECAUSE THE
   * CALLBACK IS THE SCOPE** (review, 2026-09-17, reproduced against the real
   * instrumenter). `first(() => false)` and `second(() => false)` each hold their
   * mutant in a statement of `false` — the body of the arrow, which is where the
   * walk stops — and the scope was `["f","ArrowFunction"]` for both, since
   * `scopeAround` keeps only the scopes it passes through and the CALL is not one.
   * So the laundering the statement closed everywhere else stood open here, in the
   * shape most of this tree's code is written in.
   *
   * The call is in the anonymous scope's name now, so `second`'s deleted callback
   * answers for nothing and `third`'s new one is what the change added.
   */
  it('adds a new callback the merge base never had, though nothing but the call it is passed to differs', async () => {
    const wasThere = 'export function f(first, second, third) {\n  first(() => false)\n  second(() => false)\n}\n'
    const isHere = 'export function f(first, second, third) {\n  first(() => false)\n  third(() => false)\n}\n'

    const [atBase, atHead] = await Promise.all([survivorsOf(wasThere, 'BooleanLiteral'), survivorsOf(isHere, 'BooleanLiteral')])

    /* The mutated text and the statement are the same four times over, which is
       what left the scope carrying the whole of the difference. */
    expect(atBase.map((one) => [one.identity.original, one.identity.statement])).toEqual([
      ['false', 'false'],
      ['false', 'false'],
    ])
    expect(atBase.map((one) => one.identity.scope)).toEqual([
      ['f', 'ArrowFunction 1/1 in first()'],
      ['f', 'ArrowFunction 1/1 in second()'],
    ])
    expect(atHead.map((one) => one.identity.scope)).toEqual([
      ['f', 'ArrowFunction 1/1 in first()'],
      ['f', 'ArrowFunction 1/1 in third()'],
    ])
    const match = matchedSurvivors(atBase, atHead)
    expect(match.authorised.map(({ here }) => here.identity.scope)).toEqual([['f', 'ArrowFunction 1/1 in first()']])
    expect(match.added.map((one) => [one.here.identity.scope, one.why])).toEqual([
      [['f', 'ArrowFunction 1/1 in third()'], 'the merge base has no survivor with this identity in a.ts'],
    ])
  })

  /**
   * ## What the count gives up, measured rather than described
   *
   * ⚠️ **"SWAPPING ONE FOR ANOTHER CHANGES NOTHING A READER COULD OBSERVE" WAS
   * FALSE, AND BOTH THIS FILE AND THE ADR SAID IT** (review, 2026-09-17). The
   * identity carries the NEAREST statement and the scope, and nothing between
   * them — so `emit("x")` and `if (isAdmin) emit("x")` are one identity, because
   * the nearest statement of the second is still `emit("x")`. Three identical
   * calls at the merge base therefore answer for three here even where one of them
   * is now guarded, which is plainly something a reader can observe.
   *
   * It is the SAME weakness the re-indentation rule already takes deliberately — a
   * statement moved under a new guard keeps its pairing — said at its full width.
   * The alternative is to put what encloses a statement into the identity, which
   * makes an edit anywhere in an enclosing `switch` or `if` re-bill every mutant
   * under it: the file-wide re-billing this whole comparison exists to answer.
   *
   * What the count does NOT give up is the second case here: a call to a different
   * function is a different statement, and the multiset gains one.
   */
  it('authorises a statement moved under a new guard, and adds one whose call changed', async () => {
    const three = 'export function f(emit) {\n  emit("x")\n  emit("x")\n  emit("x")\n}\n'
    const guarded = 'export function f(emit, isAdmin) {\n  emit("x")\n  emit("x")\n  if (isAdmin) emit("x")\n}\n'
    const renamed = 'export function f(emit, other) {\n  emit("x")\n  emit("x")\n  other("x")\n}\n'

    const [atBase, underGuard, elsewhere] = await Promise.all([survivorsOf(three), survivorsOf(guarded), survivorsOf(renamed)])

    expect(underGuard.map((one) => one.identity.statement)).toEqual(['emit ( "x" )', 'emit ( "x" )', 'emit ( "x" )'])
    const kept = matchedSurvivors(atBase, underGuard)
    expect(kept.authorised).toHaveLength(3)
    expect(kept.added).toEqual([])

    expect(elsewhere.map((one) => one.identity.statement)).toEqual(['emit ( "x" )', 'emit ( "x" )', 'other ( "x" )'])
    const grew = matchedSurvivors(atBase, elsewhere)
    expect(grew.authorised).toHaveLength(2)
    expect(grew.added.map((one) => [one.here.identity.statement, one.why])).toEqual([
      ['other ( "x" )', 'the merge base has no survivor with this identity in a.ts'],
    ])
  })

  it('does not let a survivor of one file answer for the same one in a file that came from somewhere else', () => {
    expect(why([survivor('a.ts')], [survivor('b.ts')])).toEqual(['the merge base has no survivor with this identity in b.ts'])
  })

  it('answers for a survivor that moved into a file the merge base does not have', () => {
    expect(paired([survivor('session.ts')], [survivor('sessionHelpers.ts', {}, 'session.ts')])).toEqual([['session.ts', 'sessionHelpers.ts']])
  })

  /* ⚠️ **THE FILE IT WAS ALREADY IN TAKES ITS OWN SURVIVORS FIRST**, so a file
     copied rather than split keeps its own debt and the copy owes what it added.
     Both passes are needed: one pass by origin alone would hand the copy the
     survivor its source still has. */
  it('gives a file its own survivors before a file that was copied from it', () => {
    const match = matchedSurvivors(
      [survivor('session.ts')],
      [survivor('sessionHelpers.ts', {}, 'session.ts'), survivor('session.ts')],
    )

    expect(match.authorised.map(({ here }) => here.file)).toEqual(['session.ts'])
    expect(match.added.map((one) => [one.here.file, one.why])).toEqual([
      ['sessionHelpers.ts', 'the merge base has 1 survivor(s) with this identity in session.ts, and each of them answers for another survivor here'],
    ])
  })

  /* ⚠️ **AND ONE SURVIVOR AT THE MERGE BASE CANNOT BE IN TWO FILES AT ONCE.** A
     change that copies a file twice owes the second copy: the pool is spent
     across the whole sweep, so the guarantee holds over the pair rather than
     being spent once in each. */
  it('answers for one of two files copied from one, since one survivor cannot be in both', () => {
    const match = matchedSurvivors(
      [survivor('session.ts')],
      [survivor('one.ts', {}, 'session.ts'), survivor('two.ts', {}, 'session.ts')],
    )

    expect(match.authorised.map(({ here }) => here.file)).toEqual(['one.ts'])
    expect(match.added.map((one) => [one.here.file, one.why])).toEqual([
      ['two.ts', 'the merge base has 1 survivor(s) with this identity in session.ts, and each of them answers for another survivor here'],
    ])
  })

  it('says a file the merge base has no origin for has nothing there to answer for it', () => {
    expect(why([survivor('a.ts')], [survivor('new.ts', {}, null)])).toEqual([
      'it is in a file the merge base does not have, and git names no file it was copied or renamed from',
    ])
  })

  /**
   * ## The two ways a survivor here goes unanswered, which are different sentences
   *
   * ⚠️ **A MUTANT THE MERGE BASE COULD NOT DECIDE IS NOT A MUTANT THIS CHANGE
   * ADDED**, and until this distinction existed it was billed as one — worse, a
   * single undecided mutant refused the whole file, so 540 survivors the merge
   * base had decided perfectly well went with it. Neither class authorises
   * anything and both fail the build; what differs is what a reader is told to do,
   * and a reader acts differently on the two.
   */
  /** A mutant the merge base could not decide, as `survivorsAtBase` names one: a survivor's fields, and the base's own reason. */
  const undecided = (file, identity = {}, reason = 'its settle run met the same wall-clock timeout again at 1:22') => ({
    ...survivor(file, identity),
    at: '1:22',
    why: reason,
  })

  it('names a survivor the merge base could not decide its own way, rather than as one this change added', () => {
    const match = matchedSurvivors([], [survivor('a.ts')], [undecided('a.ts')])

    expect(match.authorised).toEqual([])
    expect(match.added.map((one) => [one.class, one.why])).toEqual([
      [
        'undecided',
        'the merge base could not decide this mutant in a.ts: its settle run met the same wall-clock timeout again at 1:22',
      ],
    ])
  })

  /* ⚠️ **AND WHAT THE MERGE BASE DID DECIDE STILL ANSWERS.** This is the whole
     point of the split: one mutant it could not answer for leaves every other
     mutant of that file exactly where it was. Measured on a real 1 403-mutant
     file, five undecided mutants had made 540 decided ones worthless. */
  it('authorises the survivors the merge base decided, and refuses only the identity it could not', () => {
    const decided = { original: '"kept"' }
    const match = matchedSurvivors(
      [survivor('a.ts', decided), survivor('a.ts', { original: '"also"' })],
      [survivor('a.ts', decided), survivor('a.ts', { original: '"also"' }), survivor('a.ts', { original: '"timed out"' })],
      [undecided('a.ts', { original: '"timed out"' })],
    )

    expect(match.authorised.map(({ here }) => here.identity.original)).toEqual(['"kept"', '"also"'])
    expect(match.added.map((one) => [one.here.identity.original, one.class])).toEqual([['"timed out"', 'undecided']])
  })

  /* A survivor nothing at the merge base could answer for, in a file where
     nothing was left undecided, is the other sentence — and it is the one that
     says this change added it. */
  it('names a survivor the merge base plainly did not have as one this change added', () => {
    const match = matchedSurvivors([], [survivor('a.ts')], [undecided('a.ts', { original: '"elsewhere"' })])

    expect(match.added.map((one) => [one.class, one.why])).toEqual([
      ['added', 'the merge base has no survivor with this identity in a.ts'],
    ])
  })

  /* An undecided mutant travels with the file it was measured in, exactly as a
     survivor does: a file renamed or copied asks the file it came FROM. */
  it('takes an undecided mutant from the file a survivor here was renamed from', () => {
    const match = matchedSurvivors([], [survivor('sessionHelpers.ts', {}, 'session.ts')], [undecided('session.ts')])

    expect(match.added.map((one) => [one.class, one.why])).toEqual([
      [
        'undecided',
        'the merge base could not decide this mutant in session.ts: its settle run met the same wall-clock timeout again at 1:22',
      ],
    ])
  })

  /**
   * ⚠️ **ONE UNDECIDED OCCURRENCE EXCUSED THE DIAGNOSIS OF UNLIMITED ONES**
   * (review, 2026-09-17). The unknowns were a map, looked up and never spent, so
   * one mutant the merge base could not decide said "the merge base could not
   * decide this mutant" over two survivors here — a sentence about a mutant it
   * has only one of. Neither passed, so nothing was authorised that should not
   * have been; what was wrong is what a reader was told, and a reader acts on it.
   *
   * They are spent one-to-one now, exactly as survivors are, and what is left over
   * falls back to the count it is really against.
   */
  it('spends an undecided mutant one to one, so a second survivor here is not excused by the same one', () => {
    const match = matchedSurvivors([], [survivor('a.ts'), survivor('a.ts')], [undecided('a.ts')])

    expect(match.authorised).toEqual([])
    expect(match.added.map((one) => [one.class, one.why])).toEqual([
      ['undecided', 'the merge base could not decide this mutant in a.ts: its settle run met the same wall-clock timeout again at 1:22'],
      [
        'added',
        'the merge base has no survivor with this identity in a.ts, and the 1 mutant(s) it could not decide there each answer for another survivor here',
      ],
    ])
  })

  /* And the same count beside a survivor the merge base DID have: one answered,
     one undecided, one owed — three different sentences over one identity. */
  it('names each of three survivors here against what the merge base had of that identity, one apiece', () => {
    const match = matchedSurvivors([survivor('a.ts')], [survivor('a.ts'), survivor('a.ts'), survivor('a.ts')], [undecided('a.ts')])

    expect(match.authorised).toHaveLength(1)
    expect(match.added.map((one) => [one.class, one.why])).toEqual([
      ['undecided', 'the merge base could not decide this mutant in a.ts: its settle run met the same wall-clock timeout again at 1:22'],
      [
        'added',
        'the merge base has 1 survivor(s) with this identity in a.ts, and each of them answers for another survivor here, and the 1 mutant(s) it could not decide there each answer for another survivor here',
      ],
    ])
  })

  /* ⚠️ **AND AN UNDECIDED IDENTITY IS NOT A SURVIVOR AT THE MERGE BASE**, so it
     answers for nothing: a mutant it could not decide in `a.ts` says nothing
     about the same code in `b.ts`, which is where the pairing would otherwise
     spend it. */
  it('lets an undecided mutant authorise nothing, in its own file or in any other', () => {
    const match = matchedSurvivors([], [survivor('b.ts')], [undecided('a.ts')])

    expect(match.authorised).toEqual([])
    expect(match.added.map((one) => [one.class, one.why])).toEqual([['added', 'the merge base has no survivor with this identity in b.ts']])
  })
})

/**
 * ⚠️ **A HELPER THAT RESOLVED `node_modules` AGAINST `process.cwd()` MADE TWO
 * FILES UNMEASURABLE AT THE MERGE BASE** (2026-09-17, reproduced before it was
 * fixed). `checkout()` passed the bare name `node_modules` through
 * `path.resolve`, which resolves it against the working directory. Run from the
 * repository that is the repository's own install; run from anywhere else it is
 * a path that does not exist, and the link dangles.
 *
 * Where that bites is not obvious, which is why it stood: measuring a module the
 * GATE imports — `lib/entry.mjs`, `lib/specifiers.mjs` — sweeps this gate's own
 * test files, inside a Stryker sandbox whose cwd is not the repository. Every
 * case that loads the generated config then died with `Cannot find package
 * 'vitest' imported from <scratch>/vitest.mutants.mjs.timestamp-*.mjs`, the base
 * measurement refused, and those two files could never be authorised for
 * anything — so touching either billed its whole self.
 *
 * The fix is one expression and the trap is the shape, so this refuses the shape
 * wherever it comes back. The files are read through a path built from a
 * DIRECTORY LISTING, deliberately: `pathsRead` cannot resolve one, so this test
 * blocks no subject from being mutated — a check that silently stopped the
 * gate's own tests from running against it would cost more than it saves.
 */
describe('what a scratch checkout links its dependencies from', () => {
  it('never resolves node_modules against the directory the process happens to be started in', () => {
    /* Built rather than written, so this test is not its own first offender —
       the literal it looks for would otherwise be in the file doing the looking. */
    const cwdBound = new RegExp(String.raw`resolve\((['"])node_modules\1\)`)
    const here = fileURLToPath(new URL('.', import.meta.url))
    const offenders = readdirSync(here)
      .filter((name) => name.endsWith('.test.mjs'))
      .filter((name) => cwdBound.test(readFileSync(path.join(here, name), 'utf8')))

    expect(offenders).toEqual([])
  })

  /* ⚠️ **AND A FIXED DEPTH IS THE SAME TRAP ONE STEP REMOVED** (2026-09-18). A
     sweep found five: `THIS_INSTALL` in `check-mutants.base.test.mjs`, and four
     kernel tests that read `foliate-js` through `../../../node_modules/…`. From
     inside the Stryker sandbox of a merge-base worktree, which has no install of
     its own, each named nothing — the gate's own base measurement died on the
     first, and a base measurement of any file the other four cover would have. An
     install is searched for upwards — `installAbove`, or Node's own
     `import.meta.resolve` — and never reached by counting directories. Every test
     file in the checkout is read, through paths built from a listing for the
     reason above. */
  it('never reaches an install by a fixed number of directories up', () => {
    /* The directory itself or anything in it: `'../node_modules'` was the shape
       that started this, and a pattern wanting a `/` after the name missed it —
       found by trying the pattern on the five before trusting it on none. */
    const fixedDepth = new RegExp(String.raw`new URL\(\s*(['"\x60])(?:\.\.?/)+node_modules(?:/|\1)`)
    const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
    const offenders = ['scripts', 'src']
      .flatMap((top) => readdirSync(path.join(root, top), { recursive: true }).map((name) => path.join(top, String(name))))
      .filter((name) => /\.test\.(?:ts|tsx|mjs)$/u.test(name))
      .filter((name) => fixedDepth.test(readFileSync(path.join(root, name), 'utf8')))

    expect(offenders).toEqual([])
  })
})

/**
 * The nearest `node_modules` at or above `from`, which is the one Node resolves
 * this file's own imports through. Searched rather than assumed: see `checkout`.
 */
function installAbove(from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.join(dir, 'node_modules')
    if (existsSync(at)) return at
    if (path.dirname(dir) === dir) throw new Error(`no node_modules at or above ${from}`)
  }
}
