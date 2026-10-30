import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A SwiftPM dependency of THIS repository may not float.
 *
 * ⚠️ **`swift/QwenKit/Package.swift` DEPENDED ON `branch: "main"` UNTIL
 * 2026-09-29, AND WHAT THAT DECIDED WAS THE SWIFT VERSION EVERY MACHINE NEEDS.**
 * `mlx-audio-swift` declares `swift-tools-version: 6.2`; the `mlx-swift` its
 * manifest asks for declares **6.3**, and 6.3 is the floor `verify.yml` asserts a
 * runner's Xcode against. So the requirement on one line of one manifest decided
 * which Xcode the CI image must carry — and a branch names no upper bound, so any
 * resolution takes whatever is on it at that moment.
 *
 * `Package.resolved` is tracked, which is why nothing had actually drifted: the
 * pin equalled the branch tip. A lock is not a bound, though. It is rewritten by
 * every resolution that finds it stale, and the manifest is what a resolution
 * obeys. Measured the day this was written: deleting the lock and resolving again
 * kept the pinned revision AND moved `swift-collections` 1.7.0 -> 1.7.1, which is
 * what an unreviewed re-resolution looks like even when nothing is wrong.
 *
 * WHAT IS REFUSED, AND WHERE THE RULE STOPS
 *
 * A `branch:` requirement, in any manifest this repository owns. NOT `from:` or
 * `.upToNextMajor` — those bound the major version and `Package.resolved` fixes
 * the rest, so they are reproducible in the way a branch is not. Nothing here
 * declares one today; the rule is about the UNBOUNDED case, deliberately, rather
 * than about pinning as a style.
 *
 * Two more things are checked because a pin nobody resolved is not a pin: a
 * `revision:` in a manifest must equal the revision `Package.resolved` records
 * for that same package, and no pin's state may still carry a `branch` key.
 *
 * ⚠️ **COMMENTS ARE BLANKED BEFORE THE SCAN, AND THAT IS LOAD-BEARING RATHER
 * THAN TIDY.** The manifest this exists for explains the rule in a comment, and
 * explaining it means writing the refused word — the trap this repository has
 * sprung four times (`notify.test.ts` reporting its own explanation, the
 * `@vitest-environment` docblock that WAS the docblock, `Stryker disable` in
 * prose, and `check-dead-css`'s reason for blanking comments). A scanner that
 * reads raw text reports the paragraph saying not to do the thing.
 *
 * ⚠️ **AND THE BLANKING HAS TO KNOW ABOUT STRINGS.** Every dependency line holds
 * `https://…`, so a stripper that treats `//` as a comment start wherever it
 * finds one eats the URL the identity is read from — and then the revision check
 * matches nothing and passes for free. `withoutComments` tracks string literals
 * for that reason. It does not handle Swift's raw (`#"…"#`) or multi-line
 * (`"""`) strings; no manifest here uses either, and a manifest that did would
 * need this extended rather than trusted.
 */

/** Where this repository keeps its own Swift packages. */
const SWIFT_ROOT = 'src-tauri/crates'

/**
 * The crate those packages live in, named because the deletion proof cannot be
 * asked.
 *
 * ⚠️ **`capability:remove voices` DELETES THIS DIRECTORY, AND `swift/QwenKit` IS
 * INSIDE IT** — so in that copy of the tree there is genuinely no manifest to
 * find, and the non-vacuity case below is false of the copy while staying true of
 * this repository. Measured 2026-09-29: the case failed there with `expected 0 to
 * be greater than 0` after `circle`, `passages` and `public` had all passed,
 * because those three do not touch this crate.
 *
 * Naming the crate rather than skipping on `PAPER_VERIFY_WITHOUT` alone keeps the
 * relaxation exact: every other removal, `passages` and `webhost` included, must
 * still find a manifest. And the pin cannot go stale, because
 * `keeps its Swift packages where the relaxation says` asserts every manifest
 * found is under it — which is a statement about what WAS found, so it holds in
 * the real tree and vacuously in the copy that has none.
 */
const SWIFT_CRATE = `${SWIFT_ROOT}/tauri-plugin-voices`

/** `verify:without` sets this to the directories the removal deleted. */
const DELETED_DIRS_ENV = 'PAPER_VERIFY_WITHOUT_DIRS'

/** Repo-relative directories the deletion proof removed, `[]` in the real tree. */
function deletedDirs() {
  const raw = process.env[DELETED_DIRS_ENV]
  return raw === undefined ? [] : raw.split(':').filter((one) => one !== '')
}

/** Never descend into these: `.build` holds every dependency's OWN manifest. */
const NOT_OURS = new Set(['.build', 'node_modules', '.git', 'target'])

/**
 * `text` with every comment replaced by spaces, string literals left intact.
 *
 * Spaces rather than removal so a reported line number is still the file's.
 */
export function withoutComments(text) {
  let out = ''
  let at = 0
  let inString = false
  let inLine = false
  let depth = 0
  while (at < text.length) {
    const here = text[at]
    const next = text[at + 1]
    const keep = here === '\n'
    if (inLine) {
      if (here === '\n') inLine = false
      out += keep ? here : ' '
      at += 1
    } else if (depth > 0) {
      if (here === '*' && next === '/') {
        depth -= 1
        out += '  '
        at += 2
      } else if (here === '/' && next === '*') {
        depth += 1
        out += '  '
        at += 2
      } else {
        out += keep ? here : ' '
        at += 1
      }
    } else if (inString) {
      if (here === '\\') {
        out += text.slice(at, at + 2)
        at += 2
      } else {
        if (here === '"') inString = false
        out += here
        at += 1
      }
    } else if (here === '"') {
      inString = true
      out += here
      at += 1
    } else if (here === '/' && next === '/') {
      inLine = true
      out += '  '
      at += 2
    } else if (here === '/' && next === '*') {
      depth = 1
      out += '  '
      at += 2
    } else {
      out += here
      at += 1
    }
  }
  return out
}

/**
 * Every `Package.swift` this repository owns, as a REPO-relative path.
 *
 * Repo-relative rather than relative to `SWIFT_ROOT`, so a path compares directly
 * with `PAPER_VERIFY_WITHOUT_DIRS`, which is repo-relative too. Two spellings of
 * one path is the shape this repository keeps having to fix.
 */
export function manifestsIn(repoRoot) {
  const found = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(resolve(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (NOT_OURS.has(entry.name)) continue
      /* Forward slashes always: `globSync` and `join` answer in the platform's
         separator, and comparing `crates\a` with `crates/a` is how a Windows leg
         reported a file as missing that was right there. */
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name === 'Package.swift') found.push(child)
    }
  }
  walk(SWIFT_ROOT)
  return found
}

