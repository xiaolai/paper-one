import { describe, expect, it, vi } from 'vitest'
import {
  createMark,
  type Annotation,
  type IndexFs,
  type IndexedBook,
  type Library,
  type Mark,
  type MarkSnapshot,
  type MarkStore,
  type SizePort,
} from '../../kernel'
import { localContent } from './localContent'
import { localMarks } from './localMarks'
import { localPositions } from './localPositions'

/**
 * THE PHONE'S THREE ADAPTERS — the same contracts the browser client answers
 * over a WebSocket, answered here off this device's own disk.
 *
 * What is worth testing is exactly the places the two implementations DIVERGE,
 * because the shared half is already covered by the browser client's own
 * tests. So: the null-size branch that decides whether pdf.js gets a range
 * transport, the record-versus-localStorage question for positions, and the
 * `Placed` narrowing that stands between a cross-book annotation and the
 * painter.
 */

const record = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({ bookId: 'bk1', title: 'Moby-Dick', author: 'Melville', ext: 'epub', ...over }) as IndexedBook

function fsWith(bytes: Uint8Array, seen: string[] = []) {
  return {
    readFile: async (path: string) => {
      seen.push(`readFile ${path}`)
      return bytes
    },
    readRange: async (path: string, offset: number, length: number) => {
      seen.push(`readRange ${path} ${offset}+${length}`)
      return bytes.slice(offset, offset + length)
    },
  } as unknown as IndexFs
}

describe('localContent', () => {
  it('says a book it has never heard of is not here, rather than guessing', async () => {
    const content = localContent({ fs: fsWith(new Uint8Array()), bookOf: () => undefined, sizes: null })
    expect(await content.locate('nope')).toEqual({ here: false, ext: null, size: null, contentHash: null })
  })

  it('carries the extension and the hash off the record, and the size off the port', async () => {
    const sizes = { contentBytes: async () => 4_096 } as unknown as SizePort
    const content = localContent({
      fs: fsWith(new Uint8Array()),
      bookOf: () => record({ contentHash: 'abc123', hasContent: true }),
      sizes,
    })
    expect(await content.locate('bk1')).toEqual({ here: true, ext: 'epub', size: 4_096, contentHash: 'abc123' })
  })

  it('answers size null with no size port — the branch that picks the whole file', async () => {
    const content = localContent({ fs: fsWith(new Uint8Array()), bookOf: () => record(), sizes: null })
    /* NULL IS A REAL ANSWER, not a missing one: `useBookSource` reads it and
       hands foliate the whole file instead of a range transport. The desktop
       bound no size port for the whole of phase 11, so a caller that assumed a
       number always arrives would have worked in every test and against
       nothing. */
    expect((await content.locate('bk1')).size).toBeNull()
  })

  it('a size port that throws degrades to null rather than failing the open', async () => {
    const sizes = { contentBytes: async () => Promise.reject(new Error('no')) } as unknown as SizePort
    const content = localContent({ fs: fsWith(new Uint8Array()), bookOf: () => record(), sizes })
    expect((await content.locate('bk1')).size).toBeNull()
  })

  it('treats a record written before hasContent existed as here, not as missing', async () => {
    const content = localContent({ fs: fsWith(new Uint8Array()), bookOf: () => record(), sizes: null })
    /* `hasContent` is undefined on a pre-flag record. Reading that as false
       would hide every one of them behind a "no copy" the folder disagrees
       with. */
    expect((await content.locate('bk1')).here).toBe(true)
  })

  it('reads a range through the filesystem, not by reading the whole book', async () => {
    const seen: string[] = []
    const content = localContent({
      fs: fsWith(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]), seen),
      bookOf: () => record(),
      sizes: null,
    })
    expect(await content.readRange('bk1', 2, 3, null)).toEqual(Uint8Array.from([2, 3, 4]))
    expect(seen.some((one) => one.startsWith('readRange'))).toBe(true)
    expect(seen.some((one) => one.startsWith('readFile'))).toBe(false)
  })

  it('a short answer at the end of the file is not an error', async () => {
    const content = localContent({ fs: fsWith(Uint8Array.from([0, 1, 2])), bookOf: () => record(), sizes: null })
    expect(await content.readRange('bk1', 1, 99, null)).toEqual(Uint8Array.from([1, 2]))
  })

  it('refuses a range for a book this device does not have, BY NAME', async () => {
    const content = localContent({ fs: fsWith(new Uint8Array()), bookOf: () => undefined, sizes: null })
    await expect(content.readRange('ghost', 0, 1, null)).rejects.toThrow(/no book on this device with id "ghost"/)
  })

  it('hands the file back under the ORIGINAL name, not the vault’s stored one', async () => {
    const content = localContent({ fs: fsWith(Uint8Array.from([1, 2])), bookOf: () => record(), sizes: null })
    const file = await content.fileOf('bk1', 'Moby-Dick.epub')
    /* The vault stores by hash so two copies cannot collide; foliate routes on
       the filename's suffix. Handing over the stored name would route every
       book to the same unsupported type. */
    expect(file.name).toBe('Moby-Dick.epub')
  })
})

