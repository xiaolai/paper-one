import { describe, expect, it, vi } from 'vitest'
import { hitOf, searchPassages, type PassageChannel } from './passages'

/**
 * Searching the whole shelf from a browser.
 *
 * ⚠️ **A DIFFERENT WIRE FROM THE APP'S, AND THAT IS WHY THE CHECKING IS HERE
 * TOO.** `capabilities/passages/lib/rows.ts` reads what the PLUGIN answers over
 * Tauri, in the app; this reads what a SHELF answers over a WebSocket, to a
 * browser. The only thing they share is the shape's name.
 */

const ROW = {
  bookId: 'book:a',
  sectionIndex: 3,
  offset: 17,
  quote: 'the whale',
  prefix: 'before ',
  suffix: ' after',
  score: 1.5,
}

function channelOf(pages: readonly unknown[]): PassageChannel {
  return {
    stream: (_service, _body) =>
      (async function* () {
        for (const page of pages) yield page
      })(),
  }
}

describe('reading one hit off the wire', () => {
  it('reads a well-formed row', () => {
    expect(hitOf(ROW)).toEqual(ROW)
  })

  it('refuses a hit with no quote, which draws an empty row that goes nowhere', () => {
    expect(hitOf({ ...ROW, quote: '' })).toBeNull()
    expect(hitOf({ ...ROW, quote: 7 })).toBeNull()
  })

  it('refuses a section or offset that is not a whole count', () => {
    /* `"3"` lands the reader in no chapter at all. */
    for (const bad of ['3', -1, 1.5, null, undefined]) {
      expect(hitOf({ ...ROW, sectionIndex: bad }), String(bad)).toBeNull()
      expect(hitOf({ ...ROW, offset: bad }), String(bad)).toBeNull()
    }
  })

  it('allows an empty prefix or suffix and a zero offset', () => {
    expect(hitOf({ ...ROW, prefix: '', suffix: '', offset: 0 })).not.toBeNull()
  })

  it('refuses anything that is not a row', () => {
    for (const bad of [null, undefined, 'a hit', 7, []]) {
      expect(hitOf(bad), String(bad)).toBeNull()
    }
    expect(hitOf({ ...ROW, bookId: '' })).toBeNull()
    expect(hitOf({ ...ROW, score: 'high' })).toBeNull()
  })
})

describe('searching over the envelope', () => {
  it('asks the shelf and reads what comes back', async () => {
    const stream = vi.fn((_service: string, _body: unknown) =>
      (async function* () {
        yield [ROW]
      })(),
    )
    const found = await searchPassages({ stream })('whale')
    expect(found).toEqual([ROW])
    expect(stream).toHaveBeenCalledWith('passage.search', { query: 'whale' })
  })

  it('asks as a STREAM, which is what the row declares', async () => {
    /* `books.ts` records what asking the wrong question costs: *"the shelf was
     * answering correctly the whole time and saying no; the client was asking
     * the wrong question"*. This file has no `call` to reach for. */
    const channel = channelOf([[ROW]])
    expect(Object.keys(channel)).toEqual(['stream'])
    await expect(searchPassages(channel)('whale')).resolves.toHaveLength(1)
  })

  it('carries a limit when it is given and omits it when it is not', async () => {
    const stream = vi.fn((_s: string, _b: unknown) => (async function* () {})())
    await searchPassages({ stream })('whale', 25)
    expect(stream).toHaveBeenCalledWith('passage.search', { query: 'whale', limit: 25 })
    await searchPassages({ stream })('whale')
    expect(stream).toHaveBeenLastCalledWith('passage.search', { query: 'whale' })
  })

  it('reads a page that arrives as one row and one that arrives as many', async () => {
    const both = await searchPassages(channelOf([ROW, [ROW, { ...ROW, sectionIndex: 4 }]]))('whale')
    expect(both.map((one) => one.sectionIndex)).toEqual([3, 3, 4])
  })

  it('drops one bad row alone and keeps the rest', async () => {
    const found = await searchPassages(channelOf([[ROW, { ...ROW, quote: '' }, { ...ROW, sectionIndex: 9 }]]))(
      'whale',
    )
    expect(found.map((one) => one.sectionIndex)).toEqual([3, 9])
  })

  it('answers an empty query here rather than sending it', async () => {
    /* The panel asks on every keystroke and is simply between questions; the
     * shelf refuses an empty query BY NAME, which is right for a caller that
     * meant something and wrong for a debounce. */
    const stream = vi.fn((_s: string, _b: unknown) => (async function* () {})())
    expect(await searchPassages({ stream })('')).toEqual([])
    expect(await searchPassages({ stream })('   ')).toEqual([])
    expect(stream).not.toHaveBeenCalled()
  })

  it('RE-THROWS a refusal rather than answering no matches', async () => {
    /* ⚠️ **THE PANEL TELLS A QUERY THE READER CAN FIX FROM AN INDEX THAT WILL
     * NOT OPEN, AND IT CAN ONLY DO THAT IF THE REFUSAL REACHES IT.** Caught
     * here and answered as an empty list, every refused query would read as
     * *"nothing in your library says that"*. */
    const refusal = { code: 'malformed', message: 'unbalanced quotation mark' }
    const channel: PassageChannel = {
      stream: () =>
        (async function* () {
          throw refusal
        })(),
    }
    await expect(searchPassages(channel)('"the whale')).rejects.toBe(refusal)
  })

  it('answers an empty list when the shelf found nothing, which is a real answer', async () => {
    await expect(searchPassages(channelOf([]))('unicorn')).resolves.toEqual([])
  })
})
