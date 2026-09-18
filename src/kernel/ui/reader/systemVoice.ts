import { notifyAll } from '../../core/notify'
import type { Speaking, Voice } from '../../core/voice'
import { Speaker, speechAvailable } from './speech'

/**
 * The `Voice` port over the machine's OWN speech engine — `window.speechSynthesis`.
 *
 * # Why this exists, and what it replaced
 *
 * `core/voice.ts`'s default was `NO_VOICE`: nothing can speak, so the lookup
 * popup drew no pronunciation control at all unless a capability had bound a
 * neural voice — and on this machine the neural voice (Kokoro, through the
 * local runtime) answered every press with *"Paper couldn't say that aloud."*
 *
 * **This is THE voice now, not a fallback.** Pronunciation is the system
 * speaker's, and no capability binds another: the neural voice is deleted
 * (`core/voice.ts` gives the four reasons). Being the kernel's default means a
 * browser client, a phone and a build with no `inference` composed all speak —
 * with nothing installed and no capability bound.
 *
 * MEASURED WORKING, 2026-09-18, in the running app: a direct utterance of a
 * looked-up word started in 2 ms and ended at 694 ms — a real duration, which
 * an engine with no voice behind it cannot fake — and this Mac offers 73 voices
 * across 39 languages, Mandarin among them.
 *
 * ⚠️ **THIS HEADER USED TO BLAME THE PLATFORM FOR THE NEURAL VOICE'S FAILURE,
 * AND IT WAS WRONG.** The failure was Paper's own: it asked the runtime's
 * sound-effects route (`/api/v1/audio/generations`) where speech is
 * `/v1/audio/speech` with an `input` field, the backend that serves Kokoro was
 * blocked from being fetched (`no_fetch_executables`), and the model was
 * registered under the wrong name. `core/voice.ts` carries the same correction
 * for whoever brings a neural voice back.
 *
 * # Why `Speaker` rather than a second wrapper over the engine
 *
 * `speech.ts` already owns every trap this API has, and the one that matters
 * here is the late `end`: `cancel()` does not silence the utterance it cancels,
 * it merely makes its ending arrive late — so without the generation counter, a
 * reader who presses Stop and then Play sees the control snap back to idle a
 * moment after pressing it. Writing a smaller speaker for one word would be a
 * second copy of that policy, which is the mistake `direction.ts`'s own header
 * records ("speech carried a copy rather than import the session's whole
 * graph"). What is not reused is what a single word has no use for: the
 * boundary grace, the follow-along, pause and resume.
 *
 * # ONE ENGINE, SO ONE VOICE OVER IT
 *
 * `systemVoice()` is a shared instance, not a factory — deliberately, and the
 * reason is the platform's rather than a preference for singletons:
 * `window.speechSynthesis` is one engine serving one utterance, so two `Voice`
 * objects over it would each believe they owned what the other was saying, and
 * each one's `say` would silently cancel the other's. The reading keeps its own
 * `Speaker` (its callbacks are the follow-along's), and the two coordinate
 * through `engineHeldBy` — see `DoneReason.taken`.
 *
 * # What a reader on a machine with no usable voice actually gets
 *
 * ⚠️ **AN ENGINE'S PRESENCE IS NOT A VOICE, AND THIS IS WHERE THAT IS DECIDED.**
 * `speechAvailable` answers `'speechSynthesis' in window`, which WebKitGTK
 * answers with no speech-dispatcher installed — the default state on Linux — and
 * such an engine accepts an utterance, raises nothing and makes no sound. So
 * `canSay` reads the engine's own voice list rather than its presence, with the
 * absent-versus-unreadable rule this repository applies to every store: an
 * EMPTY list is unknown (it loads asynchronously, and `voiceschanged` settles
 * it) and a POPULATED one is authoritative.
 *
 * Two cases, stated plainly because they are the ones worth being able to
 * answer:
 *
 * - **Linux with no speech-dispatcher.** The list is empty and stays empty, so
 *   the first press is allowed — one silent press — and nothing corrects it,
 *   because an engine with no backend never fires `voiceschanged`. That is the
 *   deliberate cost of treating empty as unknown: the alternative drops the
 *   control for every reader whose list has merely not arrived yet. With a
 *   backend installed the list populates and everything below applies.
 * - **A Chinese word on an English-only machine.** The list is populated and
 *   has no `zh` voice, so the control is ABSENT — §07's rule for a control that
 *   cannot act — rather than an English voice mangling the word into something
 *   the reader would believe. Matching is on the primary subtag, so a `zh-CN`
 *   voice does serve a `zh-Hant` book; see `primarySubtag`.
 *
 * `createSystemVoice` takes an engine so the suite can drive a `FakeSynth`;
 * nothing in the app passes one.
 */
