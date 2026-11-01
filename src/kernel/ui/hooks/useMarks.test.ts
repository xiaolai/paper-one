// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderOf, marksPathIn, recordPath } from '../../core/bookFolder'
import { hlcOf } from '../../core/hlc'
import { fakeFs } from '../../core/indexFsFake.testkit'
import { MarksScanFailed, createMarkStore, type MarkSnapshot, type MarkStore } from '../../core/markStore'
import {
  bookmarkFrom,
  createMark,
  type Annotation,
  type Bookmark,
  type NewMark,
  type Placed,
} from '../../core/marks'
import { resolvedCfiForTesting } from '../../core/resolvedCfi.testkit'
import { writeQueue } from '../../core/writeQueue'
import { useMarks } from './useMarks'

/**
 * ⚠️ THE ASSERTION THAT STOPS AN EMPTY BACKUP COMING BACK — the second half.
 *
 * `markStore.test.ts` holds the first half: the cross-book lists are empty
 * until something scans, so an export driven from the palette in a session
 * where Marginalia was never opened wrote a valid archive containing nothing
 * and called it a success. `loadAllNow` scans first, which fixed that.
 *
 * It did not fix the other way of reaching the same file. A scan that FAILS
 * leaves exactly the same empty list behind — `MarkStore.loadAll` catches the
 * failure, installs `[]` and resolves, because the panel that calls it has to
 * draw something either way — so a disk that would not answer still produced
 * `{"version":1,"books":[]}` over the reader's only backup, reported as done.
 * The store says which it was; nothing outside the panel was reading it (the
 * 2026-08-28 audit, #101).
 *
 * So: a failed scan must be a REJECTION here, and an empty library must not
 * be. A fix that threw for both would pass the first test below and lose the
 * feature, which is why the third one exists.
 */

afterEach(cleanup)

/**
 * Let everything the store has started land, then commit what it published.
 *
 * Every read and write on the fake disk settles on promises alone — no timer
 * anywhere on that path — so one macrotask turn finishes all of it. Exact where
 * `waitFor` would poll, and a hook that never asks the store fails here at once
 * rather than at the setup's ten-second ceiling.
 */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const BOOK = 'book:abc'

/** A book folder on disk, which is what makes `BOOKS_DIR` exist. */
const shelf = () =>
  fakeFs({ [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }) })

/**
 * The same shelf, unlistable.
 *
 * `scanAllMarks` throws only when the directory is THERE and will not read —
 * absent is an empty library and resolves — so the failure has to be built
 * this way round rather than by handing it an empty disk.
 */
const unlistableShelf = () => {
  const fs = shelf()
  return {
    ...fs,
    readDir: async (): Promise<never> => {
      throw new Error('the shelf will not read')
    },
  }
}

const highlight = (): NewMark => ({
  bookId: BOOK,
  cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
  sectionIndex: 0,
  text: 'Ishmael',
  prefix: '',
  suffix: '',
  note: '',
  kind: 'highlight',
  tint: 'yellow',
  style: 'fill',
  chapter: 'Ch. 1',
})

const place = (): NewMark =>
  bookmarkFrom({
    bookId: BOOK,
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:400)',
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: '',
    suffix: '',
    chapter: 'Ch. 1',
  })

/** What `loadAllNow` refused with: the test fails if it answered instead. */
const refusal = (store: MarkStore): Promise<MarksScanFailed> =>
  store.loadAllNow().then(
    () => {
      throw new Error('it answered')
    },
    (cause: unknown) => {
      if (cause instanceof MarksScanFailed) return cause
      throw cause
    },
  )

