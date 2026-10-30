import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The journal's fsync path.
 *
 * THE BUG THIS EXISTED FOR, because nothing else could see it. Every path the
 * journal hands its filesystem is app-relative — the kernel's fs resolves them
 * against `BaseDirectory.AppData`, so `sync/journal.jsonl` is what the file is
 * called everywhere in this capability. `fsync` used to be the one call that
 * was NOT an fs call: the peer plugin's own command, which took a real path
 * and refused one that was not absolute. Handed the relative path it answered
 * `pathNotAbsolute`, `journal.open()` threw, `sync` failed to start, and
 * `composeCapabilities` rolled the whole set back — so a desktop build showed
 * the fatal screen instead of the library, with the cause two `cause` links
 * down from the message on screen.
 *
 * WHAT CLOSED IT FOR GOOD (WI-20.35): the barrier is the kernel's own seam
 * now — `VaultFs.fsync`, the app crate's `fsync_in_data_dir` behind it — and
 * it takes the same app-relative path every other call on `fs` takes. There
 * is no second path convention left to hand the wrong one to. The peer
 * plugin's `fs_fsync` is gone, and with it the kernel flushing through a
 * removable capability's command by string.
 *
 * The entire test suite was green throughout the original incident: every
 * journal test injects its own `fsync`, so the one seam where the journal
 * meets a native command was exercised by nothing. Hence a source pin as well
 * as the unit tests elsewhere — the pin is what fails if the wiring is ever
 * handed a path that is not the journal's own, or a barrier weaker than the
 * commit it protects.
 */

describe('the journal is wired to the kernel’s own barrier', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
  /* Asserted on the CODE, not on the file: a `not.toMatch` over the whole
     source would be satisfied by the prose above it, which is how a negative
     pin comes to test its own comment. */
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')

  it('hands the fsync hook the journal’s own path, through the filesystem it writes with, at full', () => {
    /* Both journals — the app's composition and the CLI's `openLocalJournal`
       — wire the same hook the same way. */
    const hooks = code.match(/\.\.\.\(fs\.fsync \? \{ fsync: \(path: string\) => fs\.fsync!\(path, 'full'\) \} : \{\}\)/g) ?? []
    expect(hooks).toHaveLength(2)
  })

  it('never reaches a peer port or resolves a data root for it', () => {
    /* The raw pass-through to the plugin's command, which is what shipped
       broken, and the root lookup it needed, must not come back. */
    expect(code).not.toMatch(/port\.fsync/)
    expect(code).not.toMatch(/absoluteIn/)
    expect(code).not.toMatch(/dataRoot\(\)/)
    expect(code).not.toMatch(/appDataDir/)
  })
})
