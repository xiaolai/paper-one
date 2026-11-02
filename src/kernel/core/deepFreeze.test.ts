import { describe, expect, it } from 'vitest'
import { deepFreeze } from './deepFreeze'

describe('deepFreeze', () => {
  it('freezes the value and everything it holds, in place', () => {
    const inner = { c: [1, { d: 2 }] }
    const value = { a: inner, b: [inner.c] }
    expect(deepFreeze(value)).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.a)).toBe(true)
    expect(Object.isFrozen(value.a.c)).toBe(true)
    expect(Object.isFrozen(value.a.c[1])).toBe(true)
    expect(Object.isFrozen(value.b)).toBe(true)
  })

  it('reaches a property that is not enumerable', () => {
    const hidden = { e: 1 }
    const value = Object.defineProperty({}, 'hidden', { value: hidden, enumerable: false })
    deepFreeze(value)
    expect(Object.isFrozen(hidden)).toBe(true)
  })

  it('hands a primitive back as it came, null among them', () => {
    for (const primitive of ['ab', '', 7, true, undefined, null]) expect(deepFreeze(primitive)).toBe(primitive)
  })

  it('walks past a null field rather than into it', () => {
    const value = { a: null, b: { c: null, d: 'text' } }
    expect(() => deepFreeze(value)).not.toThrow()
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.b)).toBe(true)
  })
})