describe('every mark, for something that is about to write a file', () => {
  it('refuses to answer at all when the scan failed', async () => {
    const store = createMarkStore({ fs: unlistableShelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))

    await act(async () => {
      /* THE ONE OUTCOME WORTH REFUSING is this resolving with `[]`: an empty
         answer becoming a file on disk, over the backup it was replacing. */
      await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
    })
    /* And the store still says so, for the panel that draws rather than
       writes — the two readings of one scan must not disagree. */
    expect(result.current.scanFailed).toBe(true)
  })

  /* ONE DAMAGED BOOK COSTS THE PANE THAT BOOK'S NOTES, and that is right for a
     pane. A backup that left them out would say nothing, and the file is not
     read again until the day the reader needs it. */
  describe('when one book in the library will not read', () => {
    const OTHER = 'book:other'
    /** A healthy book's marks on disk, and `damage` done to another book's. */
    const damaged = async (damage: (fs: ReturnType<typeof shelf>) => ReturnType<typeof shelf>) => {
      const fs = shelf()
      fs.store.set(recordPath(OTHER), new TextEncoder().encode('{}'))
      fs.store.set(marksPathIn(OTHER), new TextEncoder().encode('[]'))
      const writer = createMarkStore({ fs, queue: writeQueue() })
      await writer.open(BOOK)
      await writer.addMany(BOOK, [createMark(highlight())])
      return createMarkStore({ fs: damage(fs), queue: writeQueue() })
    }
    const refusingOther = (fs: ReturnType<typeof shelf>) => ({
      ...fs,
      readFile: async (path: string) => {
        if (path === marksPathIn(OTHER)) throw new Error('the disk will not answer')
        return fs.readFile(path)
      },
    })
    const writing = (bytes: string) => (fs: ReturnType<typeof shelf>) => {
      fs.store.set(marksPathIn(OTHER), new TextEncoder().encode(bytes))
      return fs
    }

    it.each([
      ['will not parse', writing('not json')],
      ['holds something that is not a list', writing('{"marks":[]}')],
      ['will not read', refusingOther],
      [
        'will not read, and nobody can say whether it is there',
        (fs: ReturnType<typeof shelf>) => ({
          ...refusingOther(fs),
          exists: async (path: string) => {
            if (path === marksPathIn(OTHER)) throw new Error('the disk will not answer')
            return fs.exists(path)
          },
        }),
      ],
    ])('refuses to answer when its file %s', async (_name, damage) => {
      const store = await damaged(damage)
      const { result } = renderHook(() => useMarks(store, BOOK))

      await act(async () => {
        const cause = await refusal(store)
        /* Named, or the reader has a refusal and nothing to act on. */
        expect(cause.damaged).toEqual([folderOf(OTHER)])
        expect(cause.unsaved).toEqual([])
      })
      /* The panel's reading of the same scan is untouched: the book that did
         read is drawn, and the shelf is not said to have failed. */
      expect(result.current.scanFailed).toBe(false)
      expect(result.current.all.map((mark) => mark.bookId)).toEqual([BOOK])
    })

    /* The panel keeps the row aside and draws the rest, which is right for a
       panel. A backup would lose that mark without a word. */
    it('refuses to answer when a file holds a row that will not validate', async () => {
      const store = await damaged((fs) => {
        const row = { ...createMark(highlight()), id: 'refused-row', bookId: OTHER, sectionIndex: -1 }
        fs.store.set(marksPathIn(OTHER), new TextEncoder().encode(JSON.stringify([row])))
        return fs
      })
      const { result } = renderHook(() => useMarks(store, BOOK))

      await act(async () => {
        /* The row may name no book at all: it is the folder it was in that is said. */
        expect((await refusal(store)).damaged).toEqual([folderOf(OTHER)])
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
      })
      expect(result.current.scanFailed).toBe(false)
      expect(result.current.all.map((mark) => mark.bookId)).toEqual([BOOK])
    })

    /* Two scans let go together land one after the other, and the later one's
       `publish` runs before the earlier one's caller resumes: reading the shared
       snapshot there answered a complete scan with the partial scan's rows. */
    describe('and a panel scan overlaps the one about to write', () => {
      const overlapping = () => {
        const fs = shelf()
        let open = () => {}
        const held = new Promise<void>((resolve) => (open = resolve))
        let listings = 0
        const gated = {
          ...fs,
          readDir: async (path: string) => {
            listings += 1
            await held
            return fs.readDir(path)
          },
        }
        /* The export waits for pending writes first, so its scan starts a little
           after the call. The test is about a scan that starts after that one. */
        const scanStarted = async () => {
          while (listings === 0) await Promise.resolve()
        }
        return { fs, gated, open, scanStarted }
      }

      it('answers with its own rows when the panel scan loses a book', async () => {
        const { fs, gated, open, scanStarted } = overlapping()
        fs.store.set(recordPath(OTHER), new TextEncoder().encode('{}'))
        const writer = createMarkStore({ fs, queue: writeQueue() })
        await writer.open(BOOK)
        await writer.addMany(BOOK, [createMark(highlight())])
        let reads = 0
        const store = createMarkStore({
          fs: {
            ...gated,
            readFile: async (path: string) => {
              if (path === marksPathIn(BOOK) && ++reads === 2) return new TextEncoder().encode('not json')
              return fs.readFile(path)
            },
          },
          queue: writeQueue(),
        })

        const answer = store.loadAllNow()
        await scanStarted()
        const panel = store.loadAll()
        open()
        await expect(answer).resolves.toHaveLength(1)
        await panel
      })
    })

    /* A mark is on the screen the moment it is made and on the disk some time
       later, and the scan reads the disk: without the wait, the export left out
       the mark the reader had just made, and called the backup done. */
    describe('and a mark is still being written', () => {
      const writing = () => {
        const fs = shelf()
        let open: (failure?: Error) => void = () => {}
        const held = new Promise<void>((resolve, reject) => {
          open = (failure) => (failure ? reject(failure) : resolve())
        })
        const store = createMarkStore({
          fs: {
            ...fs,
            writeFile: async (path: string, bytes: Uint8Array) => {
              await held
              return fs.writeFile(path, bytes)
            },
          },
          queue: writeQueue(),
        })
        return { store, open }
      }

      it('waits for the write, and answers with the mark', async () => {
        const { store, open } = writing()
        await store.open(BOOK)
        const saving = store.add(createMark(highlight()))
        const answer = store.loadAllNow()
        open()
        await saving
        await expect(answer).resolves.toHaveLength(1)
      })

      it('refuses when the write fails: a backup may not leave out a mark on the screen', async () => {
        const { store, open } = writing()
        await store.open(BOOK)
        const saving = store.add(createMark(highlight()))
        const answer = store.loadAllNow()
        open(new Error('disk full'))
        await expect(saving).rejects.toThrow('disk full')
        await expect(answer).rejects.toBeInstanceOf(MarksScanFailed)
        /* Its file is healthy, so this one is not called damaged: removing a book
           whose only trouble is one lost edit would cost the reader all the rest. */
        expect(await refusal(store)).toMatchObject({ damaged: [], unsaved: [folderOf(BOOK)] })
        expect(store.getSnapshot().persistent).toBe(false)
      })

      it('goes on refusing after the failure, and answers once the book is read again', async () => {
        const { store, open } = writing()
        await store.open(BOOK)
        const saving = store.add(createMark(highlight()))
        open(new Error('disk full'))
        await expect(saving).rejects.toThrow('disk full')
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)

        await store.open(BOOK)
        await expect(store.loadAllNow()).resolves.toEqual([])
      })
    })

    describe('and the store holds a mark the disk does not', () => {
      const losing = async () => {
        const fs = shelf()
        fs.store.set(marksPathIn(BOOK), new TextEncoder().encode('[]'))
        const control = { unreadable: false }
        const store = createMarkStore({
          fs: {
            ...fs,
            writeFile: () => Promise.reject(new Error('disk full')),
            readFile: async (path: string) => {
              if (control.unreadable && path === marksPathIn(BOOK)) {
                control.unreadable = false
                throw new Error('EIO')
              }
              return fs.readFile(path)
            },
          },
          queue: writeQueue(),
        })
        await store.open(BOOK)
        await expect(store.add(createMark(highlight()))).rejects.toThrow('disk full')
        return { fs, store, control }
      }

      it('refuses when reopening the book would not read, which cleared the failure', async () => {
        const { store, control } = await losing()
        control.unreadable = true
        await store.open(BOOK)
        expect(store.getSnapshot().persistent).toBe(false)
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
      })

      it('refuses after another book opens, however often it is asked', async () => {
        const { store } = await losing()
        await store.open(OTHER)
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
        /* Not the flag, cleared by opening OTHER, and it still names the right book. */
        expect(await refusal(store)).toMatchObject({ damaged: [], unsaved: [folderOf(BOOK)] })
      })

      it('answers once that book reads back, when the screen agrees with the disk', async () => {
        const { store } = await losing()
        await store.open(OTHER)
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
        await store.open(BOOK)
        await expect(store.loadAllNow()).resolves.toEqual([])
      })
    })

    it('does not call a removed book a lost mark', async () => {
      const fs = shelf()
      const store = createMarkStore({ fs, queue: writeQueue() })
      await store.open(BOOK)
      await store.add(createMark(highlight()))
      await store.open(null)
      await fs.removeDir(folderOf(BOOK))
      await expect(store.loadAllNow()).resolves.toEqual([])
    })

    it('does not call a mark lost when the disk holds a newer copy of it', async () => {
      const fs = shelf()
      const store = createMarkStore({ fs, queue: writeQueue() })
      await store.open(BOOK)
      await store.add(createMark(highlight()))
      const [held] = store.getSnapshot().current
      const newer = { ...held, note: 'written elsewhere', updatedAt: hlcOf(Date.now() + 86_400_000) }
      fs.store.set(marksPathIn(BOOK), new TextEncoder().encode(JSON.stringify([newer])))
      await expect(store.loadAllNow()).resolves.toHaveLength(1)
    })

    it('refuses when a book is rekeyed under the scan, rather than reading it as no marks', async () => {
      const fs = shelf()
      const at = marksPathIn(BOOK)
      fs.store.set(at, new TextEncoder().encode(JSON.stringify([createMark(highlight())])))
      const folder = at.slice(0, at.lastIndexOf('/'))
      const store = createMarkStore({
        fs: {
          ...fs,
          /* The move lands after the listing named the old folder, before its read. */
          readFile: async (path: string) => {
            if (path === at) await fs.rename(folder, `${folder}-rekeyed`)
            return fs.readFile(path)
          },
        },
        queue: writeQueue(),
      })
      expect((await refusal(store)).damaged).toEqual([folder])
    })

    it('names every book it left out, and only those', async () => {
      const THIRD = 'book:third'
      const store = await damaged((fs) => {
        fs.store.set(recordPath(THIRD), new TextEncoder().encode('{}'))
        fs.store.set(marksPathIn(THIRD), new TextEncoder().encode('not json'))
        fs.store.set(marksPathIn(OTHER), new TextEncoder().encode('not json'))
        return fs
      })
      expect([...(await refusal(store)).damaged].sort()).toEqual([folderOf(OTHER), folderOf(THIRD)].sort())
    })

    it('still folds an id two books share, read as one library', async () => {
      const fs = shelf()
      const mark = createMark(highlight())
      fs.store.set(recordPath(OTHER), new TextEncoder().encode('{}'))
      fs.store.set(marksPathIn(BOOK), new TextEncoder().encode(JSON.stringify([mark])))
      fs.store.set(marksPathIn(OTHER), new TextEncoder().encode(JSON.stringify([mark])))
      const store = createMarkStore({ fs, queue: writeQueue() })
      await expect(store.loadAllNow()).resolves.toHaveLength(1)
    })

    it('answers again once the file reads', async () => {
      const fs = shelf()
      fs.store.set(marksPathIn(OTHER), new TextEncoder().encode('not json'))
      const store = createMarkStore({ fs, queue: writeQueue() })
      await act(async () => {
        await expect(store.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
      })

      fs.store.set(marksPathIn(OTHER), new TextEncoder().encode('[]'))

      await act(async () => {
        await expect(store.loadAllNow()).resolves.toEqual([])
      })
    })

    it('answers for a book that has no marks file at all', async () => {
      const fs = shelf()
      const store = createMarkStore({ fs, queue: writeQueue() })

      await act(async () => {
        await expect(store.loadAllNow()).resolves.toEqual([])
      })
    })
  })

  it('hands back both classes when the scan lands', async () => {
    const fs = shelf()
    const writer = createMarkStore({ fs, queue: writeQueue() })
    await writer.open(BOOK)
    await writer.addMany(BOOK, [createMark(highlight()), createMark(place())])

    /* A FRESH STORE over the same disk is the palette-without-the-panel case:
       the rows are on disk and nothing in this session has scanned them. */
    const store = createMarkStore({ fs, queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))

    let everyMark: readonly { kind: string }[] = []
    await act(async () => {
      everyMark = await store.loadAllNow()
    })
    /* BOTH CLASSES. They share a file and are split at the snapshot, and an
       archive of one half is a backup that silently drops the other. */
    expect(everyMark.map((mark) => mark.kind).sort()).toEqual(['bookmark', 'highlight'])
    expect(result.current.scanFailed).toBe(false)
  })

  /* ⚠️ **A NOTE'S WRITE IS THE ONE A CALLER CAN ACT ON** (#131). Every other
     verb's promise is let go — the pane reports persistence separately — but
     the note editor is still holding the text, and it can only retry a write it
     is told about. Let go, a refusal was indistinguishable from a save. */
  it('hands a note write back, so its editor can tell a saved note from a lost one', async () => {
    const fs = shelf()
    const store = createMarkStore({ fs, queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))
    let mark = createMark(highlight())
    await act(async () => {
      await store.open(BOOK)
      mark = result.current.add(highlight())
    })

    await act(async () => {
      await expect(result.current.setNote(mark, 'a gam is a meeting')).resolves.toBeUndefined()
    })
    expect(result.current.persistent).toBe(true)

    /* AND A WRITE WITH NOWHERE TO LAND REJECTS rather than resolving: the
       store says so on `persistent` too, and the editor needs both — the flag
       is about the app, this promise is about THIS note. */
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      const refused = await result.current
        .setNote({ id: mark.id, bookId: 'book:no-such-folder' }, 'nowhere')
        .then(() => null, (cause: unknown) => cause)
      expect(refused).toBeInstanceOf(Error)
      expect((refused as Error).message).toMatch(/no folder under that id/u)
    })
    expect(result.current.persistent).toBe(false)
    quiet.mockRestore()
  })

  /* ⚠️ **AND A REFUSED NOTE OUTLIVES THE EDITOR THAT WROTE IT** (2026-09-14,
     #131, round 4). Closing the pane unmounts the editor whatever is in flight,
     so a refusal landing after that had nobody to retry it. The hook has the
     window's lifetime: it keeps the text of a mark's NEWEST refused write until
     a later write of that mark lands. */
  it('holds the note of a mark’s newest refused write, until a later write lands', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const writes: { resolve(): void; reject(cause: Error): void }[] = []
    const store = {
      ...createMarkStore({ fs: null, queue: writeQueue() }),
      updateNote: () => new Promise<void>((resolve, reject) => writes.push({ resolve, reject })),
    }
    const { result } = renderHook(() => useMarks(store, BOOK))
    const mark = { id: 'm1', bookId: BOOK }
    const nothing = result.current.unsaved
    expect(nothing.size).toBe(0)

    /* A write landing with nothing held changes nothing — not even the map's
       identity, which everything reading this view re-renders on. */
    act(() => void result.current.setNote(mark, 'first'))
    await act(async () => writes[0]!.resolve())
    expect(result.current.unsaved, 'a landed note published a new, empty map').toBe(nothing)

    act(() => {
      void result.current.setNote(mark, 'first, then more')
      void result.current.setNote(mark, 'first, then more still')
    })
    await act(async () => writes[1]!.reject(new Error('EIO')))
    expect(result.current.unsaved.has('m1'), 'an older write’s refusal was held over a newer write').toBe(false)
    await act(async () => writes[2]!.reject(new Error('EIO')))
    expect(result.current.unsaved.get('m1')).toBe('first, then more still')

    act(() => void result.current.setNote(mark, 'first, then more still'))
    await act(async () => writes[3]!.resolve())
    expect(result.current.unsaved.has('m1'), 'a note that landed was still held as refused').toBe(false)
    quiet.mockRestore()
  })

  /* ⚠️ AND AN EMPTY LIBRARY IS STILL AN ANSWER. The whole point is telling the
     two apart; a refusal that fired for both would delete the feature while
     passing the first test in this file. */
  it('answers with nothing for a library that holds nothing', async () => {
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))

    let everyMark: readonly unknown[] = ['not asked']
    await act(async () => {
      everyMark = await store.loadAllNow()
    })
    expect(everyMark).toEqual([])
    expect(result.current.scanFailed).toBe(false)
  })

  it('names a failed scan as the failure it is, for the catch that branches on it', async () => {
    const store = createMarkStore({ fs: unlistableShelf(), queue: writeQueue() })

    let cause: unknown = null
    await act(async () => {
      cause = await store.loadAllNow().then(
        () => null,
        (thrown: unknown) => thrown,
      )
    })
    expect(cause).toBeInstanceOf(MarksScanFailed)
    expect((cause as Error).name).toBe('MarksScanFailed')
    expect((cause as Error).message).toBe("the library's marks could not be read")
    /* No book is to blame when the library will not list, and none may be named. */
    expect(cause).toMatchObject({ damaged: [], unsaved: [] })
  })

  /* WHAT `unsaved` HOLDS WHILE A RETRY IS OUT. Only an ANSWER moves it: a write
     going out is not one, so a refused draft stays offered until a later write
     of the same mark lands — and a write still out was never refused, so it is
     not offered at all. */
  it('keeps a refused note while its retry is out, and lets it go only when the retry lands', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const writes: { resolve(): void; reject(cause: Error): void }[] = []
    const store = {
      ...createMarkStore({ fs: null, queue: writeQueue() }),
      updateNote: () => new Promise<void>((resolve, reject) => writes.push({ resolve, reject })),
    }
    const { result } = renderHook(() => useMarks(store, BOOK))
    const mark = { id: 'm1', bookId: BOOK }

    act(() => void result.current.setNote(mark, 'a gam'))
    expect(result.current.unsaved.has('m1'), 'a note still being written was offered as refused').toBe(false)
    await act(async () => writes[0]!.reject(new Error('EIO')))
    expect(result.current.unsaved.get('m1')).toBe('a gam')

    act(() => void result.current.setNote(mark, 'a gam is a meeting'))
    expect(result.current.unsaved.get('m1'), 'the refused note was let go before its retry had an answer').toBe('a gam')
    await act(async () => writes[1]!.resolve())
    expect(result.current.unsaved.has('m1')).toBe(false)
    quiet.mockRestore()
  })
})

