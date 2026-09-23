import { describe, expect, it } from 'vitest'
import { audible, sampleCount, toFloats } from './pcm'

/** 16-bit little-endian bytes for the given samples. */
function bytes(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return out
}

describe('counting samples', () => {
  it('counts two bytes to the sample', () => {
    expect(sampleCount(bytes(0, 1, -1))).toBe(3)
    expect(sampleCount(new Uint8Array(0))).toBe(0)
  })

  it('drops a trailing half sample rather than reading past the end', () => {
    // What a truncated transfer looks like. `length / 2` would claim a sample
    // that is half somebody else's memory.
    expect(sampleCount(new Uint8Array(5))).toBe(2)
  })
})

describe('reading the samples', () => {
  it('reads little-endian, signed', () => {
    const floats = toFloats(bytes(0, 32767, -32768, -1))
    expect(floats[0]).toBe(0)
    expect(floats[1]).toBeCloseTo(0.99997, 4)
    expect(floats[2]).toBe(-1)
    expect(floats[3]).toBeCloseTo(-0.00003, 4)
  })

  it('keeps every sample inside the range WebAudio expects', () => {
    const floats = toFloats(bytes(32767, -32768))
    for (const value of floats) {
      expect(value).toBeGreaterThanOrEqual(-1)
      expect(value).toBeLessThan(1)
    }
  })

  it('reads a slice of a larger buffer, not the buffer from the start', () => {
    // The failure this catches is silent and sounds like noise: a `Uint8Array`
    // that is a VIEW of a bigger transfer, read from offset 0, plays somebody
    // else's bytes.
    const whole = bytes(999, 111, 222)
    const tail = whole.subarray(2)
    const floats = toFloats(tail)
    expect(floats.length).toBe(2)
    expect(floats[0]).toBeCloseTo(111 / 32768, 6)
    expect(floats[1]).toBeCloseTo(222 / 32768, 6)
  })

  it('reads nothing from nothing', () => {
    expect(toFloats(new Uint8Array(0)).length).toBe(0)
  })
})

describe('whether it is audible at all', () => {
  it('hears a tone whose period divides the old sampling stride', () => {
    /* ⚠️ **THE DEFECT THIS FUNCTION WAS REWRITTEN FOR, 2026-09-23.** `audible`
       took 512 evenly-spaced samples, and evenly spaced is the one arrangement
       that can land on a periodic signal's zero crossings every time. At
       `sampleRate / step` — 258.06 Hz for 48 000 samples at 24 kHz — a tone
       peaking at 7 994 of 32 767 came back `false`, and the reader loses a
       sentence that rendered perfectly. */
    const count = 48_000
    const rate = 24_000
    const freq = rate / Math.max(1, Math.floor(count / 512))
    const buf = new ArrayBuffer(count * 2)
    const view = new DataView(buf)
    for (let i = 0; i < count; i += 1) {
      view.setInt16(i * 2, Math.round(0.244 * 32_767 * Math.sin((2 * Math.PI * freq * i) / rate)), true)
    }
    expect(audible(new Uint8Array(buf))).toBe(true)
  })

  it('hears speech', () => {
    const speech = bytes(...new Array(48_000).fill(0).map((_, i) => Math.round(8000 * Math.sin(i / 8))))
    expect(audible(speech)).toBe(true)
  })

  it('refuses silence of exactly the right length', () => {
    // The failure worth naming: everything about this block is correct except
    // that there is no sound in it, and nothing else can tell.
    expect(audible(bytes(...new Array(48_000).fill(0)))).toBe(false)
    expect(audible(new Uint8Array(0))).toBe(false)
  })

  it('does not mistake dither or a dc offset for speech', () => {
    expect(audible(bytes(...new Array(1000).fill(4)))).toBe(false)
    expect(audible(bytes(...new Array(1000).fill(-4)))).toBe(false)
  })

  it('finds speech that starts late in a long block', () => {
    // Sampled rather than scanned, so this is the case that would be missed by
    // a naive stride: a lead-in of silence and one loud passage near the end.
    const samples = new Array(96_000).fill(0)
    for (let i = 90_000; i < 92_000; i += 1) samples[i] = 12_000
    expect(audible(bytes(...samples))).toBe(true)
  })
})
