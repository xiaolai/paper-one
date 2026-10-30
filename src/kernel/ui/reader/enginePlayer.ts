/**
 * Playing what an engine rendered, and knowing where in it we are.
 *
 * ⚠️ **WEB AUDIO HAS NO PAUSE.** An `AudioBufferSourceNode` starts once and
 * cannot be restarted: `stop()` ends it for good. So pausing is stopping and
 * remembering the offset, and resuming is a NEW source started at that offset.
 * Everything awkward here follows from that, and a player that looks like it
 * could just call `pause()` is a player that has not met the API.
 *
 * ⚠️ **AND `currentTime` KEEPS RUNNING WHILE NOTHING PLAYS.** It is the
 * context's clock, not the sound's, so the position has to be accumulated
 * across pauses rather than read. Reading it directly makes a paused reading's
 * highlight race ahead of the voice and arrive at the end of the sentence
 * while the reader is still looking at the first word.
 */

import { toFloats } from './pcm'

/** The part of `AudioContext` this needs, so the whole of it is testable. */
export interface AudioHost {
  readonly currentTime: number
  readonly sampleRate: number
  readonly state: string
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike
  createBufferSource(): SourceLike
  readonly destination: unknown
  resume(): Promise<void>
  /**
   * Give the output device back.
   *
   * ⚠️ **NOT OPTIONAL, BECAUSE A CONTEXT NOBODY CLOSES IS A DEVICE NOBODY GETS
   * BACK.** `useVoicePacks` makes one on the first Listen and released only the
   * MODEL on unmount; the context stayed, holding an output device and counting
   * against the per-page limit some browsers apply. Declared here so every host
   * — including the fake the tests drive — has to answer it.
   */
  close(): Promise<void>
}

export interface AudioBufferLike {
  copyToChannel(source: Float32Array, channel: number): void
  readonly duration: number
}

export interface SourceLike {
  buffer: AudioBufferLike | null
  playbackRate: { value: number }
  onended: (() => void) | null
  connect(destination: unknown): void
  disconnect(): void
  start(when?: number, offset?: number): void
  stop(when?: number): void
}

/** A sound in progress. */
export interface Playing {
  /** Where the sound has got to, in milliseconds, counting only time spent playing. */
  positionMs(): number
  /** How long the whole sound is, in milliseconds. */
  readonly durationMs: number
  pause(): void
  resume(): void
  /**
   * Go to a point in the sound, and keep playing (or stay paused) as before.
   *
   * ⚠️ **THIS IS WHAT WI-34.3 IS, AND IT IS ALMOST FREE HERE.** `begin(offsetMs)`
   * already existed — it is how `resume` picks a paused sound back up — so a seek
   * is that same call with a different number. The reason it was impossible
   * before is not the player: it is that the buffer used to be ONE SENTENCE, so
   * there was nowhere inside it worth going. One buffer for a whole section is
   * what makes a position meaningful.
   *
   * Clamped rather than refused: a caller asking for -5 means the beginning, and
   * a caller asking past the end means the end. Refusing would make every caller
   * repeat the bound, and a bound repeated is a bound that drifts.
   */
  seekToMs(ms: number): void
  /** End it. `onEnded` is NOT called for a stop: the caller already knows. */
  stop(): void
  readonly paused: boolean
  readonly done: boolean
}

/**
 * Play 16-bit PCM, answering a handle that can pause, resume and stop.
 *
 * `onEnded` fires exactly once, when the sound runs out on its own — never for
 * a `stop()`, and never twice. A source that is stopped still delivers its
 * `onended`, which is the same shape as `Speaker`'s late-`end` problem and is
 * why `stopped` is checked rather than assumed.
 */
