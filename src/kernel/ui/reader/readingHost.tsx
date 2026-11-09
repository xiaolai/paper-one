import { useLayoutEffect, useState } from 'react'
import { notifyAll } from '../../core/notify'
import { TitleBar, type TitleBarProps } from '../shell/TitleBar'
import type { SpeakPrefs } from './speaker'
import { useSpeech, type ReadingContext, type ReadingEngine, type Speech } from './useSpeech'

/**
 * Read-aloud, run from a child of `App` rather than from `App` itself.
 *
 * It renders nothing. What it has to say goes through a small store, because the
 * things that want it are `App`'s other children (the transport in the title
 * bar). The audiobook export, which used to run here too, is the narration
 * capability's own window host now.
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
  readonly store: HostStore
}

export function ReadingHost({ context, prefs, engine, store }: ReadingHostProps): null {
  const speech = useSpeech(context, prefs, engine)
  useLayoutEffect(() => store.publish({ speech }), [store, speech])
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
