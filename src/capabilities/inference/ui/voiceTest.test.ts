import { describe, expect, it, vi } from 'vitest'
import { TEST_VOICE_LINE, createVoiceTester, type AudioSink, type VoiceTest } from './voiceTest'

/**
 * THE VOICE TEST'S ASYNCHRONOUS HALF, which had no coverage at all.
 *
 * The only case that existed asserted `stopVoice()` on a tester that had never
 * started, plus one reentrancy check — so readiness failure, a synthesis that
 * rejects, playback completion, playback failure, cancellation mid-utterance
 * and disposal mid-flight were all uncovered. Two real defects lived in that
 * gap: a missing `onerror` that left `Speaking…` on screen permanently, and a
 * success path that never released ownership.
 *
 * Playback is injected rather than stubbed globally: these suites run on
 * `node`, so the previous version reached `new Audio(...)`, threw
 * `ReferenceError`, and quietly asserted the part that ran before the throw.
 */

/** An audio sink the test drives by hand. */
function fakeAudio(): {
  sink: AudioSink
  played: Uint8Array[]
  end(): void
  fail(reason?: string): void
  stopped(): number
} {
  const played: Uint8Array[] = []
  let handlers: { ended: () => void; failed: (reason: string) => void } | null = null
  let stops = 0
  return {
    played,
    end: () => handlers?.ended(),
    fail: (reason = 'the audio could not be played') => handlers?.failed(reason),
    stopped: () => stops,
    sink: {
      play: (bytes, on) => {
        played.push(bytes)
        handlers = on
        return { stop: () => void (stops += 1) }
      },
    },
  }
}

interface World {
  readonly tester: ReturnType<typeof createVoiceTester>
  readonly audio: ReturnType<typeof fakeAudio>
  readonly speak: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly states: VoiceTest[]
  readonly events: { event: string; fields: Record<string, unknown> }[]
}

function world(
  over: {
    ensureReady?: () => Promise<boolean>
    speak?: (requestId: string, model: string, text: string, voice: string | null) => Promise<number[]>
  } = {},
): World {
  const audio = fakeAudio()
  const states: VoiceTest[] = []
  const events: { event: string; fields: Record<string, unknown> }[] = []
  const speak = vi.fn(over.speak ?? (async () => [1, 2, 3]))
  const cancel = vi.fn(async (_requestId: string) => {})
  const tester = createVoiceTester({
    plugin: { speak, cancel },
    ensureReady: over.ensureReady ?? (async () => true),
    changed: () => void states.push(tester.state()),
    audio: audio.sink,
    report: (event, fields) => void events.push({ event, fields }),
  })
  return { tester, audio, speak, cancel, states, events }
}

