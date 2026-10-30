import { describe, expect, it } from 'vitest'
import {
  HLC_MAX_COUNTER,
  HLC_MAX_MS,
  ZERO_DEVICE,
  asHlc,
  compareHlc,
  deviceOf,
  hlcOf,
  isDeviceId,
  isHlc,
  laterHlc,
  makeHlc,
  parseHlc,
} from './hlc'

const DEV = 'a1b2c3d4e5f60718'

describe('the stamp', () => {
  it('is twelve hex ms, four hex counter, sixteen hex device', () => {
    expect(makeHlc(1, 2, DEV)).toBe(`000000000001-0002-${DEV}`)
    expect(makeHlc(HLC_MAX_MS, HLC_MAX_COUNTER, DEV)).toBe(`ffffffffffff-ffff-${DEV}`)
  })

  it('parses back into its parts', () => {
    expect(parseHlc(makeHlc(0x1234, 0x0f, DEV))).toEqual({ ms: 0x1234, counter: 15, device: DEV })
    expect(deviceOf(makeHlc(5, 5, DEV))).toBe(DEV)
  })

  it('refuses parts out of range rather than clamping them', () => {
    expect(() => makeHlc(-1, 0, DEV)).toThrow(RangeError)
    expect(() => makeHlc(HLC_MAX_MS + 1, 0, DEV)).toThrow(RangeError)
    expect(() => makeHlc(1.5, 0, DEV)).toThrow(RangeError)
    expect(() => makeHlc(0, HLC_MAX_COUNTER + 1, DEV)).toThrow(RangeError)
    expect(() => makeHlc(0, 0, 'ABCDEF0123456789')).toThrow(RangeError)
    expect(() => makeHlc(0, 0, 'short')).toThrow(RangeError)
  })

  it('validates the shape and nothing looser', () => {
    expect(isHlc(`000000000001-0002-${DEV}`)).toBe(true)
    expect(isHlc(`000000000001-0002-${DEV.toUpperCase()}`)).toBe(false)
    expect(isHlc(`00000000001-0002-${DEV}`)).toBe(false)
    expect(isHlc(`000000000001-002-${DEV}`)).toBe(false)
    expect(isHlc(`000000000001-0002-${DEV}0`)).toBe(false)
    expect(isHlc(`000000000001_0002_${DEV}`)).toBe(false)
    expect(isHlc('')).toBe(false)
    expect(isHlc(42)).toBe(false)
    expect(isHlc(null)).toBe(false)
    expect(isDeviceId(DEV)).toBe(true)
    expect(isDeviceId(ZERO_DEVICE)).toBe(true)
    expect(isDeviceId('xyz')).toBe(false)
  })

  it('asHlc trusts a checked string and throws on anything else', () => {
    expect(asHlc(`000000000001-0002-${DEV}`)).toBe(`000000000001-0002-${DEV}`)
    expect(() => asHlc('nope')).toThrow(/not an HLC/)
    expect(() => parseHlc('nope')).toThrow(/not an HLC/)
  })
})

describe('hlcOf — the legacy stamp', () => {
  it('has counter zero and the zero device unless a device is given', () => {
    expect(hlcOf(1_700_000_000_000)).toBe(`${(1_700_000_000_000).toString(16).padStart(12, '0')}-0000-${ZERO_DEVICE}`)
    expect(parseHlc(hlcOf(1_700_000_000_000))).toEqual({ ms: 1_700_000_000_000, counter: 0, device: ZERO_DEVICE })
    expect(deviceOf(hlcOf(7, DEV))).toBe(DEV)
  })

  it('treats a missing or unusable time as the epoch, and floors and clamps a real one', () => {
    expect(parseHlc(hlcOf(undefined)).ms).toBe(0)
    expect(parseHlc(hlcOf(null)).ms).toBe(0)
    expect(parseHlc(hlcOf(Number.NaN)).ms).toBe(0)
    expect(parseHlc(hlcOf(-5)).ms).toBe(0)
    expect(parseHlc(hlcOf(12.9)).ms).toBe(12)
    expect(parseHlc(hlcOf(Number.POSITIVE_INFINITY)).ms).toBe(0)
    expect(parseHlc(hlcOf(HLC_MAX_MS * 4)).ms).toBe(HLC_MAX_MS)
  })

  it('is the same on every replica for the same time — that is the point', () => {
    expect(hlcOf(1234)).toBe(hlcOf(1234))
  })
})

describe('order', () => {
  it('string order is (ms, counter, device) order', () => {
    const a = makeHlc(10, 0, DEV)
    const b = makeHlc(10, 1, ZERO_DEVICE)
    const c = makeHlc(11, 0, ZERO_DEVICE)
    const d = makeHlc(10, 1, DEV)
    expect(compareHlc(a, b)).toBe(-1)
    expect(compareHlc(b, c)).toBe(-1)
    expect(compareHlc(b, d)).toBe(-1) // same ms and counter: device decides
    expect(compareHlc(c, a)).toBe(1)
    expect(compareHlc(a, a)).toBe(0)
    expect([c, d, a, b].sort(compareHlc)).toEqual([a, b, d, c])
  })

  it('agrees with numeric order under a seeded sweep', () => {
    // A small LCG, so the sweep is deterministic and reproducible.
    let seed = 12345
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    const devices = [ZERO_DEVICE, DEV, 'ffffffffffffffff', '0000000000000001']
    for (let i = 0; i < 5000; i++) {
      const x = { ms: next() % 5000, counter: next() % 20, device: devices[next() % 4]! }
      const y = { ms: next() % 5000, counter: next() % 20, device: devices[next() % 4]! }
      const numeric =
        x.ms !== y.ms ? Math.sign(x.ms - y.ms) : x.counter !== y.counter ? Math.sign(x.counter - y.counter) : x.device < y.device ? -1 : x.device > y.device ? 1 : 0
      expect(compareHlc(makeHlc(x.ms, x.counter, x.device), makeHlc(y.ms, y.counter, y.device))).toBe(numeric)
    }
  })

  it('laterHlc takes the later, and anything over undefined', () => {
    const a = makeHlc(1, 0, DEV)
    const b = makeHlc(2, 0, DEV)
    expect(laterHlc(a, b)).toBe(b)
    expect(laterHlc(b, a)).toBe(b)
    expect(laterHlc(undefined, a)).toBe(a)
    expect(laterHlc(a, undefined)).toBe(a)
    expect(laterHlc(undefined, undefined)).toBeUndefined()
  })
})
