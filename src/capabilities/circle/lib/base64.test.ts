import { describe, expect, it } from 'vitest'
import { base64Of, bytesOfBase64 } from './base64'

describe('base64 over bytes — WI-23.C5', () => {
  it('round-trips bytes of every value, in one chunk and across the chunk seam', () => {
    const small = new Uint8Array(256).map((_, i) => i)
    expect(bytesOfBase64(base64Of(small))).toEqual(small)
    const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => (i * 31) % 256)
    expect(bytesOfBase64(base64Of(big))).toEqual(big)
    expect(base64Of(new Uint8Array(0))).toBe('')
    expect(bytesOfBase64('')).toEqual(new Uint8Array(0))
  })

  it('refuses text that is not base64 rather than letting atob throw on it', () => {
    for (const bad of ['abc', 'ab=c', '####', 'YWJj!', 'YW Jj']) expect(bytesOfBase64(bad), bad).toBeNull()
    expect(bytesOfBase64('YWJj')).toEqual(new TextEncoder().encode('abc'))
    expect(bytesOfBase64('YWI=')).toEqual(new TextEncoder().encode('ab'))
  })
})
