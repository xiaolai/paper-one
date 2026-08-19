import { useEffect, useRef } from 'react'
import type { MarkStorage } from './marks'
import {
  SETTINGS_STORAGE_KEY,
  parseSettings,
  sameSettings,
  settingsOf,
  type StoredSettings,
} from './settings'
import { initialState, type AppState } from './state'

/**
 * Keeping the reader's settings on disk.
 *
 * The seam `settings.ts` deliberately does not have: everything about WHAT is
 * stored and how a stored value is read back is pure and tested over there;
 * this is only the part that talks to storage and to React.
 *
 * WRITTEN ON CHANGE, not on an interval and not on unload. The store behind
 * `MarkStorage` already coalesces bursts — see `FileStoreOptions.schedule` —
 * so a reader dragging the brightness through five steps costs one write, and
 * a reader who force-quits after changing the theme still has the theme. An
 * unload handler is the version of this that loses the last change on a crash,
 * which is the one moment it matters.
 */

/** Read what was stored, for the reducer's initial state. Null with no store. */
export function loadSettings(storage: MarkStorage | null): StoredSettings | null {
  if (!storage) return null
  try {
    return parseSettings(storage.getItem(SETTINGS_STORAGE_KEY), settingsOf(initialState))
  } catch {
    /* `getItem` itself can throw — localStorage does when storage is disabled
     * outright, which is `localStore`'s whole reason for existing. A reader
     * with storage off gets the defaults and a working app, not a blank screen. */
    return null
  }
}

/**
 * Write the settings whenever they change.
 *
 * COMPARED BEFORE WRITING, against what was last written rather than against
 * the previous render. `AppState` changes on every page turn, every chrome
 * fade and every keystroke in the library's search field, and `settingsOf`
 * builds a fresh object each time — so an identity check would write on all of
 * them. `sameSettings` asks the only question that matters: did anything the
 * reader chose actually move?
 *
 * The baseline starts as what was READ, so a launch that changes nothing writes
 * nothing. Starting it empty would rewrite the file on every cold start, which
 * is a pointless write on the one path that is already the slowest.
 */
export function useSettings(storage: MarkStorage | null, state: AppState): void {
  const written = useRef<StoredSettings | null>(null)
  if (written.current === null) written.current = loadSettings(storage) ?? settingsOf(initialState)

  useEffect(() => {
    if (!storage) return
    const next = settingsOf(state)
    if (written.current && sameSettings(written.current, next)) return
    written.current = next
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
    } catch (cause) {
      /* Reported, not thrown. A reader whose disk is full should keep reading;
       * losing the type size they just chose is the smaller failure, and the
       * store surfaces its own health separately — see `FileStore.healthy`. */
      console.error('Paper: could not save your settings', cause)
    }
  }, [storage, state])
}
