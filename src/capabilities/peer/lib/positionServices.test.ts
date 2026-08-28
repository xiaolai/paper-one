import { describe, expect, it } from 'vitest'
import { grantCovers } from '../../../kernel'
import { FORBIDDEN, refusalCode, seedBook, serveTable } from './serviceTable.testkit'

/**
 * `book.position` — the one write a browser is granted (WI-20.30, D7).
 *
 * A phone's reading position never reached the shelf: the browser client
 * holds `readingGrant` and every write in the table is refused, so the
 * position lived in `localStorage` and did not sync. `book.set` could carry
 * it, but `book.set` is `book:write` — finished, progress, and every other
 * field of the record — and widening the browser to that is widening it to
 * everything a hostile book's script could reach through the cookie.
 *
 * So the position has its own row under its own grant family, `position`,
 * which covers NOTHING ELSE: `book:*` does not include it, and it does not
 * include `book.set`. The pump binds it further, to the book the client
 * opened; that half is `pump.test.ts`.
 */

const CFI = 'epubcfi(/6/24!/4/2/1:0)'

describe('book.position', () => {
  it('records where the reader is, stamps it, and says so', async () => {
    const shelf = serveTable({ books: [seedBook('one')], grants: ['position:write', 'book:read'] })
    const answer = (await shelf.client.call('book.position', { book: 'one', position: CFI, progress: 0.4 })) as Record<
      string,
      unknown
    >
    expect(answer).toMatchObject({ bookId: 'one', position: CFI, progress: 0.4 })
    expect(typeof answer['positionAt']).toBe('string')
    /* AND THE RECORD CARRIES IT — `book.get` is what the next device reads. */
    const detail = (await shelf.client.call('book.get', { book: 'one' })) as Record<string, unknown>
    expect(detail['position']).toBe(CFI)
    expect(detail['progress']).toBe(0.4)
    expect(detail['positionAt']).toBe(answer['positionAt'])
  })

  it('keeps the progress the record already had when none is given', async () => {
    const shelf = serveTable({ books: [seedBook('one', { progress: 0.7 })], grants: ['position:write', 'book:read'] })
    await shelf.client.call('book.position', { book: 'one', position: CFI })
    const detail = (await shelf.client.call('book.get', { book: 'one' })) as Record<string, unknown>
    expect(detail['position']).toBe(CFI)
    expect(detail['progress']).toBe(0.7)
  })

  it('refuses an empty position — clearing one is a different act', async () => {
    const shelf = serveTable({ books: [seedBook('one')], grants: ['position:*'] })
    expect(refusalCode(await shelf.client.call('book.position', { book: 'one', position: '' }).catch((e: unknown) => e))).toBe(
      'malformed',
    )
  })

  it('refuses a progress outside [0, 1], and a book the shelf does not hold', async () => {
    const shelf = serveTable({ books: [seedBook('one')], grants: ['position:*'] })
    expect(
      refusalCode(await shelf.client.call('book.position', { book: 'one', position: CFI, progress: 2 }).catch((e: unknown) => e)),
    ).toBe('malformed')
    expect(refusalCode(await shelf.client.call('book.position', { book: 'nobody', position: CFI }).catch((e: unknown) => e))).toBe(
      'not-found',
    )
  })

  it('is under its own grant family, which book:* does not cover', async () => {
    const shelf = serveTable({ books: [seedBook('one')], grants: ['book:*'] })
    expect(refusalCode(await shelf.client.call('book.position', { book: 'one', position: CFI }).catch((e: unknown) => e))).toBe(
      FORBIDDEN,
    )
    expect(shelf.ran).not.toContain('book.position')
    expect(grantCovers(['book:*'], 'position:write')).toBe(false)
  })

  it('covers nothing else: position:write does not reach book.set, nor a read', async () => {
    const shelf = serveTable({ books: [seedBook('one')], grants: ['position:write'] })
    expect(refusalCode(await shelf.client.call('book.set', { book: 'one', position: CFI }).catch((e: unknown) => e))).toBe(
      FORBIDDEN,
    )
    expect(refusalCode(await shelf.client.call('book.get', { book: 'one' }).catch((e: unknown) => e))).toBe(FORBIDDEN)
    expect(shelf.ran).toEqual([])
  })
})
