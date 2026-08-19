import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HLC_MAX_MS, createSettingsStore } from '../../../kernel'
import {
  ZERO_DEVICE,
  compareHlc,
  createClock,
  deviceOf,
  ensureDeviceId,
  hlcOf,
  isHlc,
  makeHlc,
  parseHlc,
  type Hlc,
} from './clock'

const DEV = 'a1b2c3d4e5f60718'
const OTHER = 'ffeeddccbbaa9988'

describe('createClock — monotone issue', () => {
  it('70 000 stamps under a frozen wall clock stay strictly increasing', () => {
    // 70 000 > 65 536, so the counter MUST overflow into the wall field —
    // the frozen clock forces both the counter branch and the overflow branch.
    const clock = createClock({ deviceId: DEV, now: () => 1_000 })
    let previous: Hlc | null = null
    for (let i = 0; i < 70_000; i++) {
      const stamp = clock.now()
      if (previous !== null) {
        if (!(stamp > previous)) throw new Error(`stamp ${i} did not increase: ${previous} then ${stamp}`)
      }
      previous = stamp
    }
    // And the overflow ran logical time ahead of the frozen wall.
    expect(parseHlc(previous!).ms).toBeGreaterThan(1_000)
  })

  it('follows the wall clock forward and never follows it back', () => {
    let wall = 5_000
    const clock = createClock({ deviceId: DEV, now: () => wall })
    const first = clock.now()
    expect(parseHlc(first)).toMatchObject({ ms: 5_000, counter: 0 })
    wall = 6_000
    const second = clock.now()
    expect(parseHlc(second)).toMatchObject({ ms: 6_000, counter: 0 })
    wall = 4_000 // rewound — logical time must not rewind with it
    const third = clock.now()
    expect(third > second).toBe(true)
    expect(parseHlc(third)).toMatchObject({ ms: 6_000, counter: 1 })
  })

  it('refuses a bad device id, and the zero device', () => {
    expect(() => createClock({ deviceId: 'nope' })).toThrow(/not a device id/)
    expect(() => createClock({ deviceId: DEV.toUpperCase() })).toThrow(/not a device id/)
    expect(() => createClock({ deviceId: ZERO_DEVICE })).toThrow(/reserved/)
  })
})

describe('witness', () => {
  it('advances the floor, so later local stamps beat the remote', () => {
    const clock = createClock({ deviceId: DEV, now: () => 1_000 })
    const remote = makeHlc(2_000, 7, OTHER)
    clock.witness(remote)
    const next = clock.now()
    expect(next > remote).toBe(true)
    expect(parseHlc(next)).toMatchObject({ ms: 2_000, counter: 8 })
  })

  it('a remote clock 24 hours ahead is witnessed, and local stamps still beat it', () => {
    const wall = 1_700_000_000_000
    const clock = createClock({ deviceId: DEV, now: () => wall })
    const ahead = makeHlc(wall + 24 * 60 * 60 * 1000, 0, OTHER)
    clock.witness(ahead)
    let previous = ahead
    for (let i = 0; i < 100; i++) {
      const stamp = clock.now()
      expect(stamp > previous).toBe(true)
      previous = stamp
    }
    // Logical time is running on the remote's day-ahead wall, as it must.
    expect(parseHlc(previous).ms).toBe(wall + 24 * 60 * 60 * 1000)
  })

  it('ignores a remote at or behind the floor', () => {
    const clock = createClock({ deviceId: DEV, now: () => 5_000 })
    const issued = clock.now()
    clock.witness(makeHlc(1_000, 50, OTHER))
    expect(clock.last()).toBe(issued)
  })

  it('rejects a string that is not a stamp', () => {
    const clock = createClock({ deviceId: DEV })
    expect(() => clock.witness('tomorrow' as Hlc)).toThrow(/not a stamp/)
    expect(() => clock.witness(`${'0'.repeat(12)}_0000_${DEV}` as Hlc)).toThrow(/not a stamp/)
  })
})

