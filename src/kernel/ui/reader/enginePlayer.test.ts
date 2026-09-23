import { describe, expect, it, vi } from 'vitest'
import { playPcm } from './enginePlayer'
import { FakeAudioHost, pcmOf } from './enginePlayer.testkit'

/** One second of audio at the engines' rate. */
const ONE_SECOND = pcmOf(24_000)

describe('playing what an engine rendered', () => {
  it('starts at the beginning and reports where it has got to', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    expect(host.latest.started).toEqual([{ when: 0, offset: 0 }])
    expect(playing.positionMs()).toBe(0)
    host.advance(400)
    expect(playing.positionMs()).toBeCloseTo(400, 6)
  })

  it('reports an ending once, when the sound runs out', () => {
    const host = new FakeAudioHost()
    const ended = vi.fn()
    const playing = playPcm(host, ONE_SECOND, 24_000, ended)
    host.advance(1000)
    host.latest.end()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(playing.done).toBe(true)
    // A second delivery changes nothing: an engine may send one, and a reading
    // told twice that a sentence finished turns two pages.
    host.latest.end()
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('does not report an ending for a stop', () => {
    // The caller that stopped it already knows. This is `Speaker`'s late-`end`
    // problem in another engine: a stopped source still delivers `onended`,
    // and reading that as an ending reports a section the reader cancelled.
    const host = new FakeAudioHost()
    const ended = vi.fn()
    const playing = playPcm(host, ONE_SECOND, 24_000, ended)
    host.advance(300)
    playing.stop()
    host.sources[0]?.onended?.()
    expect(ended).not.toHaveBeenCalled()
    expect(playing.done).toBe(true)
  })
})

describe('pausing, which Web Audio cannot do', () => {
  it('stops the source and keeps the position', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(250)
    playing.pause()
    expect(playing.paused).toBe(true)
    expect(host.sources[0]?.stops).toBe(1)
    expect(playing.positionMs()).toBeCloseTo(250, 6)
  })

  it('does not let the position run on while paused', () => {
    // ⚠️ The failure this catches: `currentTime` is the CONTEXT's clock and
    // keeps running with nothing playing, so a position read from it directly
    // races to the end of the sentence while the reader is looking at word one.
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(250)
    playing.pause()
    host.advance(5_000)
    expect(playing.positionMs()).toBeCloseTo(250, 6)
  })

  it('resumes from where it stopped, with a new source', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(250)
    playing.pause()
    host.advance(9_000)
    playing.resume()
    expect(playing.paused).toBe(false)
    expect(host.sources).toHaveLength(2)
    expect(host.latest.started[0]?.offset).toBeCloseTo(0.25, 6)
    host.advance(100)
    expect(playing.positionMs()).toBeCloseTo(350, 6)
  })

  it('ignores a pause that is not playing and a resume that is', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    playing.resume()
    expect(host.sources).toHaveLength(1)
    playing.pause()
    playing.pause()
    expect(host.sources[0]?.stops).toBe(1)
  })

  it('ends rather than starting past the end of the sound', () => {
    // Resuming at an offset beyond the buffer plays silence on some engines
    // and throws on others; neither is a reading that continues.
    const host = new FakeAudioHost()
    const ended = vi.fn()
    const playing = playPcm(host, ONE_SECOND, 24_000, ended)
    host.advance(1_200)
    playing.pause()
    playing.resume()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(host.sources).toHaveLength(1)
  })

  it('neither pauses nor resumes after a stop', () => {
    const host = new FakeAudioHost()
    const ended = vi.fn()
    const playing = playPcm(host, ONE_SECOND, 24_000, ended)
    playing.stop()
    playing.pause()
    playing.resume()
    expect(host.sources).toHaveLength(1)
    expect(ended).not.toHaveBeenCalled()
    expect(playing.paused).toBe(false)
  })
})

describe('speed', () => {
  it('scales the clock as well as the sound', () => {
    // Otherwise every word lands where it would have at normal speed, which is
    // a highlight drifting further behind with each sentence.
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {}, 2)
    expect(host.latest.playbackRate.value).toBe(2)
    host.advance(250)
    expect(playing.positionMs()).toBeCloseTo(500, 6)
  })

  it('refuses a speed that is not one', () => {
    const host = new FakeAudioHost()
    playPcm(host, ONE_SECOND, 24_000, () => {}, 0)
    expect(host.latest.playbackRate.value).toBe(1)
    playPcm(host, ONE_SECOND, 24_000, () => {}, Number.NaN)
    expect(host.latest.playbackRate.value).toBe(1)
    playPcm(host, ONE_SECOND, 24_000, () => {}, -2)
    expect(host.latest.playbackRate.value).toBe(1)
  })
})

