import { messageOf } from '../../../kernel'
import type { ReportFailure } from '../lib/controller'
import { mintRequestId, type InferencePlugin } from '../lib/plugin'

/**
 * `Test voice` — one utterance at a time, with one place it ends.
 *
 * # Why this is its own file
 *
 * It was seven mutable variables and four settlement paths inside
 * `createModelsModel`, and the paths disagreed. Success cleared the audio but
 * not the ownership token, so the model went on claiming a request that had
 * finished and would cancel it later for nothing. Failure cleared ownership
 * and then asked `voiceRequest === null ? 'idle' : 'failed'` one line after a
 * guard had already proved it was neither. And `onended` was handled while
 * `onerror` was not, so audio the platform could not decode left `Speaking…`
 * on screen for the rest of the session with the blob URL still held.
 *
 * Three symptoms, one cause: **there was no single place a voice test ends.**
 * There is now — `finish` and `abort` below, and nothing else writes the state.
 *
 * # Ownership, and why every await re-checks it
 *
 * Synthesis is a round trip to a daemon and playback is a browser API; between
 * the press and the sound there are three awaits, and during any of them the
 * reader can press Stop, press Play again, delete the voice, or close the
 * pane. A request that is no longer the current one must write nothing at all
 * — `request` is that token, and it is claimed BEFORE the first await, which
 * is what stops two presses both seeing `idle` and both synthesising.
 */

/** What `Test voice` is doing. */
export type VoiceTest = 'idle' | 'speaking' | 'failed'

/**
 * What `Test voice` says.
 *
 * One short sentence with a comma and a full stop, so the reader hears the
 * prosody rather than a single word — which is the only thing a voice test
 * actually tells them.
 */
export const TEST_VOICE_LINE = 'This is the voice Paper will read aloud with, once reading aloud arrives.'

/** One utterance, playing. */
export interface Utterance {
  /** Stop it and release everything it holds. Safe to call more than once. */
  stop(): void
}

/**
 * Somewhere to play WAV bytes.
 *
 * A SEAM, because the alternative is a suite that cannot see this code at all.
 * The tests run on `node`, where `Audio` does not exist — so the old voice test
 * reached `new Audio(url)`, threw `ReferenceError`, landed in the catch, and
 * asserted only the thing that had already happened before the throw. It passed
 * while covering none of playback. Under jsdom it would be no better:
 * `HTMLMediaElement.play` is famously not implemented there.
 */
export interface AudioSink {
  play(
    bytes: Uint8Array<ArrayBuffer>,
    on: { readonly ended: () => void; readonly failed: (reason: string) => void },
  ): Utterance
}

/** The real one: a blob URL and an `Audio` element. */
export function browserAudio(): AudioSink {
  return {
    play: (bytes, on) => {
      /* A blob URL rather than a data URL: the audio is hundreds of kilobytes,
         and base64 would put a megabyte-long string through the DOM to play
         four seconds of speech. Revoked in `release`, so the bytes go back
         rather than being held for the app's lifetime. */
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
      const element = new Audio(url)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        element.pause()
        URL.revokeObjectURL(url)
      }
      element.onended = () => {
        release()
        on.ended()
      }
      /* ⚠️ AND `onerror`, WHICH WAS MISSING. `play()` resolves as soon as
         playback STARTS; a codec the platform cannot decode fails afterwards
         and reaches nothing but this handler. Without it the row said
         `Speaking…` for the rest of the session and the URL was never revoked —
         a failure that is invisible precisely because it looks like success. */
      element.onerror = () => {
        release()
        on.failed('the audio could not be played')
      }
      void element.play().catch((error: unknown) => {
        release()
        on.failed(messageOf(error))
      })
      return { stop: release }
    },
  }
}

export interface VoiceTester {
  state(): VoiceTest
  /** Synthesise and play the line through `model`. Never rejects. */
  play(model: string): Promise<void>
  /** Stop the utterance AND the request behind it. */
  stop(): void
  /**
   * Stop only if `model` is the one speaking.
   *
   * For the moment before that model is deleted: the Stop button lives on the
   * voice's own row, so removing the model takes the control off the screen
   * while the audio carries on with no way left to end it.
   */
  stopIf(model: string): void
  dispose(): void
}