/** SwiftPM's identity for a dependency URL: the last component, folded, no `.git`. */
export function identityOf(url) {
  const last = url.replace(/\/+$/u, '').split('/').pop() ?? ''
  return last.replace(/\.git$/u, '').toLowerCase()
}

/**
 * Every floating or unresolved dependency requirement in one manifest's text.
 *
 * `resolved` maps identity to the revision `Package.resolved` records, or is null
 * where the package has no lock at all — which is itself reported, because a
 * manifest naming a revision nothing resolved is a pin no build has ever obeyed.
 */
export function floatingIn(text, resolved) {
  const source = withoutComments(text)
  const found = []
  /* ONE DECLARATION AT A TIME, ACROSS LINES. `.package(` arguments are commonly
     wrapped, so a line-oriented read sees a URL on one line and its requirement
     on another and matches neither. */
  for (const call of source.matchAll(/\.package\(([^)]*)\)/gu)) {
    const body = call[1]
    const at = source.slice(0, call.index).split('\n').length
    const url = /url:\s*"([^"]+)"/u.exec(body)?.[1]
    if (url === undefined) continue
    const identity = identityOf(url)
    if (/\bbranch:/u.test(body) || /\.branch\(/u.test(body)) {
      found.push(`${at} ${identity} is taken from a branch, which names no upper bound`)
      continue
    }
    const revision = /revision:\s*"([0-9a-f]{7,40})"/u.exec(body)?.[1]
    if (revision === undefined) continue
    const locked = resolved.get(identity)
    if (locked === undefined) {
      found.push(`${at} ${identity} is pinned to ${revision} and Package.resolved records no such package`)
    } else if (locked !== revision) {
      found.push(`${at} ${identity} is pinned to ${revision} and Package.resolved records ${locked}`)
    }
  }
  return found
}

