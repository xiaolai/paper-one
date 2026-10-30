// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { BookRecord } from '../../core/bookFolder'
import type { BookMeta } from '../../core/bookMeta'
import type { RekeyOutcome } from '../../index'
import { fakeFs } from '../../core/indexFsFake.testkit'
import { useBookIntake } from './useBookIntake'

/**
 * The intake's WIRING to `recordFromMeta` — the rule itself is tested where it
 * lives, in `bookFolder.test.ts`; this is the one thing that suite cannot see,
 * which is whether the reader's open route hands the projection the file it
 * parsed. It did not, and the enrichment pass did not either, so a comic —
 * whose parser titles it after its file — grew an extension per open:
 * "Batman.cbz" → "Batman.cbz.cbz" → …
 *
 * The parse is stood in for by a `BookMeta` whose title is the file's name,
 * which is what `comic-book.js` produces; nothing here needs foliate.
 *
 * `useBookIntake.stability.test.tsx` holds this hook's other invariant and
 * says it is the whole reason that file exists, so this one is beside it
 * rather than in it.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const metaFor = (file: File): BookMeta => ({
  pageCount: 0,
  title: file.name,
  author: '',
  identifier: '',
  sortAs: '',
  series: '',
  seriesIndex: null,
  subjects: [],
  publisher: '',
  published: '',
  languages: [],
  description: '',
  subtitle: '',
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

/** Mount the hook over a parsed file and hand back what it asked `add` to write. */
async function intakeOf(file: File): Promise<Partial<BookRecord>> {
  const added: Partial<BookRecord>[] = []
  function Probe(): ReactNode {
    useBookIntake({
      bookId: 'book:comic',
      meta: metaFor(file),
      source: file,
      generation: 1,
      /* No vault: the intake skips keeping a copy and goes straight to the
         record, which is the only part under test. */
      fs: null,
      add: (_id, record) => void added.push(record),
      keepContent: async () => true,
      rekeyBook: async (): Promise<RekeyOutcome> => 'nothing',
      rekeyMarks: () => {},
      rekeyCards: () => {},
    })
    return null
  }
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(createElement(Probe)))
  /* The intake hashes the file for the legacy id before it writes, so the
     record lands a few ticks after the mount. */
  for (let i = 0; i < 50 && added.length === 0; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
  expect(added, 'the intake never reached add').toHaveLength(1)
  return added[0]!
}

describe('useBookIntake and a parser that names the file', () => {
  it('records a comic under the name the vault will hand back, not the file name plus its extension', async () => {
    const record = await intakeOf(new File([new Uint8Array([0x50, 0x4b])], 'Batman.cbz'))
    expect(record.title).toBe('Batman')
    expect(record.ext).toBe('cbz')
  })

  it('leaves an EPUB’s declared title alone, even when it looks like a file name', async () => {
    const record = await intakeOf(new File([new Uint8Array([0x50, 0x4b])], 'Batman.epub'))
    expect(record.title).toBe('Batman.epub')
  })
})

/**
 * ⚠️ **THE FIRST OPEN OF A BOOK KEPT NO COPY OF IT.**
 *
 * `Library.keepContent` refuses to write unless `book.json` is already there —
 * `atomicWrite` MAKES the folder it writes into, so a content task queued
 * behind a removal would recreate the folder the removal had just carried to
 * the trash. The intake calls it BEFORE the record on purpose, so on a first
 * open it met exactly that refusal and answered `false`; the result was
 * discarded, so nothing said so. Every book opened once was shelved without
 * Paper's own copy: with an origin it still opened through the fallback until
 * the file moved, and with none it was a row that could never be opened.
 *
 * The fake here is the store's rule, not a stand-in for it — a `keepContent`
 * that always answers `true`, which is what the suite had, cannot see this at
 * all.
 */
describe('useBookIntake and its own copy of the book', () => {
  async function opened(): Promise<{ records: Set<string>; kept: string[]; order: string[] }> {
    const file = new File([new Uint8Array([0x50, 0x4b])], 'Moby-Dick.epub')
    const records = new Set<string>()
    const kept: string[] = []
    const order: string[] = []
    const keepContent = async (bookId: string, name: string): Promise<boolean> => {
      /* THE STORE'S OWN RULE. */
      if (!records.has(bookId)) return false
      kept.push(name)
      order.push('content')
      return true
    }
    function Probe(): ReactNode {
      useBookIntake({
        bookId: 'book:moby',
        meta: metaFor(file),
        source: file,
        generation: 1,
        fs: fakeFs({}),
        add: (id) => {
          records.add(id)
          order.push('record')
        },
        keepContent,
        rekeyBook: async (): Promise<RekeyOutcome> => 'nothing',
        rekeyMarks: () => {},
        rekeyCards: () => {},
      })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(Probe)))
    for (let i = 0; i < 50 && kept.length === 0; i++)
      await act(async () => new Promise((r) => setTimeout(r, 5)))
    return { records, kept, order }
  }

  it('writes the bytes for a book that had no record to write into yet', async () => {
    const { kept } = await opened()
    expect(kept, 'the book was shelved with no copy of its own').toEqual(['Moby-Dick.epub'])
  })

  /* The record still goes first on this route, which is what makes the write
     possible at all — and the lane keeps them in that order. */
  it('writes the record before the bytes', async () => {
    const { order } = await opened()
    expect(order).toEqual(['record', 'content'])
  })
})

/**
 * ⚠️ **THE SAME URL OPENED TWICE IS TWO OPENS AND ONE `source`.**
 *
 * The removal baseline was stamped when the SOURCE changed, and `useBook` says
 * in its own words why that is not an identity: `setSource(same)` bails on an
 * unchanged reference, "whereas the generation always advances". So a book
 * opened from a string — `?book=`, the bundled sample, any URL origin —
 * removed, and then opened again handed the intake a source it had already
 * seen. The baseline stayed at the FIRST open, the removal was still
 * `removedSince`, and the guard written for a removal arriving mid-intake
 * refused the reader's deliberate reopen instead.
 */
describe('useBookIntake and the same source opened twice', () => {
  const URL_SOURCE = '/sample.epub'
  const BOOK = 'book:sample'

  async function reopened(): Promise<number> {
    let adds = 0
    let reopen: () => void = () => {}
    let removeIt: () => void = () => {}
    function Probe(): ReactNode {
      const [n, setN] = useState(0)
      reopen = () => setN((was) => was + 1)
      const intake = useBookIntake({
        bookId: BOOK,
        /* A NEW OBJECT PER OPEN, as a fresh parse produces — this is what
           re-runs the intake effect, exactly as it does in the app. */
        meta: { ...metaFor(new File([], 'Sample.epub')), title: `Sample ${n}` },
        source: URL_SOURCE,
        generation: n,
        fs: null,
        add: () => {
          adds += 1
        },
        keepContent: async () => true,
        rekeyBook: async (): Promise<RekeyOutcome> => 'nothing',
        rekeyMarks: () => {},
        rekeyCards: () => {},
      })
      removeIt = () => intake.noteRemoval(BOOK)
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(createElement(Probe)))
    for (let i = 0; i < 50 && adds === 0; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
    expect(adds, 'the first open never reached add').toBe(1)

    /* The reader takes it off the shelf, then asks for the same book again. */
    act(() => removeIt())
    await act(async () => reopen())
    for (let i = 0; i < 50 && adds < 2; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
    return adds
  }

  it('takes the book back in rather than treating the reopen as the removal’s victim', async () => {
    expect(await reopened(), 'the reopen was refused by a stale removal baseline').toBe(2)
  })
})
