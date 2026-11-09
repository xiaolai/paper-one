import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { KernelServices, ReaderContext, SettingsStore } from '../../../kernel'
import { engineVoiceFor, missingPackNotice } from '../lib/engineVoice'
import { prefsOf } from '../lib/settings'
import { NO_GOOD_VOICE, voiceFor } from '../lib/voiceChoice'
import type { ReadingStore } from './reading'
import { useSpeech } from './useSpeech'
import { useVoicePacks } from './useVoicePacks'
import { useVoices } from './useVoices'

export interface ReadingHostProps {
  readonly context: ReaderContext
  readonly services: KernelServices
  /** Narration's own settings: the voice, the speed, the volume, the pauses, the notes. */
  readonly settings: SettingsStore
  readonly store: ReadingStore
}

/**
 * Read-aloud, run for as long as the window is.
 *
 * It renders nothing. What it has to say goes through `ReadingStore`, because
 * the things that want it — the Listen control in the title bar, and the Voice
 * section in Settings — are contributions the kernel draws elsewhere.
 *
 * A WINDOW HOST RATHER THAN A PART OF THE READER, because a reading outlives the
 * screen it started on: the reader may open the shelf or a contributed screen,
 * and the voice goes on. Until step 5.5 this was `App`'s own child; the kernel
 * now draws it among the window hosts, ahead of the shell, which is the order
 * it needs (see `Reading`).
 *
 * ⚠️ **THE ONLY THING THE TESTS PROVE ABOUT THIS IS ORDER.** Whether the sound
 * still follows the page has a manual acceptance of its own (decision D4), made
 * in the running app with both a platform voice and a downloaded one.
 */
export function ReadingHost({ context, services, settings, store }: ReadingHostProps): null {
  /* The downloadable voices: what this device has, and the engine the reading
     uses when a pack can read the book on screen. Empty and null in a build
     with no voices capability, where the reading is the platform's alone. */
  const { packs, engine } = useVoicePacks(services)
  const voices = useVoices()
  /* ⚠️ **THE SNAPSHOT IS THE SIGNAL, AND THE SETTINGS ARE READ THROUGH THEIR OWN
     PARSERS.** A value read straight from the snapshot would be the raw stored
     one, unclamped and unvalidated; `prefsOf` reads each through its setting.

     The scoped snapshot is re-filtered whenever ANY setting changes, so a theme
     change makes a new set of preferences holding the same values. That costs
     nothing: `useSpeech` reads them through a ref, the one an effect depends
     on is the volume, a number, and the refusal below is a string. */
  const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const prefs = useMemo(() => prefsOf(settings), [settings, snapshot])
  const speech = useSpeech(context, prefs, engine)
  /* The language of the book on screen, read where the utterance will be told
     it — the surface's `lang` is `documentLang` of the section shown — so the
     picker offers voices for the language the reading will ask for rather than
     for the interface's. */
  const { surface } = context
  const book = useSyncExternalStore(surface.subscribeBook, surface.book)
  const lang = book?.lang ?? null
  const hasBook = book !== null
  /**
   * Why this book cannot be read aloud, or `null` when it can.
   *
   * ⚠️ **THE SAME ANSWER THE SPEAKER WILL REACH, ASKED BEFORE THE PRESS.** The
   * floor refuses every voice a Mac's WebView offers (see `voiceChoice.ts`), so
   * the Listen control says so up front rather than starting a reading that
   * stops at its first sentence. Same functions, same list, same language and
   * same stored choice as the speaker — so the control cannot promise a reading
   * the speaker then refuses, or refuse one it would have read.
   *
   * ⚠️ **THE DOWNLOADED VOICES ARE ASKED FIRST, AND THE FLOOR IS UNCHANGED
   * BEHIND THEM.** `voiceFor` refuses every platform voice below Enhanced
   * wherever the tier is legible, which on a Mac is all of them; a pack is not
   * subject to that and does not need to be, since its voices are in the
   * catalogue because the owner listened to them. So a book a pack can read is
   * never refused, whatever the platform offers.
   *
   * And where nothing can read it, the sentence says what would: a pack that
   * exists for the language names itself and its size. That is advice a reader
   * can act on, which *"install a system voice"* would not have been — macOS
   * withholds the good ones from this app however they are installed.
   */
  const listenRefusal = useMemo((): string | null => {
    if (engineVoiceFor(packs, lang, prefs.voices)) return null
    if (voiceFor(voices, lang, prefs.voices).kind !== 'none') return null
    return missingPackNotice(packs, lang) ?? NO_GOOD_VOICE
  }, [packs, voices, lang, prefs.voices])
  const reading = useMemo(
    () => ({ speech, listenRefusal, hasBook, lang, voices, packs }),
    [speech, listenRefusal, hasBook, lang, voices, packs],
  )
  useLayoutEffect(() => store.publish(reading), [store, reading])
  /* WITHDRAWN ONLY WHEN THE HOST GOES, and by an effect of its own: the one
     above re-runs on every new reading, and withdrawing in its cleanup would
     tell every reader "no reading" between two publishes of the same commit. */
  useLayoutEffect(() => () => store.withdraw(), [store])
  return null
}
