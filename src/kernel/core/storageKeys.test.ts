import { describe, expect, it } from 'vitest'
import { CARDS_STORAGE_KEY } from './cards'
import { MIGRATED_KEYS, STORE_FILE } from './fileStore'
import { MARKS_STORAGE_KEY } from './marks'
import { SETTINGS_STORAGE_KEY } from './settings'
import { TAG_PREFS_STORAGE_KEY } from './tagPrefs'

/**
 * Every key in the one store is its own.
 *
 * THIS TEST EXISTS BECAUSE THE COLLISION HAPPENED. `paper.library.v1` was the
 * obvious name for the tag preferences and it was already the pre-folders book
 * rows — a name `MIGRATED_KEYS` still carries over from localStorage on first
 * run. Nothing in the type system, the build or the suite would have said so:
 * the two stores never import each other, both write a JSON string, and the
 * loser parses to its empty value and looks like a reader who had set nothing.
 *
 * A live probe of the running app is what found it. This is the assertion left
 * behind, which is the part that stops it coming back while still looking green.
 */
describe('the keys in the one store', () => {
  const KEYS = {
    marks: MARKS_STORAGE_KEY,
    cards: CARDS_STORAGE_KEY,
    settings: SETTINGS_STORAGE_KEY,
    tagPrefs: TAG_PREFS_STORAGE_KEY,
  }

  it('are all different from each other', () => {
    const names = Object.values(KEYS)
    expect(new Set(names).size).toBe(names.length)
  })

  it('does not reuse a key the migration still carries', () => {
    /* The migrated names are LEGACY CONTENT, not free namespace: on a machine
       upgrading from the localStorage era they arrive full. A live store whose
       key is one of them inherits somebody else's data on first run. */
    for (const [what, key] of Object.entries(KEYS)) {
      if (what === 'marks' || what === 'cards') continue // migrated by design
      expect(MIGRATED_KEYS as readonly string[], what).not.toContain(key)
    }
  })

  it('keeps every key out of the store file’s own name', () => {
    expect(Object.values(KEYS)).not.toContain(STORE_FILE)
  })
})