/** identity -> revision, from a `Package.resolved` document. */
export function locksIn(json) {
  const locks = new Map()
  for (const pin of JSON.parse(json).pins ?? []) {
    locks.set(String(pin.identity).toLowerCase(), pin.state?.revision)
  }
  return locks
}

/** Every pin whose state still names a branch. */
export function branchedIn(json) {
  return (JSON.parse(json).pins ?? [])
    .filter((pin) => pin.state?.branch !== undefined)
    .map((pin) => `${pin.identity} is locked to branch ${pin.state.branch}`)
}

describe('no Swift dependency of this repository floats', () => {
  const root = resolve(import.meta.dirname, '..')

  /**
   * ⚠️ **SKIPPED ONLY WHERE THE REMOVAL TOOK THE PACKAGES, AND THROUGH THE TEST'S
   * OWN `context`.** Never `it.skipIf`: `vitest list` drops those, and
   * `check-test-ledger` then reads a dropped title as a test that was DELETED. The
   * Windows cases in this tree skip the same way for the same reason.
   */
  it('finds the manifests at all', (context) => {
    if (deletedDirs().includes(SWIFT_CRATE)) {
      context.skip(`capability:remove voices deletes ${SWIFT_CRATE}, where this repository keeps its Swift packages, so the copy has none — the real tree's pnpm verify runs this`)
      return
    }
    /* A walk that finds nothing passes every assertion below it. */
    expect(manifestsIn(root).length).toBeGreaterThan(0)
  })

  /**
   * THE PIN ABOVE, HELD TO ITSELF. A statement about what WAS found, so it is true
   * in this tree and vacuously true in the copy that has no manifest — which is
   * why it needs no skip of its own. A Swift package added under another crate
   * fails here, saying that the relaxation above has become too broad.
   */
  it('keeps its Swift packages where the relaxation says', () => {
    const stray = manifestsIn(root).filter((rel) => !rel.startsWith(`${SWIFT_CRATE}/`))
    expect(stray, `a Swift package outside ${SWIFT_CRATE} means the skip above now excuses too much`).toEqual([])
  })

  it('pins every dependency to something with an upper bound, and to what is locked', () => {
    const offenders = manifestsIn(root).flatMap((rel) => {
      const text = readFileSync(resolve(root, rel), 'utf8')
      const lockPath = resolve(root, rel.replace(/Package\.swift$/u, 'Package.resolved'))
      let locks = new Map()
      try {
        if (statSync(lockPath).isFile()) locks = locksIn(readFileSync(lockPath, 'utf8'))
      } catch {
        /* No lock beside the manifest. A `revision:` is then reported below as a
           pin nothing resolved, which is the finding rather than an excuse. */
      }
      return floatingIn(text, locks).map((where) => `${rel}:${where}`)
    })
    expect(
      offenders,
      'a branch names no upper bound, so any resolution takes whatever is on it — pin a revision and resolve it',
    ).toEqual([])
  })

  it('leaves no branch in a lock either', () => {
    const offenders = manifestsIn(root).flatMap((rel) => {
      const lockPath = resolve(root, rel.replace(/Package\.swift$/u, 'Package.resolved'))
      try {
        if (!statSync(lockPath).isFile()) return []
      } catch {
        return []
      }
      return branchedIn(readFileSync(lockPath, 'utf8')).map((what) => `${rel}: ${what}`)
    })
    expect(offenders, 'a lock that remembers a branch disagrees with a manifest that pins a revision').toEqual([])
  })

  /* NON-VACUITY, on every claim the scan makes. A detector that finds nothing
     looks exactly like a clean result — `check-browser-safe` shipped two
     confident wrong answers before it worked. */
  it('can actually see what it refuses', () => {
    const locks = new Map([['thing', 'abc1234']])
    const branched = '.package(url: "https://github.com/x/thing.git", branch: "main"),'
    expect(floatingIn(branched, locks)).toEqual(['1 thing is taken from a branch, which names no upper bound'])
    const dotted = '.package(url: "https://github.com/x/thing.git", .branch("main")),'
    expect(floatingIn(dotted, locks)).toEqual(['1 thing is taken from a branch, which names no upper bound'])
    const stale = '.package(url: "https://github.com/x/thing.git", revision: "deadbee"),'
    expect(floatingIn(stale, locks)).toEqual([
      '1 thing is pinned to deadbee and Package.resolved records abc1234',
    ])
    const unknown = '.package(url: "https://github.com/x/other.git", revision: "abc1234"),'
    expect(floatingIn(unknown, locks)).toEqual([
      '1 other is pinned to abc1234 and Package.resolved records no such package',
    ])
    /* WRAPPED, which is how a real manifest writes it once a comment is added. */
    const wrapped = '.package(\n  url: "https://github.com/x/thing.git",\n  branch: "main"\n),'
    expect(floatingIn(wrapped, locks)).toEqual(['1 thing is taken from a branch, which names no upper bound'])
    expect(branchedIn('{"pins":[{"identity":"thing","state":{"branch":"main","revision":"abc1234"}}]}')).toEqual([
      'thing is locked to branch main',
    ])
  })

  it('accepts a resolved revision, and is not fooled by a comment', () => {
    const locks = new Map([['thing', 'abc1234']])
    expect(floatingIn('.package(url: "https://github.com/x/thing.git", revision: "abc1234"),', locks)).toEqual([])
    /* ⚠️ **THE MANIFEST THIS GATE EXISTS FOR EXPLAINS THE RULE, WHICH MEANS
       WRITING THE WORD.** Both comment forms, and both around a clean line. */
    const lineComment = [
      '// this used to say branch: "main", which is the whole point',
      '.package(url: "https://github.com/x/thing.git", revision: "abc1234"),',
    ].join('\n')
    expect(floatingIn(lineComment, locks)).toEqual([])
    const blockComment = [
      '/* it read .branch("main") until somebody bounded it',
      '   and branch: is what a reader will grep for */',
      '.package(url: "https://github.com/x/thing.git", revision: "abc1234"),',
    ].join('\n')
    expect(floatingIn(blockComment, locks)).toEqual([])
  })

  /* THE STRIPPER IS HELD TO THE ONE THING THAT WOULD MAKE IT FAIL OPEN. */
  it('does not eat a URL while blanking comments', () => {
    expect(withoutComments('let u = "https://github.com/x/y.git"')).toBe('let u = "https://github.com/x/y.git"')
    expect(withoutComments('a // b\nc')).toBe('a     \nc')
    expect(withoutComments('a /* b */ c')).toBe('a         c')
    // Nested block comments are legal Swift, and a reader that does not count
    // depth stops at the first close and scans the remainder as code.
    //
    // ⚠️ THIS COMMENT IS TWO `//` LINES BECAUSE THE BLOCK FORM OF IT DID EXACTLY
    // THAT TO THIS FILE. Written as `/* ... */`, the close marker it needs to
    // name ended the comment early and the rest of the sentence was parsed as
    // JavaScript — `node --check` answered "Unexpected end of input" at the last
    // line of the file, seventy lines below the cause. `AGENTS.md` records the
    // same defect from a `.gitignore` glob in a block comment.
    expect(withoutComments('a /* b /* c */ d */ e')).toBe('a                   e')
    expect(withoutComments('"a \\" // still a string"')).toBe('"a \\" // still a string"')
  })
})