/**
 * A language tag's PRIMARY SUBTAG, lowercased — `zh` out of `zh-Hant`, `en` out
 * of `en_GB`.
 *
 * ⚠️ **THE SUBTAG AND NOT THE WHOLE TAG, WHICH IS THE DIFFERENCE BETWEEN A
 * VOICE AND NO VOICE.** A machine with a `zh-CN` voice should say a word from a
 * `zh-Hant` book rather than nothing at all, and `en-GB` should serve an `en-US`
 * book: the region is an accent, and an accent is not a wrong answer. What the
 * subtag does NOT do is cross languages, which is the failure this whole check
 * exists to prevent.
 *
 * Empty for anything with no subtag to take — `''`, `'-'`, whitespace — which
 * `canSay` reads as "no language was declared" rather than as a language it
 * has no voice for. `_` is accepted beside `-` because a POSIX locale
 * (`zh_CN.UTF-8`) reaches this from a document written by a tool rather than by
 * a person.
 */
function primarySubtag(tag: string): string {
  return (tag.trim().toLowerCase().split(/[-_.]/u)[0] ?? '').trim()
}

export function createSystemVoice(synth?: SpeechSynthesis): Voice {
  const listeners = new Set<() => void>()
  let state: Speaking = 'idle'
  /**
   * Built on the FIRST press, never at construction.
   *
   * `Speaker`'s engine defaults to `window.speechSynthesis`, which is a
   * `ReferenceError` under the `node` environment every suite in this
   * repository runs by default — and this voice is the kernel's default, so it
   * is constructed by `createKernelServices` in all of them. Lazy, the object
   * is free to exist on a machine that cannot speak, and `available` is the one
   * thing that answers for it.
   */
  let speaker: Speaker | null = null

  const settle = (next: Speaking): void => {
    state = next
    notifyAll(listeners, 'voice')
  }

  /**
   * The engine, or null where this build has none.
   *
   * ⚠️ **PRESENCE ONLY, WHICH IS NOT "THE READER WILL HEAR SOMETHING"** — see
   * `speechAvailable`. Whether anything can be SAID is `canSay`'s, and it asks
   * this engine's own voice list.
   */
  const engine = (): SpeechSynthesis | null => {
    if (synth !== undefined) return synth
    return speechAvailable() ? window.speechSynthesis : null
  }

  const speaking = (): Speaker | null => {
    if (speaker !== null) return speaker
    const found = engine()
    if (found === null) return null
    speaker = new Speaker(
      {
        /* A WORD HAS NO FOLLOW-ALONG. The reading highlights the word being
           spoken inside the book's own document; this is one term in a popup,
           already on screen and already the thing the reader is looking at. */
        onWord: () => {},
        onNoBoundaries: () => {},
        onDone: (reason) => settle(reason === 'error' ? 'failed' : 'idle'),
      },
      found,
    )
    return speaker
  }

  /**
   * ⚠️ **THE ENGINE'S OWN `voiceschanged`, ARMED BY THE FIRST SUBSCRIBER.**
   * `canSay` answers optimistically against an empty voice list, because empty
   * means NOT YET LOADED — so the answer has to be revisited when the list
   * arrives, or a control allowed on an unknown list stays allowed for the
   * session. Armed from `subscribe` rather than from a getter: attaching a
   * listener is a side effect, and `canSay` is read during a render.
   */
  let watching: (() => void) | null = null
  const watch = (): void => {
    if (watching !== null) return
    const found = engine()
    if (found === null) return
    const told = (): void => notifyAll(listeners, 'voice')
    found.addEventListener('voiceschanged', told)
    watching = () => found.removeEventListener('voiceschanged', told)
  }

  return {
    /**
     * ⚠️ **EMPTY IS UNKNOWN AND A POPULATED LIST IS AUTHORITATIVE** — the rule
     * is `core/voice.ts`'s `canSay`, and this is the reading of it:
     *
     * | the engine says | answer | why |
     * |---|---|---|
     * | there is no engine | **no** | nothing to ask |
     * | `getVoices()` is `[]` | **yes** | not yet loaded; `voiceschanged` will settle it |
     * | a list, and `lang` is null | **yes** | no declared language, so the reader's own default voice serves |
     * | a list with a matching primary subtag | **yes** | `zh-CN` serves a `zh-Hant` book |
     * | a list without one | **no** | a voice for the wrong language is worse than no voice |
     */
    canSay: (lang) => {
      const found = engine()
      if (found === null) return false
      const voices = found.getVoices()
      /* NOT YET LOADED. Allowed, and corrected by `voiceschanged` — a false
         negative here removes the feature, a false positive costs one press. */
      if (voices.length === 0) return true
      const wanted = lang === null ? '' : primarySubtag(lang)
      /* NOTHING DECLARED, so any voice will do: `say` leaves the utterance's own
         `lang` unset and the platform uses the reader's default. */
      if (wanted === '') return true
      return voices.some((voice) => primarySubtag(voice.lang) === wanted)
    },
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      watch()
      return () => {
        listeners.delete(listener)
        /* RELEASED WITH THE LAST SUBSCRIBER. This voice is the app's for its
           whole life, so a listener left on the engine would be a listener
           nobody reads — and the engine outlives every popup that subscribed. */
        if (listeners.size === 0) {
          watching?.()
          watching = null
        }
      }
    },
    say: (text, lang) => {
      const engine = speaking()
      /* NOTHING TO SAY IT WITH IS NOT A FAILURE — the control is not drawn when
         `canSay` is false, so this is the window before the render that takes
         it away. `NO_VOICE.say` is silent for the same reason.
         ⚠️ **AND IT DOES NOT RE-ASK `canSay`.** A press is served by whatever
         engine is there: the language check decides whether to OFFER the
         control, and refusing the press as well would mean a control that is
         drawn and does nothing — the one outcome §07 forbids outright. */
      if (engine === null) return
      /* SET BEFORE THE ENGINE IS ASKED, because a text with nothing in it
         reports `onDone('empty')` SYNCHRONOUSLY from inside `speak` — see
         `Speaker.speak`'s own note. Written first, that done overwrites this;
         written after, this would overwrite the done and leave the control
         saying Stop over silence. */
      state = 'speaking'
      /* Told only when the engine took it: the empty case has already notified
         through `settle`, and notifying again would say the state changed to
         the value it was just given. */
      if (engine.speak(text, lang ?? null)) notifyAll(listeners, 'voice')
    },
    stop: () => {
      speaker?.stop()
      /* UNCONDITIONALLY `idle`, which is also how a `failed` is cleared — the
         lookup popup stops this as it goes away, so a pronunciation that could
         not be played leaves no notice to reappear over the NEXT word the
         reader looks up. */
      settle('idle')
    },
  }
}

/** The shared instance — see the header on why there is only one. */
let shared: Voice | null = null

/**
 * The machine's own voice, as the kernel's default `Voice`.
 *
 * Lazily made and then kept, so `services.voice()` answers the same object every
 * time — which is what lets anything that binds a voice later take the port
 * already in the slot as its fallback, rather than building a second voice over
 * the same engine.
 */
export function systemVoice(): Voice {
  shared ??= createSystemVoice()
  return shared
}
