import { describe, expect, it, vi } from 'vitest'
import type { ShelfChannel } from './channel'
import { asMark, createRemoteMarks, parseMarks } from './marks'

/**
 * The shelf's marks, over the channel.
 *
 * `prefix`/`suffix` — the recovery context — were absent from the wire until
 * phase 19 and an earlier version of this file pinned them EMPTY. They are on
 * the wire now; `asMark` carries them through rather than inventing them.
 */

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm1',
  bookId: 'b1',
  cfi: 'epubcfi(/6/2)',
  sectionIndex: 1,
  text: 'the whale',
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight',
  tint: 'yellow',
  style: 'fill',
  chapter: 'One',
  createdAt: 10,
  ...over,
})

/** A shelf that answers `mark.list` with these rows, one page. */
function shelfOf(rows: readonly Record<string, unknown>[], onCall?: (s: string, b: unknown) => void) {
  return {
    call: async (service: string, body: unknown) => {
      onCall?.(service, body)
      return null
    },
    stream: (service: string, body: unknown) => ({
      [Symbol.asyncIterator]: async function* () {
        onCall?.(service, body)
        yield rows
      },
    }),
    close: () => {},
  } as unknown as ShelfChannel
}

const settled = () => new Promise((r) => setTimeout(r, 0))

describe('asMark', () => {
  it('carries every field the wire sends', () => {
    expect(asMark(row() as never)).toMatchObject({
      id: 'm1',
      bookId: 'b1',
      text: 'the whale',
      kind: 'highlight',
      tint: 'yellow',
      chapter: 'One',
      createdAt: 10,
    })
  })

  /**
   * THE RECOVERY CONTEXT COMES THROUGH.
   *
   * `prefix`/`suffix` are the words either side of the marked text, kept so a
   * mark can be found again when its CFI stops resolving. The wire did not
   * carry them until phase 19, and this test then pinned that they were EMPTY
   * — which was honest about the wire and silent about the defect. They are
   * carried now, both ways, and a mark read here has what a desktop-made one
   * has.
   */
  it('keeps the recovery context the wire now carries', () => {
    const mark = asMark(row({ prefix: 'the ', suffix: ' calls' }) as never)
    expect(mark.prefix).toBe('the ')
    expect(mark.suffix).toBe(' calls')
  })
})

describe('parseMarks', () => {
  it('reads the rows a page carries', () => {
    expect(parseMarks([row(), row({ id: 'm2' })]).map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  /* AN ID AND A BOOK OR IT IS NOT A MARK: React keys on the first and every
     view groups by the second. */
  it('drops a row with no id or no book', () => {
    expect(parseMarks([row({ id: '' }), row({ bookId: undefined }), row()]).map((m) => m.id)).toEqual(['m1'])
  })

  it('survives an answer that is not a list', () => {
    for (const junk of [null, undefined, 7, 'rows', { rows: [] }]) expect(parseMarks(junk)).toEqual([])
  })
})

describe('createRemoteMarks', () => {
  /* NO `book`, which the service reads as every book — the fact that makes this
     pane worth mounting at all. One call, not one per book. */
  it('asks for every book’s marks, not one book’s', async () => {
    const asked: { service: string; body: unknown }[] = []
    createRemoteMarks(shelfOf([row()], (service, body) => asked.push({ service, body })))
    await settled()
    expect(asked[0]).toEqual({ service: 'mark.list', body: {} })
  })

  it('splits annotations from bookmarks', async () => {
    const store = createRemoteMarks(shelfOf([row(), row({ id: 'm2', kind: 'bookmark' })]))
    await settled()
    expect(store.all.map((m) => m.id)).toEqual(['m1'])
    expect(store.allBookmarks.map((m) => m.id)).toEqual(['m2'])
  })

  /* THE SAME ARRAY UNTIL SOMETHING CHANGES. `getSnapshot`'s contract; filtering
     in the getter would hand React a new array every look and re-render forever. */
  it('returns the same array until the marks change', async () => {
    const store = createRemoteMarks(shelfOf([row()]))
    await settled()
    expect(store.all).toBe(store.all)
  })

  it('removes optimistically and tells the shelf', async () => {
    const asked: { service: string; body: unknown }[] = []
    const store = createRemoteMarks(shelfOf([row()], (s, b) => asked.push({ service: s, body: b })))
    await settled()
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(store.all).toEqual([])
    expect(asked.at(-1)).toEqual({ service: 'mark.remove', body: { mark: 'm1', book: 'b1' } })
  })

  it('writes a note optimistically and tells the shelf', async () => {
    const asked: { service: string; body: unknown }[] = []
    const store = createRemoteMarks(shelfOf([row()], (s, b) => asked.push({ service: s, body: b })))
    await settled()
    store.setNote({ id: 'm1', bookId: 'b1' }, 'mine')
    expect(store.all[0]?.note).toBe('mine')
    expect(asked.at(-1)).toEqual({ service: 'mark.set', body: { mark: 'm1', book: 'b1', note: 'mine' } })
  })

  it('wakes its listeners when the marks change', async () => {
    const store = createRemoteMarks(shelfOf([row()]))
    const woke = vi.fn()
    store.subscribe(woke)
    await settled()
    store.remove({ id: 'm1', bookId: 'b1' })
    expect(woke).toHaveBeenCalled()
  })

  /* A DROPPED CHANNEL DOES NOT EMPTY THE LIST. The marks last seen are real and
     the channel is what went; emptying would tell a reader their highlights had
     been deleted, which is alarming and false. */
  it('keeps what it had when a re-read fails', async () => {
    let fail = false
    const flaky = {
      call: async () => null,
      stream: () => ({
        [Symbol.asyncIterator]: async function* () {
          if (fail) throw new Error('gone')
          yield [row()]
        },
      }),
      close: () => {},
    } as unknown as ShelfChannel
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createRemoteMarks(flaky)
    await settled()
    expect(store.all).toHaveLength(1)
    fail = true
    store.refresh()
    await settled()
    expect(store.all).toHaveLength(1)
    vi.restoreAllMocks()
  })

  it('says nothing more after dispose', async () => {
    const store = createRemoteMarks(shelfOf([row()]))
    const woke = vi.fn()
    store.subscribe(woke)
    store.dispose()
    await settled()
    expect(woke).not.toHaveBeenCalled()
  })
})
