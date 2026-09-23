/**
 * The downloaded voices, as the reading and the Listen control need them.
 *
 * ⚠️ **THE CATALOGUE IS POLLED RATHER THAN READ ONCE**, because it changes
 * while the app runs: a reader downloads a pack in Settings and goes back to
 * their book, and a list read at mount would leave that book still refused. The
 * poll is cheap — the catalogue is embedded in the binary and the only work is
 * asking whether each pack's files are on disk.
 *
 * ⚠️ **AND THE AUDIO CONTEXT IS MADE ON FIRST USE, NOT ON MOUNT.** An
 * `AudioContext` takes an output device and, in some browsers, counts against a
 * per-page limit; a reader who never presses Listen should not have one. It is
 * also created SUSPENDED until a gesture in several engines, which is why the
 * first `speak` resumes it rather than the hook.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KernelServices } from '../../core/services'
import type { VoicePack } from '../../core/ports'
import type { AudioHost } from '../reader/enginePlayer'
import type { ReadingEngine } from '../reader/useSpeech'

/** How often the catalogue is re-read. */
export const PACKS_POLL_MS = 4000

/** What the app needs to know about the downloaded voices. */
export interface VoicesState {
  /** Every pack this device is offered, with whether it is installed. */
  readonly packs: readonly VoicePack[]
  /** The engine for `useSpeech`, or null where this build has none. */
  readonly engine: ReadingEngine | null
}

/** Nothing at all — a build with no voices capability. */
const NONE: VoicesState = { packs: [], engine: null }

export function useVoicePacks(services: KernelServices): VoicesState {
  const [packs, setPacks] = useState<readonly VoicePack[]>([])
  /* Read at CALL time, not captured: the capability binds its port during
   * `start`, which can land after this hook's first render. */
  const port = useMemo(() => () => services.speechEngines(), [services])
  const context = useRef<AudioHost | null>(null)
  const packsRef = useRef<readonly VoicePack[]>(packs)
  packsRef.current = packs

  useEffect(() => {
    let alive = true
    const read = async () => {
      const bound = port()
      if (!bound) return
      try {
        const rows = await bound.catalogue()
        if (alive) setPacks(rows)
      } catch (cause: unknown) {
        /* A catalogue that will not read leaves the list as it was rather than
         * emptying it: an empty list means "no pack can read this book", which
         * would take a working voice away on one failed poll.
         *
         * ⚠️ **AND IT IS SAID, WHERE IT USED TO BE SWALLOWED.** A silent
         * catch made this road indistinguishable from the one above it — a
         * build with no engine at all — so the guard in front of it was a
         * branch no test could reach, which is how an unkillable mutant is
         * spelled. They are different events and only one of them is a fault:
         * a poll failing every four seconds is worth a line, and this is the
         * only place that knows it happened. */
        console.error('Paper: the voices catalogue would not read', cause)
      }
    }
    void read()
    const timer = setInterval(() => void read(), PACKS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [port])

  useEffect(
    () => () => {
      /* The model is the reader's memory — 2.5 GB for the Chinese pack — and
       * an app being torn down is the last moment anything asks for it back. */
      void port()?.release().catch(() => {})
      /* ⚠️ **AND THE AUDIO CONTEXT, WHICH WENT UNRELEASED.** Only the model was
       * given back; the `AudioContext` made on the first Listen stayed, holding
       * an output device and counting against the per-page limit some browsers
       * apply. The ref is cleared too, so a hook that mounts again makes a
       * fresh one rather than handing out a closed context that plays nothing. */
      const made = context.current
      context.current = null
      void made?.close().catch(() => {})
    },
    [port],
  )

  return useMemo(() => {
    const bound = port()
    if (!bound) return NONE
    return {
      packs,
      engine: {
        packs: () => packsRef.current,
        render: (request) => bound.render(request),
        host: () => {
          /* ⚠️ **A CACHED CONTEXT IS ASKED AGAIN WHETHER IT IS RUNNING**, and it
           * was not. A context is suspended until a gesture in several engines,
           * and this is NOT on the gesture: it is reached from `#play`, after
           * an async render — the comment here used to claim pressing Listen is
           * the gesture, which was wrong by one `await`. So the first `resume`
           * can be refused, and every later playback was then silent for ever
           * with nothing saying why. */
          const held = context.current
          if (held) {
            if (held.state !== 'running') void held.resume().catch(() => {})
            return held
          }
          const Ctor =
            typeof AudioContext === 'function'
              ? AudioContext
              : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (!Ctor) return null
          const made = new Ctor() as unknown as AudioHost
          context.current = made
          void made.resume().catch(() => {})
          return made
        },
      },
    }
  }, [port, packs])
}
