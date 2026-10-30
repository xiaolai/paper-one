import { describe, expect, it, vi } from 'vitest'
import { fakeFs } from '../../testkit'
import { createKernelServices } from '../services'
import type { PassageHit, PassageIndexStatus, PassagesPort } from '../ports'
import { handlerFor } from './handlers'
import { serviceDescriptor } from '../serviceTable'
import { isRefusal } from './refusals'

/**
 * `passage.search` — the text inside every indexed book.
 *
 * The two refusals are the subject. Both are ones this repository has fixed
 * elsewhere and both are easy to spell as an empty answer:
 *
 *  - **no index is `unsupported`, not no hits.** An empty stream says *"nothing
 *    in your library says that"*, which is a wrong answer rather than a missing
 *    one.
 *  - **a query the index cannot ask is `malformed`, not no hits.** Reported as
 *    an empty result, a reader retypes a query that can never work.
 */

const HIT: PassageHit = {
  bookId: 'book:a',
  sectionIndex: 3,
  offset: 17,
  quote: 'the whale',
  prefix: 'and then we saw ',
  suffix: ' rise beside the boat',
  score: 1.5,
}

const STATUS: PassageIndexStatus = {
  books: 1,
  sections: 3,
  chars: 100,
  indexBytes: 10,
  textBytes: 20,
  analysis: 'paper/1',
  unreadable: [],
}

function shelf(port?: PassagesPort) {
  const services = createKernelServices({ fs: fakeFs({}), storage: null, initialBooks: [] })
  if (port) services.bindPassages(port)
  const descriptor = serviceDescriptor('passage.search')
  if (!descriptor) throw new Error('passage.search is not in the table')
  const handler = handlerFor(descriptor, { services })
  return async (body: unknown): Promise<unknown[]> => {
    const answer = handler(body, { signal: undefined } as never)
    const rows: unknown[] = []
    for await (const page of answer as AsyncIterable<unknown>) rows.push(...(page as unknown[]))
    return rows
  }
}

const refusalOf = async (run: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
  run.then(
    () => ({}),
    (cause: unknown) => (isRefusal(cause) ? cause : { message: String(cause) }),
  )

describe('answering', () => {
  it('streams the hits the index found', async () => {
    const ask = shelf({ search: async () => [HIT], status: async () => STATUS })
    await expect(ask({ query: 'whale' })).resolves.toEqual([HIT])
  })

  it('answers nothing at all when the index found nothing', async () => {
    /* One frame or none — an empty answer is an empty STREAM, not a frame
     * holding an empty list, which a caller counting frames would read as a
     * page of results. */
    const ask = shelf({ search: async () => [], status: async () => STATUS })
    await expect(ask({ query: 'whale' })).resolves.toEqual([])
  })

  it('passes the limit through', async () => {
    const search = vi.fn(async () => [HIT])
    const ask = shelf({ search, status: async () => STATUS })
    await ask({ query: 'whale', limit: 5 })
    expect(search).toHaveBeenCalledWith('whale', 5)
  })

  it('passes no limit when none was asked for', async () => {
    const search = vi.fn(async () => [HIT])
    const ask = shelf({ search, status: async () => STATUS })
    await ask({ query: 'whale' })
    expect(search).toHaveBeenCalledWith('whale', undefined)
  })
})

describe('refusing', () => {
  it('refuses by name on a host with no index, rather than answering no hits', async () => {
    /* ⚠️ **`openNodeServices` COMPOSES NO CAPABILITIES**, so this is what the
     * local CLI gets — and the sentence has to say where the index lives rather
     * than implying the library holds nothing. */
    const refused = await refusalOf(shelf()({ query: 'whale' }))
    expect(refused.code).toBe('unsupported')
    expect(refused.message).toMatch(/no passage index/u)
    expect(refused.message).toMatch(/shelf that built one/u)
  })

  it('refuses a query the index cannot ask as malformed', async () => {
    /* The plugin answers `badQuery`; the handler turns exactly that into
     * `malformed`, which is the code a caller reads as "yours to fix". */
    const ask = shelf({
      search: async () => {
        throw { kind: 'badQuery', message: 'that is a single character' }
      },
      status: async () => STATUS,
    })
    const refused = await refusalOf(ask({ query: '树' }))
    expect(refused.code).toBe('malformed')
    expect(refused.message).toBe('that is a single character')
  })

  it('does NOT dress an index failure as a bad query', async () => {
    /* ⚠️ Told their question was malformed, a reader retypes a perfectly good
     * one for ever. Everything that is not `badQuery` is re-thrown, and the
     * envelope reports it as `internal`. */
    const ask = shelf({
      search: async () => {
        throw new Error('the index will not open')
      },
      status: async () => STATUS,
    })
    const refused = await refusalOf(ask({ query: 'whale' }))
    expect(refused.code).toBeUndefined()
    expect(refused.message).toMatch(/will not open/u)
  })

  it('refuses an empty query as malformed, from the schema', async () => {
    const ask = shelf({ search: async () => [HIT], status: async () => STATUS })
    const refused = await refusalOf(ask({ query: '' }))
    expect(refused.code).toBe('malformed')
  })

  it('refuses a missing query before it asks the index', async () => {
    const search = vi.fn(async () => [HIT])
    const refused = await refusalOf(shelf({ search, status: async () => STATUS })({}))
    expect(refused.code).toBe('malformed')
    expect(search).not.toHaveBeenCalled()
  })

  it('checks the schema before it checks for an index', async () => {
    /* A malformed body on a host with no index is a malformed body: the
     * caller's own mistake outranks a fact about the host, because it is the
     * one they can act on. */
    const refused = await refusalOf(shelf()({ query: '' }))
    expect(refused.code).toBe('malformed')
  })
})
