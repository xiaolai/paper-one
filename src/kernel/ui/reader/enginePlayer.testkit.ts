/**
 * A fake audio host, so the player is tested without a browser.
 *
 * The clock is DRIVEN rather than real — `advance(ms)` — because every question
 * worth asking here is about where the sound has got to, and a test that waits
 * for real time measures the machine.
 */

import type { AudioBufferLike, AudioHost, SourceLike } from './enginePlayer'

export interface FakeSource extends SourceLike {
  readonly started: { when: number | undefined; offset: number | undefined }[]
  readonly stops: number
  readonly disconnects: number
  /** What it was wired to. A source that reaches no destination makes no sound. */
  readonly connections: unknown[]
  /** Deliver `onended`, as a real source does when it runs out — and, late, when it is stopped. */
  end(): void
}

export class FakeAudioHost implements AudioHost {
  currentTime = 0
  sampleRate = 24_000
  state = 'running'
  readonly destination = {}
  readonly sources: FakeSource[] = []
  readonly buffers: { channels: number; length: number; sampleRate: number; written: Float32Array | null }[] = []

  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike {
    const record = { channels, length, sampleRate, written: null as Float32Array | null }
    this.buffers.push(record)
    return {
      copyToChannel: (source: Float32Array) => {
        record.written = source
      },
      get duration() {
        return length / sampleRate
      },
    }
  }

  createBufferSource(): SourceLike {
    const started: { when: number | undefined; offset: number | undefined }[] = []
    const source: FakeSource = {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      started,
      stops: 0,
      disconnects: 0,
      connections: [],
      connect(destination: unknown) {
        ;(this as { connections: unknown[] }).connections.push(destination)
      },
      disconnect() {
        ;(this as { disconnects: number }).disconnects += 1
      },
      start(when?: number, offset?: number) {
        started.push({ when, offset })
      },
      stop() {
        ;(this as { stops: number }).stops += 1
      },
      end() {
        this.onended?.()
      },
    }
    this.sources.push(source)
    return source
  }

  /** How many times each was asked for, so a case can pin the lifecycle. */
  resumes = 0
  closes = 0

  async resume(): Promise<void> {
    this.resumes += 1
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.closes += 1
    this.state = 'closed'
  }

  /** Move the context's clock, in milliseconds. */
  advance(ms: number): void {
    this.currentTime += ms / 1000
  }

  /** The source that is playing now, which is always the last one made. */
  get latest(): FakeSource {
    const last = this.sources.at(-1)
    if (!last) throw new Error('nothing has played yet')
    return last
  }
}

/** 16-bit PCM of a given length, loud enough to be audible. */
export function pcmOf(samples: number, value = 8000): Uint8Array {
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, value, true)
  return out
}