function libraryWith(position: string | null) {
  const remembered: { bookId: string; cfi: string }[] = []
  let fail: Error | null = null
  const library = {
    positionOf: () => position,
    rememberPosition: async (bookId: string, cfi: string) => {
      if (fail !== null) throw fail
      remembered.push({ bookId, cfi })
    },
  } as unknown as Library
  return { library, remembered, breakIt: (why: Error) => void (fail = why) }
}

describe('localPositions', () => {
  it('reads the position off the record, not off browser storage', () => {
    const { library } = libraryWith('epubcfi(/6/4!/2)')
    expect(localPositions({ library }).get('bk1')).toBe('epubcfi(/6/4!/2)')
  })

  it('writes a turn through rememberPosition, so the journal and sync see it', async () => {
    const { library, remembered } = libraryWith(null)
    localPositions({ library }).set('bk1', 'epubcfi(/6/8!/2)')
    await Promise.resolve()
    /* THE WHOLE REASON THIS MODULE EXISTS. In `localStorage` a phone would
       read on the train, arrive home, and find the laptop had never heard of
       it. */
    expect(remembered).toEqual([{ bookId: 'bk1', cfi: 'epubcfi(/6/8!/2)' }])
  })

  it('does not write anything for a null position', async () => {
    const { library, remembered } = libraryWith(null)
    localPositions({ library }).set('bk1', null)
    await Promise.resolve()
    expect(remembered).toEqual([])
  })

  it('reports a write that did not land rather than dropping it', async () => {
    const { library, breakIt } = libraryWith(null)
    breakIt(new Error('disk full'))
    const failed = vi.fn()
    localPositions({ library, failed }).set('bk1', 'epubcfi(/6/8!/2)')
    await Promise.resolve()
    await Promise.resolve()
    /* A position that silently stops saving is indistinguishable from one that
       never moved. */
    expect(failed).toHaveBeenCalledOnce()
    expect(failed.mock.calls[0]?.[0]).toBe('bk1')
  })

  it('held answers 0 until THIS session has written, then its own clock', async () => {
    const { library } = libraryWith('epubcfi(/6/4!/2)')
    const positions = localPositions({ library })
    /* 0 is the contract's "no stamp recorded", and it loses to any shelf
       stamp — the safe direction, since losing means adopting the shelf's
       place rather than overwriting it with an unstamped one. */
    expect(positions.held('bk1')).toEqual({ cfi: 'epubcfi(/6/4!/2)', at: 0 })
    positions.set('bk1', 'epubcfi(/6/4!/2)')
    await Promise.resolve()
    expect(positions.held('bk1')?.at).toBeGreaterThan(0)
  })

  it('held is null for a book with no position at all', () => {
    const { library } = libraryWith(null)
    expect(localPositions({ library }).held('bk1')).toBeNull()
  })
})