const SAVE_FAILED = "Paper: could not save that book's marks"

/* ⚠️ A WRITE LET GO IS STILL A WRITE SOMEBODY MUST HEAR ABOUT. Every verb hands
   its promise on or drops it, so the log is the one trace a
   refused remove, place or note leaves beside `persistent`. */
describe('a refused write', () => {
  it('is logged with what refused it, for a verb whose promise is let go', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = new Error('the disk is full')
    const store = { ...createMarkStore({ fs: null, queue: writeQueue() }), remove: () => Promise.reject(refusal) }
    const { result } = renderHook(() => useMarks(store, BOOK))

    await act(async () => result.current.remove({ id: 'm1', bookId: BOOK }))

    expect(error).toHaveBeenCalledWith(SAVE_FAILED, refusal)
    error.mockRestore()
  })

  it('is logged for a note as well as handed back to its editor', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refusal = new Error('the disk is full')
    const store = { ...createMarkStore({ fs: null, queue: writeQueue() }), updateNote: () => Promise.reject(refusal) }
    const { result } = renderHook(() => useMarks(store, BOOK))

    let handed: unknown = null
    await act(async () => {
      handed = await result.current.setNote({ id: 'm1', bookId: BOOK }, 'a gam').then(
        () => null,
        (cause: unknown) => cause,
      )
    })

    expect(handed).toBe(refusal)
    expect(error).toHaveBeenCalledWith(SAVE_FAILED, refusal)
    error.mockRestore()
  })
})