describe('the buffer it builds', () => {
  it("is mono at the engine's own rate", () => {
    const host = new FakeAudioHost()
    playPcm(host, ONE_SECOND, 24_000, () => {})
    expect(host.buffers[0]).toMatchObject({ channels: 1, length: 24_000, sampleRate: 24_000 })
    expect(host.buffers[0]?.written?.length).toBe(24_000)
  })

  it('never asks for a buffer of nothing', () => {
    // `createBuffer(1, 0, rate)` throws in every browser, and an empty render
    // is a thing the engines refuse but a dropped transfer is not.
    const host = new FakeAudioHost()
    expect(() => playPcm(host, new Uint8Array(0), 24_000, () => {})).not.toThrow()
    expect(host.buffers[0]?.length).toBe(1)
  })
})

describe('the wiring, and the states this player cannot be in', () => {
  it('wires the source to the output, or the reading runs in silence', () => {
    /* Nothing throws and nothing reports an error when a source is never
       connected: the chapter plays to the end and the reader hears nothing. */
    const host = new FakeAudioHost()
    playPcm(host, ONE_SECOND, 24_000, () => {})
    expect(host.latest.connections).toEqual([host.destination])
  })

  it('is not done while it is playing', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    expect(playing.done).toBe(false)
    host.advance(400)
    expect(playing.done).toBe(false)
  })

  it('reports the whole sound played once it has ended', () => {
    // In MILLISECONDS, like every other position here: a duration in seconds
    // puts the last words of the sentence a thousandth of the way in.
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(1000)
    host.latest.end()
    expect(playing.positionMs()).toBe(1000)
  })

  it('takes a source right down on a pause, and on a stop', () => {
    /* ⚠️ THREE THINGS, and the first is what makes the rest of this file
       simple: clearing `onended` is why no stale source can report an ending.
       A source left connected also holds an output node for the whole
       reading. One case per road, because a road that forgets is exactly what
       this replaced a guard with. */
    for (const road of ['pause', 'stop'] as const) {
      const host = new FakeAudioHost()
      const ended = vi.fn()
      const playing = playPcm(host, ONE_SECOND, 24_000, ended)
      const node = host.latest
      host.advance(400)
      playing[road]()
      expect(node.stops, road).toBe(1)
      expect(node.disconnects, road).toBe(1)
      node.end()
      expect(ended, road).not.toHaveBeenCalled()
    }
  })

  it('does nothing at all for a pause or a stop that has nothing sounding', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(400)
    playing.pause()
    const at = playing.positionMs()
    host.advance(5000)
    playing.pause()
    expect(playing.positionMs(), 'a second pause counts no time').toBe(at)
    playing.stop()
    host.advance(5000)
    playing.stop()
    expect(playing.positionMs(), 'and neither does a second stop').toBe(at)
    expect(host.latest.stops, 'the source is taken down once').toBe(1)
  })

  it('stops a reading that was paused, rather than leaving it paused for ever', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(400)
    playing.pause()
    playing.stop()
    expect(playing.done).toBe(true)
    expect(playing.paused).toBe(false)
  })

  it('counts a pause from when the sound started, and at the speed it was played', () => {
    /* ⚠️ TWO ARITHMETIC MISTAKES THAT LOOK RIGHT FROM A CLOCK THAT STARTS AT
       ZERO: adding the start time instead of subtracting it, and dividing by
       the speed instead of multiplying. Both are invisible while the context
       clock is 0 and the speed is 1 — which is every reading in a test and no
       reading in the app, where the clock has been running since the first
       Listen and the reader may have chosen 1.5×. */
    const host = new FakeAudioHost()
    host.advance(9000)
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {}, 2)
    host.advance(300)
    playing.pause()
    expect(playing.positionMs()).toBeCloseTo(600, 6)
    host.advance(5000)
    expect(playing.positionMs(), 'and nothing accrues while it is paused').toBeCloseTo(600, 6)
    playing.resume()
    host.advance(100)
    expect(playing.positionMs()).toBeCloseTo(800, 6)
  })

  it('ends at exactly the end, rather than starting a source of no length', () => {
    /* The bound is `>=`: paused on the last sample, there is nothing left to
       play, and a source started at the buffer's own duration is silence in
       some engines and a refusal in others. */
    const host = new FakeAudioHost()
    const ended = vi.fn()
    const playing = playPcm(host, ONE_SECOND, 24_000, ended)
    host.advance(1000)
    playing.pause()
    expect(playing.positionMs()).toBe(1000)
    const sources = host.sources.length
    playing.resume()
    expect(ended).toHaveBeenCalledTimes(1)
    expect(playing.done, 'and it is finished, not waiting').toBe(true)
    expect(host.sources.length, 'no new source was started').toBe(sources)
  })
})
