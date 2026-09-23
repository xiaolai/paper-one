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
  /* The context clock when the current run started, or null while paused. */
  let startedAt: number | null = null
  let source: SourceLike | null = null
  let stopped = false
  let finished = false
  /* A speed of 1 means the buffer's own; anything else scales the clock too,
   * or every word lands where it would have at normal speed. */
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1

  const positionMs = (): number => {
    if (startedAt === null) return playedMs
    return playedMs + (host.currentTime - startedAt) * 1000 * speed
  }

  const begin = (offsetMs: number) => {
    const node = host.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = speed
    node.connect(host.destination)
    node.onended = () => {
      /* Only the source that is still current, and only when it ran out. A
       * stopped source delivers this too, late, and reading it as an ending
       * reports a sentence finished that the reader cancelled. */
      if (stopped || node !== source || finished) return
      finished = true
      startedAt = null
      playedMs = buffer.duration * 1000
      onEnded()
    }
    source = node
    startedAt = host.currentTime
    node.start(0, offsetMs / 1000)
  }

  begin(0)

  return {
    positionMs,
    get paused() {
      return startedAt === null && !stopped && !finished
    },
    get done() {
      return finished || stopped
    },
    pause() {
      if (startedAt === null || stopped || finished) return
      playedMs = positionMs()
      startedAt = null
      const node = source
      source = null
      if (node) {
        node.onended = null
        node.stop()
        node.disconnect()
      }
    },
    resume() {
      if (startedAt !== null || stopped || finished) return
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
      if (stopped) return
      stopped = true
      playedMs = positionMs()
      startedAt = null
      const node = source
      source = null
      if (node) {
        node.onended = null
        node.stop()
        node.disconnect()
      }
    },
  }
}
