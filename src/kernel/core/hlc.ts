/**
 * The hybrid logical clock STAMP — the primitive every register in the
 * ledger is ordered by.
 *
 * ```
 * WWWWWWWWWWWW-CCCC-DDDDDDDDDDDDDDDD
 * └ 12 hex ms ┘ └4┘ └── 16 hex device ──┘
 * ```
 *
 * A fixed-width, lowercase-hex string, so that PLAIN STRING ORDER IS CAUSAL
 * ORDER: wall time first, then the counter that separates stamps issued in
 * one millisecond, then the device that issued it. Comparing two stamps is
 * `a < b`, in every language a peer might be written in, with no parsing.
 * The device id is IN the stamp, which is what makes a tie resolve the same
 * way on every replica — two stamps from two devices can never be equal, and
 * two from one device differ in the counter, so a stamp is a total order.
 *
 * WHY HERE AND NOT IN THE SYNC CAPABILITY. The kernel's own records carry
 * these — `positionAt`, `finishedAt`, `tagClock`, a mark's `updatedAt` — so
 * the kernel has to validate one on the way in (`parseRecord`) and mint one
 * on the way out (a note edit stamps `updatedAt`). The kernel imports nothing
 * from a capability, so the format lives here and the capability that keeps
 * a monotone clock (`createClock`, in `sync`) builds on these primitives
 * through the public entry. What is here is the STAMP: pure, stateless.
 *
 * The kernel's default clock is `hlcOf(Date.now())` under the ZERO device: a
 * legacy-shaped stamp, monotone only as far as the wall clock is, and enough
 * for a reader with no sync composed — the same edit twice in one millisecond
 * gets the same stamp, which is harmless when there is nobody to merge with.
 * The sync capability supplies a real clock (`witness`, counter, device id)
 * through the stores' `clock` option.
 */

declare const HLC: unique symbol
/** A stamp that has been checked. Only `hlcOf`, `parseHlc`'s callers and `asHlc` mint one. */
export type Hlc = string & { readonly [HLC]: true }

/** The device id every legacy-derived stamp carries: nobody's. */
export const ZERO_DEVICE = '0000000000000000'
/** Twelve hex digits of milliseconds: about the year 10889. */
export const HLC_MAX_MS = 0xffffffffffff
/** Four hex digits of counter. */
export const HLC_MAX_COUNTER = 0xffff

const SHAPE = /^[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{16}$/
const DEVICE_SHAPE = /^[0-9a-f]{16}$/

/** Whether `value` is a stamp — the shape check, lowercase only, fixed width. */
export function isHlc(value: unknown): value is Hlc {
  return typeof value === 'string' && SHAPE.test(value)
}

/** Whether `value` is a device id — sixteen lowercase hex digits. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_SHAPE.test(value)
}

/**
 * Trust a string that has already been checked. For the one place a caller
 * holds a validated string in a variable typed `string` — a test fixture, a
 * value read back off a store whose `parse` already ran `isHlc`. Throws
 * rather than lying when it is not one.
 */
export function asHlc(value: string): Hlc {
  if (!isHlc(value)) throw new Error(`not an HLC stamp: ${JSON.stringify(value)}`)
  return value
}

/** Build a stamp from its three parts. Bounds are checked, not clamped. */
export function makeHlc(ms: number, counter: number, deviceId: string): Hlc {
  if (!Number.isInteger(ms) || ms < 0 || ms > HLC_MAX_MS) throw new RangeError(`HLC: ms out of range: ${ms}`)
  if (!Number.isInteger(counter) || counter < 0 || counter > HLC_MAX_COUNTER) {
    throw new RangeError(`HLC: counter out of range: ${counter}`)
  }
  if (!isDeviceId(deviceId)) throw new RangeError(`HLC: not a device id: ${JSON.stringify(deviceId)}`)
  return `${ms.toString(16).padStart(12, '0')}-${counter.toString(16).padStart(4, '0')}-${deviceId}` as Hlc
}

/**
 * The stamp for a legacy time — an `addedAt`, a `createdAt`, a `Date.now()`
 * — with counter zero and, unless a device is given, the zero device.
 *
 * Every replica derives the SAME stamp for the same legacy field, which is
 * what lets two copies of a phase-4 record agree on what "before the ledger"
 * means without exchanging anything. A time that is not a finite number is
 * treated as the epoch: a record with no `addedAt` is older than everything.
 */
export function hlcOf(ms: number | undefined | null, deviceId: string = ZERO_DEVICE): Hlc {
  const wall = typeof ms === 'number' && Number.isFinite(ms) ? Math.min(HLC_MAX_MS, Math.max(0, Math.floor(ms))) : 0
  return makeHlc(wall, 0, deviceId)
}

/** The three parts of a stamp. Throws on a string that is not one. */
export function parseHlc(stamp: string): { readonly ms: number; readonly counter: number; readonly device: string } {
  if (!isHlc(stamp)) throw new Error(`not an HLC stamp: ${JSON.stringify(stamp)}`)
  return {
    ms: Number.parseInt(stamp.slice(0, 12), 16),
    counter: Number.parseInt(stamp.slice(13, 17), 16),
    device: stamp.slice(18),
  }
}

/** The device that issued a stamp. */
export function deviceOf(stamp: Hlc): string {
  return stamp.slice(18)
}

/**
 * Causal order — which, by construction, is string order. Stated as a
 * function so nobody has to remember that, and so a sort has something to
 * be handed.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The later of two stamps; `undefined` loses to anything. */
export function laterHlc(a: Hlc | undefined, b: Hlc | undefined): Hlc | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a < b ? b : a
}
