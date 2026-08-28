// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { BookRecord } from '../../core/bookFolder'
import type { BookMeta } from '../../core/bookMeta'
import type { RekeyOutcome } from '../../index'
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
