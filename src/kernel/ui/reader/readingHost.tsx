import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { notifyAll } from '../../core/notify'
import { TitleBar, type TitleBarProps } from '../shell/TitleBar'
import { useAudiobook, type AudiobookControl, type AudiobookDeps } from '../hooks/useAudiobook'
import type { SpeakPrefs } from './speaker'
import { useSpeech, type ReadingContext, type ReadingEngine, type Speech } from './useSpeech'

/**
 * Read-aloud, run from a child of `App` rather than from `App` itself.
 *
 * It renders nothing. What it has to say goes through a small store, because the
 * things that want it are `App`'s own (the palette's export row) and its other
 * children (the transport in the title bar).
 *
 * ⚠️ **THIS MUST BE THE FIRST THING `App` RENDERS**, so that its layout effect,
 * which publishes, runs before those of everything that reads what it publishes.
 *
 * ⚠️ **THE ONLY THING THIS PROVES IN A TEST IS ORDER.** Whether the sound still
 * follows the page has a manual acceptance of its own (decision D4): this file
 * exists so that the reading can leave the kernel, and it may not until that run
 * has been made.
 */

/** What the host has to say. */
export interface Hosted {
  readonly speech: Speech
  readonly audiobook: AudiobookControl | null
}

export interface HostStore {
  /** Null until the host has committed once: see `useHosted`. */
  read(): Hosted | null
  publish(hosted: Hosted): void
  subscribe(listener: () => void): () => void
}

export function createHostStore(): HostStore {
  let hosted: Hosted | null = null
  const listeners = new Set<() => void>()
  return {
    read: () => hosted,
    publish(next) {
      hosted = next
      notifyAll(listeners, 'reading host')
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * One value from the store, in time for this paint.
 *
 * ⚠️ **SUBSCRIBED IN A LAYOUT EFFECT, WHICH IS WHY THIS IS NOT
 * `useSyncExternalStore`.** That subscribes, and looks again, in a PASSIVE effect,
 * which on the app's first commit comes after the first paint. The title bar was
 * rendered by `App` in one pass before the host existed, so a frame with no title
 * bar in it would be new. A state set in a layout effect is flushed before the
 * browser paints, and the host's own layout effect has already run: see its header.
 */
export function useHosted<T>(store: HostStore, select: (hosted: Hosted | null) => T): T {
  const [value, setValue] = useState(() => select(store.read()))
  useLayoutEffect(() => {
    const look = () => setValue(() => select(store.read()))
    look()
    return store.subscribe(look)
  }, [store, select])
  return value
}

export interface ReadingHostProps {
  readonly context: ReadingContext
  readonly prefs: SpeakPrefs
  readonly engine: ReadingEngine | null
  /** The export's needs, but for the book, which comes from the surface. */
  readonly audiobook: Omit<AudiobookDeps, 'source'>
  readonly store: HostStore
}

export function ReadingHost({ context, prefs, engine, audiobook: deps, store }: ReadingHostProps): null {
  const { surface } = context
  const speech = useSpeech(context, prefs, engine)
  const book = useSyncExternalStore(surface.subscribeBook, surface.book)
  /** THE SAME VALUE THE VOICE READS, so the file holds what the reading would
   *  have said. */
  const notes = prefs.notesAloud ?? false
  const source = useMemo(() => book && { ...book, skip: { notes } }, [book, notes])
  const audiobook = useAudiobook({ ...deps, source })
  useLayoutEffect(() => store.publish({ speech, audiobook }), [store, speech, audiobook])
  return null
}

const speechOf = (hosted: Hosted | null) => hosted?.speech ?? null

/** The title bar, with the transport the host publishes. */
export function HostedTitleBar({
  store,
  ...props
}: Omit<TitleBarProps, 'speech'> & { readonly store: HostStore }) {
  const speech = useHosted(store, speechOf)
  return speech && <TitleBar {...props} speech={speech} />
}
