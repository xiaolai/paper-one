import { describe, expect, it, vi } from 'vitest'
import { passageIndexOver } from './port'
import type { PassagesWire } from './wire'

/**
 * The port over a FAKE wire — the whole of it testable with no Tauri host,
 * which is the shape `peer/lib/port.ts` and `voices/lib/port.ts` both use and
 * the reason the peer port's refusal-classifying defect could be measured at
 * all.
 */

const HIT = {
  bookId: 'book:a',
  section: 3,
  offset: 17,
  quote: 'the whale',
  prefix: 'before ',
  suffix: ' after',
  score: 1.5,
}

const STATUS = {
  books: 1,
  sections: 3,
  chars: 100,
  indexBytes: 10,
  textBytes: 20,
  analysis: 'paper/1',
  unreadable: [],
}

function fakeWire(over: Partial<PassagesWire> = {}): PassagesWire {
  return {
    put: vi.fn(async () => true),
    note: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    rekey: vi.fn(async () => true),
    pending: vi.fn(async () => []),
    indexed: vi.fn(async () => []),
    rebuild: vi.fn(async () => {}),
    retry: vi.fn(async () => 0),
    status: vi.fn(async () => STATUS),
    search: vi.fn(async () => [HIT]),
    ...over,
  }
}

describe('searching', () => {
  it('reads the plugin’s rows into the kernel’s shape', async () => {
    const found = await passageIndexOver(fakeWire()).search('whale')
    expect(found).toEqual([
      {
        bookId: 'book:a',
        sectionIndex: 3,
        offset: 17,
        quote: 'the whale',
        prefix: 'before ',
        suffix: ' after',
        score: 1.5,
      },
    ])
  })

  it('answers an empty query here rather than sending it', async () => {
    /* ⚠️ **THE PANE ASKS ON EVERY KEYSTROKE AND IS SIMPLY BETWEEN QUESTIONS.**
     * The plugin refuses an empty query by name — *"there is no word in that
     * query to look for"* — which is right for a caller that meant something
     * and wrong for a debounce. */
    const wire = fakeWire()
    const port = passageIndexOver(wire)
    expect(await port.search('')).toEqual([])
    expect(await port.search('   ')).toEqual([])
    expect(wire.search).not.toHaveBeenCalled()
    await port.search('whale')
    expect(wire.search).toHaveBeenCalledTimes(1)
  })

  it('passes a limit through, and a null when there is none', async () => {
    const wire = fakeWire()
    const port = passageIndexOver(wire)
    await port.search('whale', 5)
    expect(wire.search).toHaveBeenCalledWith('whale', 5)
    await port.search('whale')
    expect(wire.search).toHaveBeenLastCalledWith('whale', null)
  })

  it('refuses a reply that is not a list rather than reading it as no matches', async () => {
    const port = passageIndexOver(fakeWire({ search: async () => ({ hits: [] }) }))
    await expect(port.search('whale')).rejects.toThrow(/not a list of passages/u)
  })
})

describe('the status', () => {
  it('reads it', async () => {
    await expect(passageIndexOver(fakeWire()).status()).resolves.toMatchObject({ books: 1 })
  })

  it('refuses a malformed one rather than answering zeroes', async () => {
    const port = passageIndexOver(fakeWire({ status: async () => null }))
    await expect(port.status()).rejects.toThrow(/not a status/u)
  })
})

describe('building the index', () => {
  it('passes a book’s sections through whole', async () => {
    const wire = fakeWire()
    await passageIndexOver(wire).put('book:a', 'gen1', [{ index: 0, text: 'x' }], 7)
    expect(wire.put).toHaveBeenCalledWith('book:a', 'gen1', [{ index: 0, text: 'x' }], 7)
  })

  it('reports a refused put, which is the removal race', async () => {
    /* A serial index writer does not serialise VAULT changes: the front end can
     * spend a second extracting a book that is evicted while it works. The
     * plugin refuses it, and the sweep must be able to tell that from success. */
    const port = passageIndexOver(fakeWire({ put: async () => false }))
    await expect(port.put('book:a', 'gen1', [], 7)).resolves.toBe(false)
  })

  it('asks nothing when nothing is pending', async () => {
    /* The backfill asks this every time it wakes, and a shelf whose books are
     * all current asks it with an empty list for ever after. */
    const wire = fakeWire()
    expect(await passageIndexOver(wire).pending([])).toEqual([])
    expect(wire.pending).not.toHaveBeenCalled()
  })

  it('reads the pending list when there is something to ask about', async () => {
    const wire = fakeWire({ pending: vi.fn(async () => ['book:a']) })
    const found = await passageIndexOver(wire).pending([['book:a', 'gen1']])
    expect(found).toEqual(['book:a'])
    expect(wire.pending).toHaveBeenCalledWith([['book:a', 'gen1']])
  })

  it('reads what the index holds, for the removal diff', async () => {
    const wire = fakeWire({ indexed: async () => ['book:a', 'book:b'] })
    await expect(passageIndexOver(wire).indexed()).resolves.toEqual(['book:a', 'book:b'])
  })

  it('refuses a malformed indexed list rather than forgetting every book', async () => {
    /* Read as `[]`, the sweep's diff would conclude the index holds nothing and
     * forget nothing — which is the harmless direction. Read as a list of
     * rubbish it would forget books by names that are not book ids. Refusing is
     * the only answer that is right in both directions. */
    const port = passageIndexOver(fakeWire({ indexed: async () => 'book:a' }))
    await expect(port.indexed()).rejects.toThrow(/not a list of book ids/u)
  })

  it('reads the count of books it cleared, and refuses a reply that is not one', async () => {
    /* `NaN books` is a shape this repository has shipped once already — a count
     * of received bytes through a formatter that refuses zero. */
    await expect(passageIndexOver(fakeWire({ retry: async () => 3 })).retry()).resolves.toBe(3)
    for (const bad of [null, undefined, -1, 1.5, 'three']) {
      await expect(
        passageIndexOver(fakeWire({ retry: async () => bad })).retry(),
        String(bad),
      ).resolves.toBe(0)
    }
  })

  it('forwards the rest of the write half unchanged', async () => {
    const wire = fakeWire()
    const port = passageIndexOver(wire)
    await port.note('book:a', 'no text', 7)
    await port.flush()
    await port.forget('book:a', 7)
    await port.rebuild()
    expect(wire.note).toHaveBeenCalledWith('book:a', 'no text', 7)
    expect(wire.flush).toHaveBeenCalledTimes(1)
    expect(wire.forget).toHaveBeenCalledWith('book:a', 7)
    expect(wire.rebuild).toHaveBeenCalledTimes(1)
  })

  it('keeps the rekey’s direction', async () => {
    const wire = fakeWire()
    await passageIndexOver(wire).rekey('book:old', 'book:new')
    expect(wire.rekey).toHaveBeenCalledWith('book:old', 'book:new')
  })

  it('reports a rekey that found nothing to move', async () => {
    const port = passageIndexOver(fakeWire({ rekey: async () => false }))
    await expect(port.rekey('book:missing', 'book:new')).resolves.toBe(false)
  })
})