describe('persistence — a restart cannot reissue', () => {
  it('saves the floor on every issue, before the stamp escapes', () => {
    const saved: Hlc[] = []
    const clock = createClock({ deviceId: DEV, now: () => 1_000, save: (last) => saved.push(last) })
    const a = clock.now()
    const b = clock.now()
    expect(saved).toEqual([a, b])
  })

  it('a clock restarted from load issues above everything the old one issued', () => {
    let persisted: Hlc | null = null
    const first = createClock({ deviceId: DEV, now: () => 9_000, save: (last) => void (persisted = last) })
    const issued: Hlc[] = []
    for (let i = 0; i < 100; i++) issued.push(first.now())

    // The restart: same device, a wall clock that REWOUND across the restart.
    const second = createClock({ deviceId: DEV, now: () => 1_000, load: () => persisted })
    const fresh = second.now()
    for (const old of issued) expect(fresh > old).toBe(true)
  })

  it('saves a witnessed floor too, so a restart cannot fall below the remote', () => {
    let persisted: Hlc | null = null
    const clock = createClock({ deviceId: DEV, now: () => 1_000, save: (last) => void (persisted = last) })
    const remote = makeHlc(50_000, 3, OTHER)
    clock.witness(remote)
    const restarted = createClock({ deviceId: DEV, now: () => 1_000, load: () => persisted })
    expect(restarted.now() > remote).toBe(true)
  })

  it('refuses a load that is not a stamp — fail loud, not below the floor', () => {
    expect(() => createClock({ deviceId: DEV, load: () => 'garbage' as Hlc })).toThrow(/not a stamp/)
  })

  it('refuses to witness a stamp implausibly far in the future — the floor is persisted, and a floor near HLC_MAX_MS is a clock bricked forever', () => {
    let persisted: Hlc | null = null
    const clock = createClock({ deviceId: DEV, now: () => 1_750_000_000_000, save: (last) => void (persisted = last) })
    const before = clock.last()
    expect(() => clock.witness(makeHlc(HLC_MAX_MS, 0, OTHER))).toThrow(/implausibly far/)
    // The floor did not move and nothing was persisted — the clock survives.
    expect(clock.last()).toBe(before)
    expect(persisted).toBeNull()
    // A drastically skewed but sub-century stamp still witnesses fine.
    const skewed = makeHlc(1_750_000_000_000 + 70 * 365 * 24 * 60 * 60 * 1000, 0, OTHER)
    clock.witness(skewed)
    expect(clock.now() > skewed).toBe(true)
  })
})

describe('order — lexicographic equals (ms, counter, device)', () => {
  it('as a fast-check property', () => {
    const part = fc.record({
      ms: fc.integer({ min: 0, max: 2 ** 44 }),
      counter: fc.integer({ min: 0, max: 0xffff }),
      device: fc.constantFrom(DEV, OTHER, ZERO_DEVICE, '0000000000000001'),
    })
    fc.assert(
      fc.property(part, part, (x, y) => {
        const numeric =
          x.ms !== y.ms
            ? Math.sign(x.ms - y.ms)
            : x.counter !== y.counter
              ? Math.sign(x.counter - y.counter)
              : x.device < y.device
                ? -1
                : x.device > y.device
                  ? 1
                  : 0
        return compareHlc(makeHlc(x.ms, x.counter, x.device), makeHlc(y.ms, y.counter, y.device)) === numeric
      }),
      { numRuns: 2_000 },
    )
  })
})

describe('the legacy stamp and the accessors', () => {
  it('hlcOf has counter zero and the zero device unless one is given', () => {
    expect(parseHlc(hlcOf(1234))).toEqual({ ms: 1234, counter: 0, device: ZERO_DEVICE })
    expect(deviceOf(hlcOf(1234, DEV))).toBe(DEV)
  })

  it('isHlc rejects the malformed', () => {
    for (const bad of ['', 'nope', `${'0'.repeat(12)}-0000-${DEV.toUpperCase()}`, `${'0'.repeat(11)}-0000-${DEV}`]) {
      expect(isHlc(bad)).toBe(false)
    }
    expect(isHlc(makeHlc(1, 1, DEV))).toBe(true)
  })
})

describe('ensureDeviceId', () => {
  const memory = () => {
    const map = new Map<string, string>()
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
  }

  it('mints 16 hex once and answers the same id forever after', () => {
    const settings = createSettingsStore({ storage: memory() })
    const first = ensureDeviceId(settings)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(first).not.toBe(ZERO_DEVICE)
    expect(ensureDeviceId(settings)).toBe(first)
  })

  it('survives the store round trip — the id is durable, not per-session', () => {
    const storage = memory()
    const first = ensureDeviceId(createSettingsStore({ storage }))
    const again = ensureDeviceId(createSettingsStore({ storage }))
    expect(again).toBe(first)
  })

  it('regenerates over a hand-edited value that is not an id', () => {
    const storage = memory()
    const settings = createSettingsStore({ storage })
    const first = ensureDeviceId(settings)
    storage.setItem('paper.settings.v1', JSON.stringify({ version: 1, values: { 'sync.deviceId': 'MY-MAC' } }))
    const fresh = ensureDeviceId(createSettingsStore({ storage }))
    expect(fresh).toMatch(/^[0-9a-f]{16}$/)
    expect(fresh).not.toBe('MY-MAC')
    expect(fresh).not.toBe(first)
  })
})