describe('the voice tester', () => {
  it('starts idle and plays nothing', () => {
    const w = world()
    expect(w.tester.state()).toBe('idle')
    expect(w.audio.played).toHaveLength(0)
  })

  it('speaks the standard line through the model it was given', async () => {
    const w = world()
    await w.tester.play('kokoro')
    expect(w.speak).toHaveBeenCalledTimes(1)
    expect(w.speak.mock.calls[0]?.[1]).toBe('kokoro')
    expect(w.speak.mock.calls[0]?.[2]).toBe(TEST_VOICE_LINE)
    expect(w.audio.played).toEqual([Uint8Array.from([1, 2, 3])])
    /* Still speaking: playback has started and nothing has ended it. */
    expect(w.tester.state()).toBe('speaking')
  })

  /**
   * THE SUCCESS PATH RELEASES OWNERSHIP.
   *
   * It used to set `idle` and free the audio while leaving the request token
   * set, so the tester went on claiming a request that had finished — and the
   * next Stop, or the disposal, cancelled it at the daemon for nothing.
   */
  it('returns to idle when playback finishes, and stops claiming the request', async () => {
    const w = world()
    await w.tester.play('kokoro')
    w.audio.end()
    expect(w.tester.state()).toBe('idle')
    expect(w.audio.stopped(), 'the audio was not released when it finished').toBe(1)

    w.tester.stop()
    expect(w.cancel, 'a finished request was cancelled at the daemon').not.toHaveBeenCalled()
  })

  /**
   * ⚠️ THE MISSING `onerror`. Playback failing after it has started reaches
   * nothing else — so before this the row said `Speaking…` for the rest of the
   * session and the blob URL was never revoked.
   */
  it('says it failed when playback fails after starting', async () => {
    const w = world()
    await w.tester.play('kokoro')
    expect(w.tester.state()).toBe('speaking')

    w.audio.fail('unsupported codec')
    expect(w.tester.state(), 'a playback failure left `Speaking…` on screen').toBe('failed')
    expect(w.audio.stopped()).toBe(1)
    expect(w.events).toEqual([
      { event: 'inference.voice-failed', fields: { model: 'kokoro', stage: 'playback', message: 'unsupported codec' } },
    ])
  })

  it('says it failed when the runtime will not start, and never synthesises', async () => {
    const w = world({ ensureReady: async () => false })
    await w.tester.play('kokoro')
    expect(w.tester.state()).toBe('failed')
    expect(w.speak).not.toHaveBeenCalled()
    expect(w.audio.played).toHaveLength(0)
  })

  it('says it failed when synthesis rejects, and says why in the log', async () => {
    const w = world({
      speak: async () => {
        throw new Error('the model is not loaded')
      },
    })
    await w.tester.play('kokoro')
    expect(w.tester.state()).toBe('failed')
    expect(w.audio.played).toHaveLength(0)
    expect(w.events[0]?.fields).toEqual({
      model: 'kokoro',
      stage: 'speak',
      message: 'the model is not loaded',
    })
  })

  /* ONE REQUEST, HOWEVER FAST THE SECOND PRESS IS. The guard reads `state`,
     and `state` becomes `speaking` before the first await — a guard on the far
     side of an await guards nothing. */
  it('spends one request when Play is pressed twice', async () => {
    let release = (): void => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = world({
      ensureReady: async () => {
        await ready
        return true
      },
    })
    const first = w.tester.play('kokoro')
    const second = w.tester.play('kokoro')
    release()
    await Promise.all([first, second])
    expect(w.speak, 'two presses synthesised twice').toHaveBeenCalledTimes(1)
  })

  /**
   * CANCELLING STOPS BOTH — WI-15.9's acceptance in one line.
   *
   * Stopping only the audio would leave the daemon synthesising into nothing,
   * and stopping only the request would leave the sound playing.
   */
  it('stops the audio and the request behind it', async () => {
    const w = world()
    await w.tester.play('kokoro')
    const requestId = w.speak.mock.calls[0]?.[0]

    w.tester.stop()
    expect(w.tester.state()).toBe('idle')
    expect(w.audio.stopped()).toBe(1)
    /* THE SAME ID. A call count alone would pass a tester that cancelled some
       other request and left this one running. */
    expect(w.cancel).toHaveBeenCalledTimes(1)
    expect(w.cancel.mock.calls[0]?.[0]).toBe(requestId)
  })

  it('stopping when nothing is playing is a no-op, and does not throw', () => {
    const w = world()
    expect(() => w.tester.stop()).not.toThrow()
    expect(w.tester.state()).toBe('idle')
    expect(w.cancel).not.toHaveBeenCalled()
  })

  /* A synthesis that lands after Stop belongs to nobody: it must not put
     `Speaking…` back on a row the reader has already stopped. */
  it('ignores a synthesis that lands after the reader stopped', async () => {
    let release = (): void => {}
    const spoken = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = world({
      speak: async () => {
        await spoken
        return [1]
      },
    })
    const playing = w.tester.play('kokoro')
    await Promise.resolve()
    w.tester.stop()
    release()
    await playing

    expect(w.tester.state()).toBe('idle')
    expect(w.audio.played, 'a stopped request still reached the speakers').toHaveLength(0)
  })

  it('stops only the model named, and leaves another one alone', async () => {
    const w = world()
    await w.tester.play('kokoro')
    w.tester.stopIf('some-other-voice')
    expect(w.tester.state()).toBe('speaking')
    w.tester.stopIf('kokoro')
    expect(w.tester.state()).toBe('idle')
    expect(w.cancel).toHaveBeenCalledTimes(1)
  })

  /* An utterance must not outlive the pane that started it — and nothing may
     be notified after disposal, because the listeners are being torn down. */
  it('cancels and releases on dispose, and notifies nobody', async () => {
    const w = world()
    await w.tester.play('kokoro')
    const before = w.states.length

    w.tester.dispose()
    expect(w.cancel).toHaveBeenCalledTimes(1)
    expect(w.audio.stopped()).toBe(1)
    expect(w.states.length, 'a listener was notified after dispose').toBe(before)
  })

  it('writes nothing when the synthesis lands after dispose', async () => {
    let release = (): void => {}
    const spoken = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = world({
      speak: async () => {
        await spoken
        return [1]
      },
    })
    const playing = w.tester.play('kokoro')
    await Promise.resolve()
    w.tester.dispose()
    release()
    await playing
    expect(w.audio.played).toHaveLength(0)
  })
})
