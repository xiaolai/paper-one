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
  pause(): void
  resume(): void
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

  const positionMs = (): number => {
    const sounding = live
    if (sounding === null) return playedMs
    return playedMs + (host.currentTime - sounding.startedAt) * 1000 * speed
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
      playedMs = buffer.duration * 1000
      onEnded()
    }
    live = { node, startedAt: host.currentTime }
    node.start(0, offsetMs / 1000)
  }

  begin(0)

  return {
    positionMs,
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
      if (playedMs >= buffer.duration * 1000) {
        finished = true
        onEnded()
        return
      }
      begin(playedMs)
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
