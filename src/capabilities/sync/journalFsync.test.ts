import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { absoluteIn } from './index'

/**
 * The journal's fsync path.
 *
 * THE BUG THIS EXISTS FOR, because nothing else could see it. Every path the
 * journal hands its filesystem is app-relative — the kernel's fs resolves them
 * against `BaseDirectory.AppData`, so `sync/journal.jsonl` is what the file is
 * called everywhere in this capability. `fsync` is the one call that is NOT an
 * fs-plugin call: it is the peer plugin's own command, it takes a real path,
 * and Rust's `guard_inside_root` refuses one that is not absolute.
 *
 * Handed the relative path it answered `pathNotAbsolute`, `journal.open()`
 * threw, `sync` failed to start, and `composeCapabilities` rolled the whole
 * set back — so a desktop build showed the fatal screen instead of the
 * library, with the cause two `cause` links down from the message on screen.
 *
 * The entire test suite was green throughout: every journal test injects its
 * own `fsync`, so the one seam where a relative path meets a native command
 * was exercised by nothing. Hence a source pin as well as a unit test — the
 * pin is what fails if the wiring is ever handed the raw path again.
 */

describe('absoluteIn', () => {
  it('resolves an app-relative path against the data root', () => {
    expect(absoluteIn('/Users/x/Library/Application Support/paper', 'sync/journal.jsonl')).toBe(
      '/Users/x/Library/Application Support/paper/sync/journal.jsonl',
    )
  })

  it('does not double the separator, whichever side carries it', () => {
    expect(absoluteIn('/data/', 'sync/journal.jsonl')).toBe('/data/sync/journal.jsonl')
    expect(absoluteIn('/data//', 'sync/journal.jsonl')).toBe('/data/sync/journal.jsonl')
    expect(absoluteIn('/data', '/sync/journal.jsonl')).toBe('/data/sync/journal.jsonl')
  })

  it('takes a Windows root', () => {
    expect(absoluteIn('C:\\Users\\x\\paper', 'sync/journal.jsonl')).toBe(
      'C:\\Users\\x\\paper/sync/journal.jsonl',
    )
  })

  /* A relative or blank root would silently anchor the journal to whatever the
     working directory happens to be — the failure `contentBlobPort` refuses for
     the same reason, and the one this whole file is about, wearing the other
     hat. */
  it('refuses a root that is not absolute, and one that is the filesystem root', () => {
    for (const bad of ['', 'paper', './paper', '../paper']) {
      expect(() => absoluteIn(bad, 'sync/journal.jsonl'), bad).toThrow(/absolute path/)
    }
    expect(() => absoluteIn('/', 'sync/journal.jsonl')).toThrow(/not the filesystem root/)
  })
})

describe('the journal is wired to it', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')

  /* A PIN, not a proof: it reads the wiring rather than running it, because a
     capability's tests may not import the kernel's fs double (see
     `journalFs.testkit`) and there is no other way to stand this seam up here.
     It fails on exactly the line that shipped broken. */
  it('hands the fsync hook an absolute path, never the journal’s relative one', () => {
    const hook = source.slice(source.indexOf('...(port ? { fsync'))
    expect(hook.slice(0, 200)).toMatch(/fsync:\s*async\s*\(path: string\)\s*=>\s*port\.fsync\(await absoluteInDataRoot\(path\)\)/)
    // And the raw pass-through, which is what was there, must not come back.
    expect(source).not.toMatch(/fsync:\s*\(path: string\)\s*=>\s*port\.fsync\(path\)/)
  })

  it('asks Rust for the root, once', () => {
    /* Rust's answer, not TypeScript's: a debug build may be pointed at
       `PAPER_TEST_DATA_DIR`, which only the process owning the files knows
       about — so resolving the directory on this side would disagree with it.
       Memoised, so the root is one question however many lines are appended.

       Asserted on the CODE, not on the file: a `not.toMatch` over the whole
       source would have been satisfied by the prose above it, which is how a
       negative pin comes to test its own comment. */
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).toMatch(/dataRoot \?\?= port!\.dataRoot\(\)/)
    expect(code).not.toMatch(/appDataDir/)
  })
})