function markStoreWith(snapshot: Partial<MarkSnapshot>) {
  const calls: string[] = []
  let refuse: Error | null = null
  const store = {
    getSnapshot: () =>
      ({ all: [], current: [], bookmarks: [], unplaced: [], allBookmarks: [], allUnplaced: [], persistent: true, bookId: null, ...snapshot }) as MarkSnapshot,
    subscribe: () => () => {},
    add: async (mark: Mark) => {
      if (refuse !== null) throw refuse
      calls.push(`add ${mark.bookId}`)
    },
    remove: async (id: string, bookId?: string) => void calls.push(`remove ${id} ${String(bookId)}`),
    updateNote: async (id: string, note: string, bookId?: string) => void calls.push(`note ${id} ${note} ${String(bookId)}`),
    loadAll: async () => void calls.push('loadAll'),
    open: async (bookId: string | null) => void calls.push(`open ${String(bookId)}`),
  } as unknown as MarkStore
  return { store, calls, refuse: (why: Error) => void (refuse = why) }
}

const annotation = (placed: boolean): Annotation =>
  createMark({
    kind: 'highlight',
    style: 'fill',
    bookId: 'bk1',
    /* NO BRANDED MINTER NEEDED, and reaching for one was a detour: `isPlaced`
       is `unplaced === undefined && cfi !== ''`, so the `ResolvedCfi` brand is
       what the PREDICATE hands back, not what it demands. A non-empty string
       is the whole input. (The first version of this fixture imported
       `resolvedCfiForTesting` from the testkit, which `mobile-client-kernel-entries`
       refused — correctly, and the refusal pointed at the simpler fixture.) */
    cfi: placed ? 'epubcfi(/6/4!/2)' : '',
    sectionIndex: placed ? 0 : -1,
    text: 'call me Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    tint: 'yellow',
    chapter: 'Loomings',
  }) as Annotation

describe('localMarks', () => {
  it('narrows the cross-book list to PLACED annotations before the painter sees it', () => {
    const { store } = markStoreWith({ all: [annotation(true), annotation(false)] })
    /* `MarkSnapshot.all` is `Annotation[]` on purpose — it is cross-book, and
       `ResolvedCfi` means "addresses a passage in the build now open", so
       branding another book's anchors with it would say something false at the
       door the brand guards. `RemoteMarks.all` is the narrower type because
       `Reader` maps it straight to painter anchors, so the filter belongs at
       this boundary. */
    expect(localMarks({ marks: store }).all).toHaveLength(1)
  })

  it('mints the mark and hands back what the store took', async () => {
    const { store, calls } = markStoreWith({})
    const made = await localMarks({ marks: store }).add({
      bookId: 'bk1',
      cfi: 'epubcfi(/6/4!/2)',
      sectionIndex: 0,
      text: 'call me Ishmael',
      prefix: '',
      suffix: '',
      note: '',
      tint: 'green',
      chapter: 'Loomings',
    })
    expect(made?.tint).toBe('green')
    expect(made?.style).toBe('fill')
    expect(calls).toEqual(['add bk1'])
  })

  it('returns null when the store refuses, so nothing is painted that is not in the file', async () => {
    const { store, refuse } = markStoreWith({})
    refuse(new Error('read-only'))
    const failed = vi.fn()
    const made = await localMarks({ marks: store, failed }).add({
      bookId: 'bk1',
      cfi: 'epubcfi(/6/4!/2)',
      sectionIndex: 0,
      text: 'x',
      prefix: '',
      suffix: '',
      note: '',
      tint: 'yellow',
      chapter: '',
    })
    expect(made).toBeNull()
    expect(failed).toHaveBeenCalledOnce()
  })

  it('routes remove and setNote by id AND book', () => {
    const { store, calls } = markStoreWith({})
    const marks = localMarks({ marks: store })
    marks.remove({ id: 'm1', bookId: 'bk1' })
    marks.setNote({ id: 'm1', bookId: 'bk1' }, 'a note')
    expect(calls).toEqual(['remove m1 bk1', 'note m1 a note bk1'])
  })

  it('refresh re-reads the OPEN book, and does nothing when there is none', () => {
    const open = markStoreWith({ bookId: 'bk1' })
    localMarks({ marks: open.store }).refresh()
    expect(open.calls).toEqual(['open bk1'])

    const shut = markStoreWith({ bookId: null })
    localMarks({ marks: shut.store }).refresh()
    expect(shut.calls).toEqual([])
  })
})