export interface VoiceTesterOptions {
  readonly plugin: Pick<InferencePlugin, 'speak' | 'cancel'>
  /** Bring the runtime up; false when it could not be. */
  readonly ensureReady: () => Promise<boolean>
  /** Called whenever `state()` may have changed. */
  readonly changed: () => void
  readonly audio?: AudioSink
  readonly report?: ReportFailure
}


export function createVoiceTester({
  plugin,
  ensureReady,
  changed,
  audio = browserAudio(),
  report,
}: VoiceTesterOptions): VoiceTester {
  let state: VoiceTest = 'idle'
  /** The request that owns this tester, or null when nothing is speaking. */
  let request: string | null = null
  /** The model that request speaks through — what `stopIf` matches on. */
  let speaking: string | null = null
  let utterance: Utterance | null = null
  let disposed = false

  const release = (): void => {
    utterance?.stop()
    utterance = null
  }

  /** End `requestId`, if it is still the one that owns the tester. */
  const finish = (requestId: string, next: VoiceTest): void => {
    if (request !== requestId) return
    request = null
    speaking = null
    release()
    state = next
    if (!disposed) changed()
  }

  /** End whatever is running, whoever started it, and tell the daemon. */
  const abort = (): void => {
    const requestId = request
    request = null
    speaking = null
    /* BOTH, which is what WI-15.9's acceptance names: "cancelling
       mid-utterance stops both the audio and the request". Stopping only the
       audio would leave the daemon synthesising into nothing. */
    if (requestId !== null) void plugin.cancel(requestId).catch(() => {})
    release()
    state = 'idle'
    if (!disposed) changed()
  }

  return {
    state: () => state,

    play: async (model) => {
      if (state === 'speaking') return
      /* CLAIMED BEFORE THE FIRST AWAIT, which is the whole of the fix.
       *
       * The reentrancy guard above reads `state`, and `state` used to become
       * `speaking` only after `ensureReady()` resolved — so two presses of
       * Play both saw `idle`, both waited for the runtime, and both went on to
       * synthesise. Two requests, two `Audio` elements, and the first blob URL
       * overwritten before anything could revoke it. A guard on the far side
       * of an await guards nothing. */
      const requestId = mintRequestId('voice')
      request = requestId
      speaking = model
      state = 'speaking'
      changed()

      if (!(await ensureReady())) {
        finish(requestId, 'failed')
        return
      }
      if (request !== requestId || disposed) return

      let bytes: number[]
      try {
        bytes = await plugin.speak(requestId, model, TEST_VOICE_LINE, null)
      } catch (error) {
        /* Cancelling is the reader's own doing, and `abort` has already settled
           this request by the time its rejection arrives — so `finish`'s
           ownership check absorbs it, and anything getting past is a real
           failure worth both a state and a line in the log. */
        report?.('inference.voice-failed', { model, stage: 'speak', message: messageOf(error) })
        finish(requestId, 'failed')
        return
      }
      if (request !== requestId || disposed) return

      const playing = audio.play(Uint8Array.from(bytes), {
        ended: () => finish(requestId, 'idle'),
        failed: (reason) => {
          report?.('inference.voice-failed', { model, stage: 'playback', message: reason })
          finish(requestId, 'failed')
        },
      })
      /* A sink may settle synchronously — a failure known before `play`
         returns. Assigning unconditionally would then leave a finished
         utterance owned by nobody, so ownership is re-read one last time. */
      if (request === requestId) utterance = playing
      else playing.stop()
    },

    stop: abort,
    stopIf: (model) => {
      if (speaking === model) abort()
    },
    dispose: () => {
      /* An utterance must not outlive the pane that started it. `disposed`
         first, so the cancellation goes out but the notification does not —
         the listeners are being torn down in the same breath. */
      disposed = true
      abort()
    },
  }
}