/** A store whose snapshot is exactly the one given, and never changes — for what the hook makes of it. */
const holding = (over: Partial<MarkSnapshot>): MarkStore => {
  const base = createMarkStore({ fs: null, queue: writeQueue() })
  const snapshot: MarkSnapshot = { ...base.getSnapshot(), ...over }
  return { ...base, open: async () => {}, getSnapshot: () => snapshot, subscribe: () => () => {} }
}

const heldLists = () => ({
  current: [createMark(highlight()) as Placed<Annotation>],
  bookmarks: [createMark(place()) as Bookmark],
  unplaced: [
    createMark({
      ...highlight(),
      cfi: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    }) as Annotation,
  ],
})

/* PAIRED WITH THE BOOK ASKED FOR. Between the render that names a new book and
   the effect that opens it, the store still holds the previous book — and its
   highlights must not be drawn, nor its places light the ribbon, for a frame. */
describe('the open book’s marks', () => {
  it('are the store’s own, and its flags, for the book the store holds', () => {
    const lists = heldLists()
    const store = holding({ bookId: BOOK, ...lists, ready: true, unreadable: true })
    const { result } = renderHook(() => useMarks(store, BOOK))

    expect(result.current.current).toBe(lists.current)
    expect(result.current.bookmarks).toBe(lists.bookmarks)
    expect(result.current.unplaced).toBe(lists.unplaced)
    expect(result.current.ready).toBe(true)
    expect(result.current.unreadable).toBe(true)
  })

  it('are none of another book’s, in the frame before the new book is opened', () => {
    const store = holding({ bookId: 'book:before', ...heldLists(), ready: true, unreadable: true })
    const { result } = renderHook(() => useMarks(store, BOOK))

    expect(result.current.current).toEqual([])
    expect(result.current.bookmarks).toEqual([])
    expect(result.current.unplaced).toEqual([])
    expect(result.current.ready, 'the previous book’s read was reported as this one’s').toBe(false)
    expect(result.current.unreadable, 'the previous book’s damaged file was blamed on this one').toBe(false)
  })

  it('are not called read, or unreadable, before the store says so', () => {
    const store = holding({ bookId: BOOK, ready: false, unreadable: false })
    const { result } = renderHook(() => useMarks(store, BOOK))

    expect(result.current.ready).toBe(false)
    expect(result.current.unreadable).toBe(false)
  })

  it('are read for the book it is given, and for the next one when that changes', async () => {
    const OTHER = 'book:other'
    const fs = fakeFs({
      [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }),
      [recordPath(OTHER)]: JSON.stringify({ bookId: OTHER, title: 'Typee', author: 'Melville' }),
    })
    const writer = createMarkStore({ fs, queue: writeQueue() })
    await writer.open(OTHER)
    await writer.add(createMark({ ...highlight(), bookId: OTHER, text: 'Six months at sea' }))

    const store = createMarkStore({ fs, queue: writeQueue() })
    const { result, rerender } = renderHook(({ bookId }) => useMarks(store, bookId), {
      initialProps: { bookId: BOOK },
    })
    await settled()
    expect(result.current.ready).toBe(true)
    expect(result.current.current).toEqual([])

    rerender({ bookId: OTHER })
    await settled()
    expect(result.current.current.map((mark) => mark.text)).toEqual(['Six months at sea'])
    expect(result.current.ready).toBe(true)
  })
})

