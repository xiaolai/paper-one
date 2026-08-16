import { describe, expect, it, vi } from 'vitest'
import { lookupMetadata } from './metadataLookup'

/**
 * The lookup, without the network.
 *
 * `fetch` is injected, so every case here is about what Paper SENDS and what it
 * accepts back — which is the part that matters for a feature whose whole design
 * constraint is that it is the only thing in the library that leaves the machine.
 */

const ok = (body: unknown) =>
  vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

describe('lookupMetadata', () => {
  it('asks for one result and only the fields it uses', async () => {
    const fetchImpl = ok({ docs: [{ title: 'Moby-Dick' }] })
    await lookupMetadata({ title: 'Moby-Dick' }, fetchImpl)
    const url = new URL((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!)
    expect(url.origin).toBe('https://openlibrary.org')
    expect(url.searchParams.get('limit')).toBe('1')
    expect(url.searchParams.get('fields')).toContain('author_name')
  })

  it('sends the title and author it was given, and nothing else', async () => {
    const fetchImpl = ok({ docs: [{ title: 'x' }] })
    await lookupMetadata({ title: 'Moby-Dick', author: 'Melville' }, fetchImpl)
    const url = new URL((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]!)
    expect(url.searchParams.get('q')).toBe('Moby-Dick Melville')
  })

  it('reads back the fields it can use', async () => {
    const fetchImpl = ok({
      docs: [
        {
          title: 'Moby-Dick',
          author_name: ['Herman Melville'],
          publisher: ['Penguin', 'Other'],
          first_publish_year: 1851,
          subject: ['Whaling', 'Sea stories'],
        },
      ],
    })
    await expect(lookupMetadata({ title: 'Moby' }, fetchImpl)).resolves.toEqual({
      title: 'Moby-Dick',
      author: 'Herman Melville',
      publisher: 'Penguin',
      published: '1851',
      subjects: ['Whaling', 'Sea stories'],
      source: 'Open Library',
    })
  })

  /**
   * Nothing matched, the network failed, and the response was the wrong shape
   * are ONE outcome from the reader's side: no suggestion. Distinguishing them
   * in the interface would be noise about somebody else's server.
   */
  it('returns null for every kind of failure', async () => {
    const empty = ok({ docs: [] })
    await expect(lookupMetadata({ title: 'x' }, empty)).resolves.toBeNull()

    const notOk = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    await expect(lookupMetadata({ title: 'x' }, notOk)).resolves.toBeNull()

    const threw = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(lookupMetadata({ title: 'x' }, threw)).resolves.toBeNull()

    const nonsense = ok({ not: 'what we expected' })
    await expect(lookupMetadata({ title: 'x' }, nonsense)).resolves.toBeNull()
  })

  /* A result carrying nothing but a provenance line is not a result. */
  it('returns null when the match has neither a title nor an author', async () => {
    await expect(lookupMetadata({ title: 'x' }, ok({ docs: [{ publisher: ['P'] }] }))).resolves.toBeNull()
  })

  /* Never called without something to ask about — an empty query would fetch
   * the whole catalogue's first page for nothing. */
  it('makes no request at all for an empty title', async () => {
    const fetchImpl = ok({ docs: [] })
    await expect(lookupMetadata({ title: '   ' }, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /* Somebody else's server is untrusted input like any other. */
  it('caps a hostile response rather than storing it', async () => {
    const huge = 'x'.repeat(50_000)
    const many = Array.from({ length: 500 }, (_, i) => `s${i}`)
    const result = await lookupMetadata(
      { title: 'x' },
      ok({ docs: [{ title: huge, subject: many }] }),
    )
    expect(result?.title).toHaveLength(500)
    expect(result?.subjects).toHaveLength(12)
  })
})
