import { describe, expect, it } from 'vitest'
import {
  COVER_WIDTH,
  downscaleCover,
  scaledTo,
  type ImageOps,
} from './coverArt'

/**
 * Covers, without a webview.
 *
 * `createImageBitmap` and `OffscreenCanvas` exist only in a browser, so they sit
 * behind `ImageOps` and everything above the decode is asserted here: whether a
 * cover is fetched at all, what a book with no jacket does, what a corrupt image
 * does, and that the bitmap is released. Whether a real JPEG comes out the far
 * side needs the app.
 */


/** Records what it was asked to do, and whether the bitmap was released. */
function fakeOps(over: { width?: number; height?: number; fail?: boolean } = {}) {
  const seen: { width: number; height: number }[] = []
  let closed = 0
  const ops: ImageOps = {
    decode: async (blob) => {
      if (over.fail) throw new Error('not an image')
      void blob
      return {
        width: over.width ?? 1600,
        height: over.height ?? 2400,
        close: () => {
          closed += 1
        },
      }
    },
    encode: async (_source, width, height) => {
      seen.push({ width, height })
      return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
    },
  }
  return { ops, seen, closed: () => closed }
}

const jacket = () => new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })


describe('scaledTo', () => {
  it('shrinks a publisher-sized jacket to shelf size, keeping the ratio', () => {
    expect(scaledTo(1600, 2400)).toEqual({ width: COVER_WIDTH, height: 600 })
  })

  /* A small cover blown up costs bytes and adds nothing — a 60px jacket should
   * stay 60px rather than become a 400px-wide blur. */
  it('never enlarges a jacket that is already small', () => {
    expect(scaledTo(60, 90)).toEqual({ width: 60, height: 90 })
  })

  it('never produces a zero dimension', () => {
    expect(scaledTo(1000, 1).height).toBeGreaterThanOrEqual(1)
  })
})

describe('downscaleCover', () => {
  it('encodes at the scaled size', async () => {
    const { ops, seen } = fakeOps({ width: 1600, height: 2400 })
    await downscaleCover(jacket(), ops)
    expect(seen).toEqual([{ width: COVER_WIDTH, height: 600 }])
  })

  /* `ImageBitmap` holds decoded pixels outside the JS heap and is not collected
   * on its own. Importing a folder without this leaks the whole library's
   * artwork. */
  it('releases the decoded bitmap', async () => {
    const { ops, closed } = fakeOps()
    await downscaleCover(jacket(), ops)
    expect(closed()).toBe(1)
  })

  /* A book with a corrupt cover is a book that opens fine and has no picture.
   * Failing the open over one would be the wrong trade by a wide margin. */
  it('returns null for an image that will not decode, rather than throwing', async () => {
    const { ops } = fakeOps({ fail: true })
    await expect(downscaleCover(jacket(), ops)).resolves.toBeNull()
  })
})

