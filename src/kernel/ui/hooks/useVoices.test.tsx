// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useVoices } from './useVoices'
import { FakeSynth, FakeUtterance } from '../reader/speechSynth.testkit'
import type { VoiceFacts } from '../reader/voiceChoice'

/**
 * The voice list, as the engine announces it.
 *
 * Two answers look alike and must not be treated alike: an empty FIRST read is
 * an engine that has not loaded its list yet, and an empty answer to
 * `voiceschanged` is an engine saying the last voice was removed.
 */

/** An engine that can say who is still listening to it. */
class ListenedSynth extends FakeSynth {
  readonly listeners = new Map<string, number>()

  override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners.set(args[0], (this.listeners.get(args[0]) ?? 0) + 1)
    super.addEventListener(...args)
  }

  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners.set(args[0], (this.listeners.get(args[0]) ?? 0) - 1)
    super.removeEventListener(...args)
  }
}

const ZOE: VoiceFacts = {
  name: 'Zoe',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.enhanced.en-US.Zoe',
  localService: true,
}
const TINGTING: VoiceFacts = {
  name: 'Tingting',
  lang: 'zh-CN',
  voiceURI: 'com.apple.voice.enhanced.zh-CN.Tingting',
  localService: true,
}

let synth: ListenedSynth
const originalUtterance = globalThis.SpeechSynthesisUtterance

beforeEach(() => {
  synth = new ListenedSynth()
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
})

afterEach(() => {
  cleanup()
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  window.SpeechSynthesisUtterance = originalUtterance
})

function mount() {
  const seen: (readonly VoiceFacts[])[] = []
  function Probe() {
    seen.push(useVoices())
    return null
  }
  const view = render(<Probe />)
  return { seen, unmount: () => view.unmount() }
}

/** The engine announcing a new list, as a real one does after a download. */
function announce(voices: VoiceFacts[]) {
  act(() => {
    synth.voices = voices
    synth.dispatchEvent(new Event('voiceschanged'))
  })
}

describe('the first read', () => {
  it('takes a list the engine already has', () => {
    synth.voices = [ZOE]
    const { seen } = mount()
    expect(seen.at(-1)).toEqual([ZOE])
  })

  it('does not take an empty one, which only means the list has not loaded', () => {
    /* ⚠️ TAKEN, IT WOULD BE A NEW EMPTY ARRAY — a second render, and a new
       identity for every memo downstream that lists the voices, for an answer
       that says nothing yet. Every render sees the one constant. */
    const { seen } = mount()
    expect(seen.at(-1)).toEqual([])
    expect(new Set(seen).size, 'an empty first read replaced the list').toBe(1)
  })
})

describe('the engine announcing its list', () => {
  it('is heard, so a list that arrives after the first read reaches the picker', () => {
    const { seen } = mount()
    announce([ZOE, TINGTING])
    expect(seen.at(-1)).toEqual([ZOE, TINGTING])
  })

  it('is believed when it says every voice has gone', () => {
    /* ⚠️ AN EMPTY ANSWER TO THE EVENT IS AUTHORITATIVE. Discarded like an empty
       first read, the picker would go on offering voices the machine no longer
       has. */
    synth.voices = [ZOE]
    const { seen } = mount()
    announce([])
    expect(seen.at(-1)).toEqual([])
  })

  it('stops being listened for once nothing is showing the list', () => {
    const { unmount } = mount()
    expect(synth.listeners.get('voiceschanged')).toBe(1)
    unmount()
    expect(synth.listeners.get('voiceschanged'), 'the listener outlived the component').toBe(0)
  })
})

describe('a machine with no engine', () => {
  it('answers no voices and listens for nothing', () => {
    delete (window as { speechSynthesis?: unknown }).speechSynthesis
    const { seen } = mount()
    expect(seen.at(-1)).toEqual([])
    expect(synth.listeners.size).toBe(0)
  })
})