export function playPcm(
  host: AudioHost,
  pcm: Uint8Array,
  sampleRate: number,
  onEnded: () => void,
  rate = 1,
): Playing {
  const floats = toFloats(pcm)
  const buffer = host.createBuffer(1, Math.max(1, floats.length), sampleRate)
  buffer.copyToChannel(floats, 0)

  /* Milliseconds already played, before the current run. */
  let playedMs = 0
  /**
   * The source that is sounding and the clock reading it started on — or null
   * while paused, stopped or finished.
   *
   * ⚠️ **ONE VALUE, WHERE THERE WERE TWO.** A `source` and a `startedAt`
   * were separate nullables, so the type said four states and the player only
   * ever has two: a source always has a start time and a start time always has
   * a source. Every place that read one then checked the other for `null`
   * carried a branch that could not come back false — five of them, each an
   * unkillable mutant standing over a state this player cannot be in.
   */
  let live: { readonly node: SourceLike; readonly startedAt: number } | null = null
  let stopped = false
  let finished = false
  /* A speed of 1 means the buffer's own; anything else scales the clock too,
   * or every word lands where it would have at normal speed. */
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1

  /** The whole sound, in milliseconds. Read once; a buffer does not change. */
  const wholeMs = buffer.duration * 1000

  /**
   * Where the sound has got to — never past its end.
   *
   * ⚠️ **IT COULD EXCEED THE DURATION, AND A PAUSE PRESERVED THE OVERSHOOT —
   * FOUND BY AN INDEPENDENT AUDIT, 2026-09-30.** `onended` arrives on the
   * engine's own schedule, and the context clock keeps running until it does: a
   * 1 000 ms buffer reported 1 200 ms, and `pause` then folded that 1 200 into
   * `playedMs` permanently. A transport reading it shows a chapter past its own
   * end, and `EngineSpeaker.seekToMs` counts every word as said for a reading
   * that has not finished.
   */
  const positionMs = (): number => {
    const sounding = live
    if (sounding === null) return Math.min(playedMs, wholeMs)
    return Math.min(playedMs + (host.currentTime - sounding.startedAt) * 1000 * speed, wholeMs)
  }

  /**
   * Take a source down.
   *
   * ⚠️ **THE HANDLER GOES FIRST.** A stopped `AudioBufferSourceNode` still
   * delivers its `onended`, late — and reading that as an ending reports a
   * sentence finished that the reader cancelled. Clearing it here is the
   * invariant that lets `onended` below test `finished` alone: no source this
   * player has let go can call back at all.
   */
  const release = (node: SourceLike) => {
    node.onended = null
    node.stop()
    node.disconnect()
  }

  /** Take the time spent sounding into the running total, and let the source go. */
  const settle = (sounding: { readonly node: SourceLike; readonly startedAt: number }) => {
    /* ⚠️ **NOT CLAMPED HERE, AND THAT WAS TRIED.** The obvious repair for the
     * overshoot was to clamp on the way IN as well as on the way out, and it is
     * an equivalent mutant: `positionMs()` clamps every read, and the only other
     * reader of this value is `resume`, whose `playedMs >= wholeMs` branch
     * answers the same either way — 1 200 and 1 000 are both "past the end".
     * Hand-applied 2026-09-30: the whole suite passes with the clamp and without
     * it, which is what a line no test can tell from its absence looks like. */
    playedMs += (host.currentTime - sounding.startedAt) * 1000 * speed
    live = null
    release(sounding.node)
  }

  const begin = (offsetMs: number) => {
    const node = host.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = speed
    /* Without this the sound is rendered and reaches no output at all — a
       reading that runs to the end of the chapter in silence. */
    node.connect(host.destination)
    node.onended = () => {
      /* Only once. A source is only ever reached here having run OUT: every
         other road out of this player clears the handler first (`release`). */
      if (finished) return
      finished = true
      live = null
      playedMs = wholeMs
      onEnded()
    }
    live = { node, startedAt: host.currentTime }
    node.start(0, offsetMs / 1000)
  }

  begin(0)

  return {
    positionMs,
    durationMs: wholeMs,
    get paused() {
      return live === null && !stopped && !finished
    },
    get done() {
      return finished || stopped
    },
    pause() {
      const sounding = live
      if (sounding === null) return
      settle(sounding)
    },
    resume() {
      if (live !== null || stopped || finished) return
      /* Past the end already — resuming would start a source beyond the
       * buffer, which some engines play as silence and others refuse. */
      if (playedMs >= wholeMs) {
        finished = true
        onEnded()
        return
      }
      begin(playedMs)
    },
    seekToMs(ms: number) {
      /* A sound that has ended or been stopped is not somewhere to seek in:
         its source is gone and `begin` would start a second one over a reading
         nobody is listening to. */
      if (stopped || finished) return
      const wanted = Number.isFinite(ms) ? Math.min(Math.max(0, ms), wholeMs) : 0
      const sounding = live
      if (sounding === null) {
        /* Paused. Move the mark and let `resume` start there — which is the same
           road a pause already takes, so there is one way to begin at an offset
           rather than two. */
        playedMs = wanted
        return
      }
      /* ⚠️ **THE OLD SOURCE IS RELEASED, NOT LEFT TO END.** An
         `AudioBufferSourceNode` cannot be moved; a seek is a new source. Left
         connected, the old one keeps sounding under the new one — two voices
         reading the same chapter a minute apart, which is what happened the first
         time this was written without `release`. */
      release(sounding.node)
      live = null
      playedMs = wanted
      begin(wanted)
    },
    stop() {
      /* Marked before the early answer below, so a stop while paused is still
         a stop — and a second stop has nothing left to take down. */
      stopped = true
      const sounding = live
      if (sounding === null) return
      settle(sounding)
    },
  }
}
