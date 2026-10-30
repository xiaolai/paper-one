import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The library-held event's name is written down TWICE, and it has to be.
 *
 * ⚠️ **THE DUPLICATION IS THE PRICE OF THE PLUGIN STAYING REMOVABLE.** Tauri
 * initialises plugins before the application's own `setup`, where the desktop
 * library lock is taken — so a plugin's launch work runs in a process the lock
 * has not judged yet, and a second Paper was deleting `.part` staging files out
 * of the holder's library. The host has to say when the library is held.
 *
 * Saying it by CALLING into the peer plugin makes that plugin unremovable:
 * `capability:remove` refuses a `lib.rs` that still names a crate after its
 * `.plugin()` line is cut, and `scripts/lib/removal.test.mjs` enforces that.
 * So the host emits a string and the plugin listens for one, and neither
 * imports from the other.
 *
 * ⚠️ **WHICH MEANS A TYPO IN EITHER IS A PLUGIN THAT WAITS FOR EVER**, with no
 * error anywhere: the sweep never runs, the share endpoint never resumes, and
 * everything else about the app looks perfectly healthy. That is the failure
 * this file exists to make loud.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/** The single-quoted or double-quoted literal assigned to a Rust `const`. */
function literalOf(source, name) {
  const match = new RegExp(`const ${name}: &str = "([^"]+)"`, 'u').exec(source)
  return match?.[1] ?? null
}

describe('the library-held event', () => {
  it('is spelled the same by the host that emits it and the plugin that waits', () => {
    const host = literalOf(read('src-tauri/src/lib.rs'), 'LIBRARY_HELD')
    const plugin = literalOf(read('src-tauri/crates/tauri-plugin-peer/src/lib.rs'), 'LIBRARY_HELD_EVENT')

    expect(host, 'the host no longer declares LIBRARY_HELD').not.toBeNull()
    expect(plugin, 'the plugin no longer declares LIBRARY_HELD_EVENT').not.toBeNull()
    expect(plugin, 'the two sides disagree, so the plugin waits for ever and nothing says so').toBe(host)
  })

  it('is still emitted by the host and listened for by the plugin', () => {
    /* The names alone agreeing proves nothing if one side stopped using it. */
    expect(read('src-tauri/src/lib.rs'), 'the host declares the event and never emits it').toMatch(
      /emit\(app, LIBRARY_HELD/u,
    )
    expect(
      read('src-tauri/crates/tauri-plugin-peer/src/lib.rs'),
      'the plugin declares the event and never listens for it',
    ).toMatch(/listen\(LIBRARY_HELD_EVENT/u)
  })
})
