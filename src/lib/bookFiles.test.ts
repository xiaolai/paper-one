import { describe, expect, it } from 'vitest'
import { basename } from './bookFiles'

/**
 * Only `basename` is unit-tested here, and the omission is deliberate rather
 * than an oversight.
 *
 * `pickBooks` and `readBookAt` are thin wrappers over two Tauri plugins. A test
 * for them would have to stub `@tauri-apps/plugin-dialog` and
 * `@tauri-apps/plugin-fs`, and would then assert that this file calls the stubs
 * — which is a test of the mock, not of the behaviour. What can actually go
 * wrong lives on the other side of the IPC boundary: a missing capability
 * permission, a scope that excludes the chosen path, a dialog filter that hides
 * every book. None of that is reachable without the app.
 *
 * See the plan's Outstanding section for the check that does reach it.
 */

describe('basename', () => {
  it('takes the last segment of a posix path', () => {
    expect(basename('/Users/reader/Books/moby.epub')).toBe('moby.epub')
  })

  it('takes the last segment of a windows path', () => {
    expect(basename('C:\\Users\\reader\\moby.epub')).toBe('moby.epub')
  })

  it('leaves a bare name alone', () => {
    expect(basename('moby.epub')).toBe('moby.epub')
  })

  /* A name is cosmetic here — identity comes from the content — so the awkward
   * shapes must not throw on their way to becoming one. */
  it('does not throw on the awkward shapes', () => {
    expect(basename('')).toBe('')
    expect(basename('/')).toBe('')
    expect(basename('/trailing/')).toBe('')
    expect(basename('a/b\\c.epub')).toBe('c.epub')
  })
})
