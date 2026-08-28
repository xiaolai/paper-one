import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkStorage } from '../../core/marks'
import {
  NO_TAG_PREFS,
  TAG_PREFS_STORAGE_KEY,
  parseTagPrefs,
  removeView as removeViewIn,
  renameView as renameViewIn,
  saveView as saveViewIn,
  setTagColour as setColourIn,
  toggleHiddenSubject as toggleHiddenIn,
  togglePinned as togglePinnedIn,
  type TagColour,
  type TagPrefs,
} from '../../core/tagPrefs'

/**
 * The reader's decisions about their tags, bound to React and to storage.
 *
 * All the rules live in `tagPrefs`; this holds the state, reads it once before
 * the first render, and writes after every change. The same shape as `useMarks`
 * and for the same reasons — a pure module that can be tested without a store,
 * and a thin hook that cannot.
 *
 * WRITTEN ON CHANGE, like the settings: the store behind `MarkStorage` already
 * coalesces bursts, and these change rarely and deliberately. Every operation
 * returns the SAME object when nothing moved, so a no-op pin writes nothing at
 * all — the comparison is `tagPrefs`' job, not this one's.
 */

export interface TagPrefsStore {
  readonly prefs: TagPrefs
  /**
   * Whether the next launch will see any of this.
   *
   * False with no storage, and false from a write the storage refused until
   * one it takes. The write effect used to advance its "last written" marker
   * BEFORE `setItem` and report a throw to the console only — so a pin, a
   * colour, a hidden subject or a saved view showed as kept until the next
   * launch, when it was gone, and nothing on screen had said otherwise.
   */
  readonly persistent: boolean
  togglePinned: (tag: string) => void
  setColour: (tag: string, colour: TagColour | null) => void
  toggleHidden: (subject: string) => void
  /** Keep the current query under a name. The id is minted here. */
  saveView: (name: string, query: string) => void
  renameView: (id: string, name: string) => void
  removeView: (id: string) => void
}

/**
 * A stable id for a saved view.
 *
 * `randomUUID` needs a secure context, which a `file://` build is not — the
 * same trap `newMarkId` documents, and the same fallback.
 */
function newViewId(): string {
  const uuid = globalThis.crypto?.randomUUID
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID()
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function useTagPrefs(storage: MarkStorage | null): TagPrefsStore {
  const [prefs, setPrefs] = useState<TagPrefs>(() => {
    if (!storage) return NO_TAG_PREFS
    try {
      return parseTagPrefs(storage.getItem(TAG_PREFS_STORAGE_KEY))
    } catch {
      // `getItem` throws outright when storage is disabled — see `localStore`.
      return NO_TAG_PREFS
    }
  })

  /* What was last written, so an unchanged value writes nothing. Seeded with
   * what was READ: a launch that changes nothing must not rewrite the file. */
  const written = useRef<TagPrefs | null>(null)
  if (written.current === null) written.current = prefs
  const [persistent, setPersistent] = useState(storage !== null)

  useEffect(() => {
    if (!storage || written.current === prefs) return
    try {
      storage.setItem(TAG_PREFS_STORAGE_KEY, JSON.stringify(prefs))
      /* ADVANCED AFTER THE WRITE, not before it. Advanced first, a refused
       * write was recorded as done, and the value stayed on screen as though
       * kept. Left behind, the next change writes the whole current value —
       * which carries this one — so a store that recovers (the file store
       * queues the retry before it throws for the previous failure) takes
       * everything the reader decided in between. */
      written.current = prefs
      setPersistent(true)
    } catch (cause) {
      /* Reported AND published. These are conveniences — the tags themselves
       * are on the books — so a reader whose disk is full keeps their library
       * and loses a pin; but they are told the pin is what they are losing,
       * in the panel where they made it. */
      console.error('Paper: could not save your tag preferences', cause)
      setPersistent(false)
    }
  }, [storage, prefs])

  const togglePinned = useCallback((tag: string) => {
    setPrefs((current) => togglePinnedIn(current, tag))
  }, [])

  const setColour = useCallback((tag: string, colour: TagColour | null) => {
    setPrefs((current) => setColourIn(current, tag, colour))
  }, [])

  const toggleHidden = useCallback((subject: string) => {
    setPrefs((current) => toggleHiddenIn(current, subject))
  }, [])

  const saveView = useCallback((name: string, query: string) => {
    setPrefs((current) => saveViewIn(current, newViewId(), name, query))
  }, [])

  const renameView = useCallback((id: string, name: string) => {
    setPrefs((current) => renameViewIn(current, id, name))
  }, [])

  const removeView = useCallback((id: string) => {
    setPrefs((current) => removeViewIn(current, id))
  }, [])

  return { prefs, persistent, togglePinned, setColour, toggleHidden, saveView, renameView, removeView }
}
