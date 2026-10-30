import { describe, expect, it } from 'vitest'
import { UNDESCRIBABLE, messageOf } from './messageOf'

/**
 * The one reader of a rejection's text — see the module header for why it is in
 * the kernel and what three broken copies of it looked like.
 *
 * Every case below is an input that was reported in the wild or reproduced by
 * an audit, not a shape invented to make a branch run.
 */
describe('messageOf', () => {
  it('takes an Error at its word', () => {
    expect(messageOf(new Error('the disk is full'))).toBe('the disk is full')
  })

  it('reads the sentence off a plugin rejection', () => {
    /* THE INPUT THIS EXISTS FOR. `plugin:peer|peer_circle_mine` on a device with
       no circle role rejects with exactly this, and `String(cause)` on it is
       `[object Object]` — which reached both a reader and `diagnostics.jsonl`. */
    expect(messageOf({ kind: 'identity', message: 'this device has no circle role' })).toBe(
      'this device has no circle role',
    )
  })

  it('passes a string rejection through', () => {
    expect(messageOf('Command peer_circle_mine not found')).toBe('Command peer_circle_mine not found')
  })

  it('coerces a non-string primitive message rather than losing it', () => {
    /* Two hand-rolled copies this replaced read `String(x?.message ?? x)`, so a
       status code rendered as "503". Unifying them must not narrow that. */
    expect(messageOf({ message: 503 })).toBe('503')
    expect(messageOf({ message: false })).toBe('false')
  })

  it('does not return a non-string from an Error whose message is not one', () => {
    /* `Error.message` is TYPED string and is not one at runtime after this, so
       the Error branch is skipped and the primitive-message branch coerces it.
       The value survives AND the signature stays honest — returning the number
       itself is what the unguarded version did. */
    const lying = Object.assign(new Error('ignored'), { message: 42 })
    const answer = messageOf(lying)
    expect(answer).toBe('42')
    expect(typeof answer).toBe('string')
  })

  it('survives a message getter that throws', () => {
    /* A throw here would replace the error being reported with a second one and
       lose the first — inside a catch block, which is where this always runs. */
    const hostile = {
      get message(): string {
        throw new Error('nope')
      },
    }
    expect(messageOf(hostile)).toBe('[object Object]')
  })

  it('still asks the value itself when the getter throws but toString works', () => {
    /* ⚠️ ONE `try` AROUND THE WHOLE FUNCTION GOT THIS WRONG: the getter's throw
       jumped past `String(cause)`, so an object that could describe itself
       perfectly well was reported as undescribable. */
    const hostile = {
      get message(): string {
        throw new Error('nope')
      },
      toString: () => 'the original rejection',
    }
    expect(messageOf(hostile)).toBe('the original rejection')
  })

  it('reads the message once, so a changing getter cannot return a non-string', () => {
    /* A getter answering a string on the first read and a number on the second
       returned the NUMBER when the check and the return were two reads. */
    let reads = 0
    const shifty = {
      get message(): unknown {
        reads += 1
        return reads === 1 ? 'first answer' : 42
      },
    }
    const answer = messageOf(shifty)
    expect(answer).toBe('first answer')
    expect(typeof answer).toBe('string')
    expect(reads).toBe(1)
  })

  it('survives a value that cannot be stringified at all', () => {
    /* `Object.create(null)` has no `toString`, so `String(it)` throws. */
    expect(messageOf(Object.create(null) as unknown)).toBe(UNDESCRIBABLE)
  })

  it('describes the ordinary primitives it is handed', () => {
    expect(messageOf(undefined)).toBe('undefined')
    expect(messageOf(null)).toBe('null')
    expect(messageOf(7)).toBe('7')
  })

  it('falls back to the value when an object carries no message', () => {
    expect(messageOf({ kind: 'identity' })).toBe('[object Object]')
  })
})
