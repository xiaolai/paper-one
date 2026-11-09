import { useLayoutEffect, useState } from 'react'
import { notifyAll, type VoicePack } from '../../../kernel'
import type { VoiceFacts } from '../lib/voiceChoice'
import type { Speech } from './useSpeech'

/**
 * The reading, as the things around it see it.
 *
 * `ReadingHost` runs the reading and publishes it here; the Listen control in
 * the title bar and the Voice section in Settings read it. A small store rather
 * than props, because the three are separate contributions the kernel draws in
 * separate places, and none of them is the others' parent.
 *
 * ⚠️ **THE HOST IS THE FIRST WINDOW HOST NARRATION CONTRIBUTES**, and the kernel
 * draws every window host before the shell, so its layout effect, which
 * publishes, runs before those of everything that reads what it publishes. This
 * was `App`'s `ReadingHost` until step 5.5, and the order is the same one it
 * relied on: see `useReading`.
 */
export interface Reading {
  readonly speech: Speech
  /** Why this book cannot be read aloud, or `null` when it can — see `ReadingHost`. */
  readonly listenRefusal: string | null
  /** Whether there is a book ready to be read. */
  readonly hasBook: boolean
  /** The language of the section on screen, as the utterance will be given it; `null` with no book. */
  readonly lang: string | null
  /** What this machine's own engine can say. */
  readonly voices: readonly VoiceFacts[]
  /** Every downloadable voice this device is offered, with whether it is installed. */
  readonly packs: readonly VoicePack[]
}

export interface ReadingStore {
  /** Null until the host has committed once, and again once it has gone: see `useReading`. */
  read(): Reading | null
  publish(reading: Reading): void
  /** The host is gone: nothing it said holds any more. */
  withdraw(): void
  subscribe(listener: () => void): () => void
}

export function createReadingStore(): ReadingStore {
  let reading: Reading | null = null
  const listeners = new Set<() => void>()
  const tell = (next: Reading | null) => {
    reading = next
    notifyAll(listeners, 'reading host')
  }
  return {
    read: () => reading,
    publish: (next) => tell(next),
    withdraw: () => tell(null),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** The whole reading, as published — one function, so `useReading` is not handed a new one per render. */
export const whole = (reading: Reading | null): Reading | null => reading

/**
 * One value from the store, in time for this paint.
 *
 * ⚠️ **SUBSCRIBED IN A LAYOUT EFFECT, WHICH IS WHY THIS IS NOT
 * `useSyncExternalStore`.** That subscribes, and looks again, in a PASSIVE effect,
 * which on the app's first commit comes after the first paint. The Listen
 * control is rendered in the same pass as the host, before the host has
 * published, so a frame with no Listen control in it would be new. A state set
 * in a layout effect is flushed before the browser paints, and the host's own
 * layout effect has already run: see `Reading`.
 */
export function useReading<T>(store: ReadingStore, select: (reading: Reading | null) => T): T {
  const [value, setValue] = useState(() => select(store.read()))
  useLayoutEffect(() => {
    const look = () => setValue(() => select(store.read()))
    look()
    return store.subscribe(look)
  }, [store, select])
  return value
}
