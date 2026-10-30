/**
 * The sync capability's HYBRID LOGICAL CLOCK — the stateful half of the
 * stamp.
 *
 * The stamp itself (format, parsing, comparison, the legacy `hlcOf`) is a
 * kernel primitive: the kernel's own records carry stamps, so `hlc.ts` lives
 * in `kernel/core` and is re-exported here for the capability's own modules,
 * which import the kernel only through its public entry. What THIS module
 * adds is the clock — the one piece with state: issue a stamp that is
 * strictly above every stamp this device has ever issued OR witnessed, and
 * persist that floor so a restart cannot reissue.
 *
 * The rules, stated once:
 *
 *   wall ahead of the floor    → (wall, 0)
 *   wall at or behind it       → (floor.ms, floor.counter + 1)
 *   counter overflow           → (floor.ms + 1, 0)  — logical time runs
 *                                 ahead of a stuck or rewound wall clock
 *   witness(remote)            → the floor rises to the remote's (ms, counter)
 *                                 when that is ahead, so the next local stamp
 *                                 beats everything the remote has said
 *
 * `save` is called on every advance — each issue and each witnessing that
 * moved the floor — BEFORE the stamp is returned, so a crash after a caller
 * has seen a stamp cannot lead to that stamp being issued again. The floor
 * is persisted as a stamp under the local device; only its (ms, counter) is
 * read back.
 */

import {
  HLC_MAX_COUNTER,
  HLC_MAX_MS,
  ZERO_DEVICE,
  defineSetting,
  isDeviceId,
  isHlc,
  makeHlc,
  parseHlc,
  type Hlc,
  type Setting,
  type SettingsStore,
} from '../../../kernel'

/* The stamp's own vocabulary, re-exported so everything under `sync/lib`
 * has one import for the clock and the stamp both. */
export {
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
} from '../../../kernel'
export type { Hlc } from '../../../kernel'

export interface ClockOptions {
  /** This device's id: 16 hex digits, never the zero device (that spelling
   *  is reserved for legacy stamps — see `hlcOf`). */
  readonly deviceId: string
  /** The wall clock, injectable for tests. Milliseconds. */
  readonly now?: () => number
  /** The floor persisted by a previous run, or null on first start. */
  readonly load?: () => Hlc | null
  /** Persist the floor. Called on every advance, before the stamp escapes. */
  readonly save?: (last: Hlc) => void
}

export interface Clock {
  /** Issue a stamp strictly above everything issued or witnessed. */
  now(): Hlc
  /** Raise the floor to a remote stamp, so later local stamps beat it. */
  witness(remote: Hlc): void
  /** The current floor, as a stamp under this device. For tests and debug. */
  last(): Hlc
}

export function createClock({ deviceId, now = Date.now, load, save }: ClockOptions): Clock {
  if (!isDeviceId(deviceId)) throw new Error(`createClock: not a device id: ${JSON.stringify(deviceId)}`)
  if (deviceId === ZERO_DEVICE) throw new Error('createClock: the zero device is reserved for legacy stamps')

  /* The floor: the (ms, counter) of the last stamp issued or witnessed. */
  let ms = 0
  let counter = -1 // so the first stamp at ms 0 is (0, 0), not (0, 1)
  const loaded = load?.()
  if (loaded != null) {
    if (!isHlc(loaded)) throw new Error(`createClock: load returned something that is not a stamp: ${JSON.stringify(loaded)}`)
    const held = parseHlc(loaded)
    ms = held.ms
    counter = held.counter
  }

  /* How far ahead of this device's wall a witnessed stamp may reach.
   * GENEROUS on purpose: a device whose wall reset to 1970 must still
   * witness honest present-day stamps (~half a century "ahead" of it), so
   * the bound is a century — but bounded it must be, because witnessing a
   * stamp near `HLC_MAX_MS` (year ~10889) raises the PERSISTED floor so
   * high that `makeHlc` overflows once the counter steps past a stuck
   * wall: a clock bricked forever, saved to disk. Refusing fails the one
   * session, loudly, and keeps the clock. */
  const MAX_WITNESS_AHEAD_MS = 100 * 365 * 24 * 60 * 60 * 1000

  const stamp = () => makeHlc(ms, counter, deviceId)

  const advance = (): Hlc => {
    const issued = stamp()
    save?.(issued)
    return issued
  }

  return {
    now: () => {
      const wall = Math.min(HLC_MAX_MS, Math.max(0, Math.floor(now())))
      if (wall > ms) {
        ms = wall
        counter = 0
      } else if (counter >= HLC_MAX_COUNTER) {
        /* 65 536 stamps inside one wall millisecond, or a wall clock stuck or
         * rewound: logical time steps past it. The wall catching up later
         * simply takes over again. */
        ms += 1
        counter = 0
      } else {
        counter += 1
      }
      return advance()
    },
    witness: (remote) => {
      if (!isHlc(remote)) throw new Error(`witness: not a stamp: ${JSON.stringify(remote)}`)
      const theirs = parseHlc(remote)
      if (theirs.ms > Math.max(0, Math.floor(now())) + MAX_WITNESS_AHEAD_MS) {
        throw new Error(`witness: stamp implausibly far in the future: ${JSON.stringify(remote)}`)
      }
      if (theirs.ms < ms || (theirs.ms === ms && theirs.counter <= counter)) return
      ms = theirs.ms
      counter = theirs.counter
      void advance()
    },
    last: () => makeHlc(ms, Math.max(0, counter), deviceId),
  }
}

/* ------------------------------------------------------------------------ */
/* The device id                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Where this device's id lives: the kernel's typed settings store, under the
 * capability's own prefix. The fallback is the empty string — "not yet
 * generated" — and `parse` refuses anything that is not 16 hex, so a
 * hand-edited value falls back to regeneration rather than into stamps.
 */
export const DEVICE_ID_SETTING: Setting<string> = defineSetting('sync.deviceId', '', (raw) =>
  isDeviceId(raw) ? raw : undefined,
)

/**
 * This device's id, GENERATED ONCE: read it, or mint 16 random hex via
 * `crypto.getRandomValues` and persist it. Random rather than derived,
 * because the id's one job is to be unequal to every other device's — and it
 * must never be the zero device, whose spelling means "no device" (`hlcOf`).
 */
export function ensureDeviceId(settings: SettingsStore): string {
  const held = settings.get(DEVICE_ID_SETTING)
  if (held !== '') return held
  let id = ZERO_DEVICE
  while (id === ZERO_DEVICE) {
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  settings.set(DEVICE_ID_SETTING, id)
  return id
}
