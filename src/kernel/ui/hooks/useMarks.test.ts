// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { recordPath } from '../../core/bookFolder'
import { fakeFs } from '../../core/indexFsFake.testkit'
import { createMarkStore } from '../../core/markStore'
import { bookmarkFrom, createMark, type NewMark } from '../../core/marks'
import { writeQueue } from '../../core/writeQueue'
import { MarksScanFailed, useMarks } from './useMarks'

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

describe('every mark, for something that is about to write a file', () => {
  afterEach(cleanup)

  it('refuses to answer at all when the scan failed', async () => {
    const store = createMarkStore({ fs: unlistableShelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))

    await act(async () => {
      /* THE ONE OUTCOME WORTH REFUSING is this resolving with `[]`: an empty
         answer becoming a file on disk, over the backup it was replacing. */
      await expect(result.current.loadAllNow()).rejects.toBeInstanceOf(MarksScanFailed)
    })
    /* And the store still says so, for the panel that draws rather than
       writes — the two readings of one scan must not disagree. */
    expect(result.current.scanFailed).toBe(true)
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
      everyMark = await result.current.loadAllNow()
    })
    /* BOTH CLASSES. They share a file and are split at the snapshot, and an
       archive of one half is a backup that silently drops the other. */
    expect(everyMark.map((mark) => mark.kind).sort()).toEqual(['bookmark', 'highlight'])
    expect(result.current.scanFailed).toBe(false)
  })

  /* ⚠️ AND AN EMPTY LIBRARY IS STILL AN ANSWER. The whole point is telling the
     two apart; a refusal that fired for both would delete the feature while
     passing the first test in this file. */
  it('answers with nothing for a library that holds nothing', async () => {
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })
    const { result } = renderHook(() => useMarks(store, BOOK))

    let everyMark: readonly unknown[] = ['not asked']
    await act(async () => {
      everyMark = await result.current.loadAllNow()
    })
    expect(everyMark).toEqual([])
    expect(result.current.scanFailed).toBe(false)
  })
})