describe('the verbs a view hands on', () => {
  it('remove a mark from its book', async () => {
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))
    const mark = createMark(highlight())
    await act(async () => {
      await store.open(BOOK)
      await store.add(mark)
    })
    expect(result.current.current.map((one) => one.id)).toEqual([mark.id])

    act(() => result.current.remove(mark))

    await settled()
    expect(result.current.current).toEqual([])
  })

  it('place an unplaced mark where a re-anchoring pass found it', async () => {
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))
    const waiting = createMark({
      ...highlight(),
      cfi: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    })
    await act(async () => {
      await store.open(BOOK)
      await store.addMany(BOOK, [waiting])
    })
    expect(result.current.unplaced.map((one) => one.id)).toEqual([waiting.id])

    act(() => result.current.place(waiting.id, resolvedCfiForTesting('epubcfi(/6/8!/4/2,/1:0,/1:6)'), 3, BOOK))

    await settled()
    expect(result.current.current.map((one) => [one.id, one.cfi, one.sectionIndex])).toEqual([
      [waiting.id, 'epubcfi(/6/8!/4/2,/1:0,/1:6)', 3],
    ])
    expect(result.current.unplaced).toEqual([])
  })

  it('carry marks written under a superseded book id onto the current one', async () => {
    const OLD = 'file:old'
    const fs = shelf()
    fs.store.set(
      marksPathIn(BOOK),
      new TextEncoder().encode(JSON.stringify([{ ...createMark(highlight()), id: 'm1', bookId: OLD }])),
    )
    const store = createMarkStore({ fs, queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, null))
    act(() => result.current.loadAll())
    await settled()
    expect(result.current.all.map((one) => one.bookId)).toEqual([OLD])

    act(() => result.current.rekey(OLD, BOOK))

    await settled()
    expect(result.current.all.map((one) => one.bookId)).toEqual([BOOK])
  })

  it('go to the store the view is given now, not the one it was first given', async () => {
    const first = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const second = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const { result, rerender } = renderHook(({ store }) => useMarks(store, BOOK), {
      initialProps: { store: first },
    })
    rerender({ store: second })

    let mark = createMark(highlight())
    await act(async () => {
      await second.open(BOOK)
      mark = result.current.add(highlight())
    })

    expect((await second.forBook(BOOK)).map((one) => one.id)).toEqual([mark.id])
    expect(await first.forBook(BOOK)).toEqual([])
  })
})

/* COUNTED, NOT FLAGGED: two overlapping scans must not let the first to land
   declare the second done, or the panel says "Nothing kept yet" over a library
   it is still reading. */
describe('a cross-book scan', () => {
  it('is running from the moment it is asked for until the last one lands', async () => {
    const scans: (() => void)[] = []
    const store = {
      ...createMarkStore({ fs: null, queue: writeQueue() }),
      loadAll: () => new Promise<void>((resolve) => scans.push(resolve)),
    }
    const { result } = renderHook(() => useMarks(store, null))
    expect(result.current.scanning).toBe(false)

    act(() => result.current.loadAll())
    expect(result.current.scanning).toBe(true)

    act(() => result.current.loadAll())
    await act(async () => scans[0]!())
    expect(result.current.scanning, 'the first scan to land declared the second one done').toBe(true)

    await act(async () => scans[1]!())
    expect(result.current.scanning).toBe(false)
  })
})
