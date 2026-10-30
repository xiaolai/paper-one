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

describe('the position never runs past the sound', () => {
  /* ⚠️ **IT COULD, AND A PAUSE PRESERVED THE OVERSHOOT — FOUND BY AN
     INDEPENDENT AUDIT, 2026-09-30.** `onended` arrives on the engine's own
     schedule and the context clock keeps running until it does: a 1 000 ms
     buffer reported 1 200 ms, and `pause` folded that into `playedMs`
     permanently. A transport reading it shows a chapter past its own end, and
     `EngineSpeaker.seekToMs` counts every word as said for a reading that has
     not finished. */
  const RATE = 24_000

  it('clamps what it reports while the sound is still nominally playing', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, pcmOf(RATE), RATE, () => {})
    expect(playing.durationMs).toBeCloseTo(1000, 0)
    host.advance(1200)
    expect(playing.positionMs(), 'never past the end').toBeCloseTo(1000, 0)
  })

  it('a pause does not carry the overshoot out to any reader', () => {
    /* ⚠️ **THE ACCUMULATED VALUE IS DELIBERATELY NOT CLAMPED** — see `settle`.
       Every reader goes through `positionMs()`, which clamps, and `resume`'s
       `playedMs >= wholeMs` branch answers the same either way. Clamping there
       too was hand-applied and changed nothing, which is what an equivalent
       mutant looks like. What this case pins is the OBSERVABLE property. */
    const host = new FakeAudioHost()
    const playing = playPcm(host, pcmOf(RATE), RATE, () => {})
    host.advance(1200)
    playing.pause()
    expect(playing.positionMs()).toBeCloseTo(1000, 0)
    host.advance(5000)
    expect(playing.positionMs(), 'a paused clock does not move it either').toBeCloseTo(1000, 0)
  })

  it('leaves an ordinary position alone', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, pcmOf(RATE), RATE, () => {})
    host.advance(400)
    expect(playing.positionMs()).toBeCloseTo(400, 0)
    playing.pause()
    expect(playing.positionMs()).toBeCloseTo(400, 0)
  })

  it('clamps at a speed other than one, where the overshoot arrives faster', () => {
    const host = new FakeAudioHost()
    const playing = playPcm(host, pcmOf(RATE), RATE, () => {}, 2)
    host.advance(700)
    expect(playing.positionMs(), '700 ms of clock is 1 400 ms of sound').toBeCloseTo(1000, 0)
  })
})

/**
 * ⚠️ **`seekToMs` HAD NO CASE IN THIS FILE AT ALL — FOUND BY THE MUTATION SWEEP,
 * which reported twelve `NoCoverage` mutants in one method.** It is reached
 * through `EngineSpeaker` in the other file's cases, and that is a test of the
 * speaker: every bound, every clamp and every branch here was replaceable with
 * nothing failing. A seek is the phase's own gesture and this is where it lives.
 */
describe('seeking, which is a new source and not a moved one', () => {
  it('releases the old source and begins another at the offset', () => {
    /* ⚠️ **AN `AudioBufferSourceNode` CANNOT BE MOVED.** Left connected, the old
       one keeps sounding under the new: two voices reading the same chapter a
       minute apart, which is what happened the first time this was written
       without the release. */
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    host.advance(100)
    playing.seekToMs(600)
    expect(host.sources, 'a second source').toHaveLength(2)
    expect(host.sources[0]!.stops, 'and the first was stopped').toBe(1)
    expect(host.sources[0]!.disconnects, 'and taken off the output').toBe(1)
    expect(host.latest.started).toEqual([{ when: 0, offset: 0.6 }])
    expect(playing.positionMs()).toBeCloseTo(600, 6)
  })

  it('clamps to the sound at both ends, and takes anything unreadable as the start', () => {
    /* Past the end, a source would begin beyond the buffer — silence on some
       engines and a refusal on others. Before the start is not a position at all. */
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    playing.seekToMs(99_999)
    expect(playing.positionMs()).toBeCloseTo(1000, 6)
    expect(host.latest.started).toEqual([{ when: 0, offset: 1 }])
    playing.seekToMs(-500)
    expect(playing.positionMs()).toBe(0)
    expect(host.latest.started).toEqual([{ when: 0, offset: 0 }])
    for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      playing.seekToMs(500)
      playing.seekToMs(unreadable)
      expect(playing.positionMs(), String(unreadable)).toBe(0)
    }
  })

  it('moves the mark while paused, and starts there on resume', () => {
    /* ⚠️ **ONE ROAD TO BEGINNING AT AN OFFSET, NOT TWO.** A paused player has no
       source to release, so the seek moves the mark and `resume` does the rest —
       which is the road a pause already takes. */
    const host = new FakeAudioHost()
    const playing = playPcm(host, ONE_SECOND, 24_000, () => {})
    playing.pause()
    const sources = host.sources.length
    playing.seekToMs(700)
    expect(host.sources, 'nothing began while paused').toHaveLength(sources)
    expect(playing.positionMs()).toBeCloseTo(700, 6)
    playing.resume()
    expect(host.latest.started).toEqual([{ when: 0, offset: 0.7 }])
  })

  it('refuses a seek after a stop and after the sound has run out', () => {
    /* ⚠️ **BOTH, AND THEY ARE DIFFERENT STATES.** A stopped reading's source is
       gone by the reader's own asking; a finished one ran out on its own. In
       either, beginning again would start a source over a reading nobody is
       listening to — and `onEnded` has already been reported. */
    const stopped = new FakeAudioHost()
    const afterStop = playPcm(stopped, ONE_SECOND, 24_000, () => {})
    stopped.advance(300)
    afterStop.stop()
    const wasStopped = stopped.sources.length
    const atStop = afterStop.positionMs()
    afterStop.seekToMs(500)
    expect(stopped.sources, 'nothing began after a stop').toHaveLength(wasStopped)
    /* ⚠️ **THE POSITION, NOT ONLY THE SOURCES — FOUND BY THE MUTATION SWEEP.**
       With `live` already null, a seek that got past the guard takes the PAUSED
       road: it moves the mark and starts nothing, so counting sources cannot see
       it. What it leaves behind is a stopped reading claiming to be somewhere it
       never reached. */
    expect(afterStop.positionMs(), 'and the mark did not move either').toBe(atStop)

    const ran = new FakeAudioHost()
    const ended = vi.fn()
    const afterEnd = playPcm(ran, ONE_SECOND, 24_000, ended)
    ran.latest.end()
    expect(ended).toHaveBeenCalledTimes(1)
    const wasRun = ran.sources.length
    const atEnd = afterEnd.positionMs()
    afterEnd.seekToMs(500)
    expect(ran.sources, 'nor after the sound ran out').toHaveLength(wasRun)
    expect(afterEnd.positionMs(), 'nor did the mark').toBe(atEnd)
    expect(ended, 'and the ending was not reported twice').toHaveBeenCalledTimes(1)
  })
})
