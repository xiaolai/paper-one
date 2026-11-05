import { describe, expect, it, vi } from 'vitest'
import { ARCHIVE_MAX_BYTES, type Card, type FilePicker, type IndexedBook, type Mark, type PickedFile } from '../../../kernel'
import { ArchiveOverLimit } from './marksArchive'
import { exportMarksToFile, importMarksFromFile } from './marksFiles'
import { exportTagsToFile, importTagsFromFile } from './tagFiles'

/**
 * The file half of both archives, over the kernel's picker. This half used to sit
 * behind the dialog and fs plugins, where no test reached it; a picker is a plain
 * object, so what it asks for and what it does with the answer can be pinned.
 */

const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
const BOOKS = [{ bookId: 'b1', title: 'A Book', author: 'Someone', tags: ['Sea'] }] as unknown as IndexedBook[]

function picked(name: string, text = '', size = text.length) {
  const writeText = vi.fn(async (_text: string) => {})
  const file: PickedFile = { name, size: async () => size, readText: vi.fn(async () => text), writeText }
  return { file, writeText, readText: file.readText }
}

function picker(answer: PickedFile | null) {
  const pickOpen = vi.fn<FilePicker['pickOpen']>(async () => answer)
  const pickSave = vi.fn<FilePicker['pickSave']>(async () => answer)
  return { available: true, pickOpen, pickSave } satisfies FilePicker
}

describe('exporting marginalia', () => {
  it('offers the dated name and both formats, JSON first', async () => {
    const files = picker(null)
    await exportMarksToFile(files, BOOKS, [], [], NOW)
    const [name, filters] = files.pickSave.mock.calls[0]!
    expect(name).toMatch(/^paper-marginalia-\d{4}-\d{2}-\d{2}\.json$/u)
    expect(filters).toEqual([
      { name: 'Paper marginalia', extensions: ['json'] },
      { name: 'Markdown (a reading copy)', extensions: ['md'] },
    ])
  })

  it('answers null for a dismissed dialog, having written nothing', async () => {
    expect(await exportMarksToFile(picker(null), BOOKS, [], [], NOW)).toBeNull()
  })

  it('follows the name the reader typed: JSON by default', async () => {
    const { file, writeText } = picked('mine.json')
    const done = await exportMarksToFile(picker(file), BOOKS, [], [], NOW)
    expect(done).toEqual({ format: 'json', books: 0, marks: 0, cards: 0 })
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ version: 1, books: [] })
  })

  it('follows the name the reader typed: Markdown whatever its capitals', async () => {
    const { file, writeText } = picked('MINE.MD')
    const done = await exportMarksToFile(picker(file), BOOKS, [], [], NOW)
    expect(done?.format).toBe('md')
    expect(() => JSON.parse(writeText.mock.calls[0]![0])).toThrow()
  })

  it('takes Markdown only from the last extension, not from one inside the name', async () => {
    const { file, writeText } = picked('notes.md.json')
    const done = await exportMarksToFile(picker(file), BOOKS, [], [], NOW)
    expect(done?.format).toBe('json')
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ version: 1 })
  })

  it('counts every mark and every card it wrote, a card whose book is gone included', async () => {
    const shelf = [
      { bookId: 'b1', title: 'One', author: '' },
      { bookId: 'b2', title: 'Two', author: '' },
    ] as unknown as IndexedBook[]
    const mark = (id: string, bookId: string) =>
      ({ id, bookId, cfi: 'epubcfi(/6/4)', sectionIndex: 0, text: id, prefix: '', suffix: '', note: '', kind: 'highlight', tint: 'green', style: 'underline', chapter: '', createdAt: 1 }) as unknown as Mark
    const card = (id: string, bookId: string) =>
      ({ id, bookId, kind: 'Recall', body: id, answer: '', source: '', cfi: '', createdAt: 1 }) as unknown as Card
    const { file } = picked('mine.json')
    const done = await exportMarksToFile(
      picker(file),
      shelf,
      [mark('m1', 'b1'), mark('m2', 'b1'), mark('m3', 'b2')],
      [card('c1', 'b1'), card('c2', 'b1'), card('c3', 'b2'), card('c4', 'b2'), card('c5', 'b2'), card('c6', 'gone')],
      NOW,
    )
    expect(done).toEqual({ format: 'json', books: 2, marks: 3, cards: 6 })
  })
})

describe('importing marginalia', () => {
  it('asks for JSON only, because Markdown cannot come back', async () => {
    const files = picker(null)
    expect(await importMarksFromFile(files)).toBeNull()
    expect(files.pickOpen.mock.calls[0]![0]).toEqual([{ name: 'Paper marginalia', extensions: ['json'] }])
  })

  it('hands back the parsed archive, or null for a file that is not one', async () => {
    const good = picked('in.json', JSON.stringify({ version: 1, books: [] }))
    expect(await importMarksFromFile(picker(good.file))).toEqual({ archive: { version: 1, books: [] } })
    const bad = picked('in.json', 'not json')
    expect(await importMarksFromFile(picker(bad.file))).toEqual({ archive: null })
  })

  it('refuses a file past the limit before reading a byte of it', async () => {
    const { file, readText } = picked('in.json', '', ARCHIVE_MAX_BYTES + 1)
    await expect(importMarksFromFile(picker(file))).rejects.toThrow(/That marginalia file/u)
    expect(readText).not.toHaveBeenCalled()
  })

  it('reads a file exactly at the limit', async () => {
    const { file, readText } = picked('in.json', '{}', ARCHIVE_MAX_BYTES)
    await importMarksFromFile(picker(file))
    expect(readText).toHaveBeenCalledTimes(1)
  })
})

describe('exporting tags', () => {
  it('offers the dated name and says whether it wrote', async () => {
    const dismissed = picker(null)
    expect(await exportTagsToFile(dismissed, BOOKS, NOW)).toBe(false)
    const [name, filters] = dismissed.pickSave.mock.calls[0]!
    expect(name).toMatch(/^paper-tags-\d{4}-\d{2}-\d{2}\.json$/u)
    expect(filters).toEqual([{ name: 'Paper tags', extensions: ['json'] }])

    const { file } = picked('t.json')
    expect(await exportTagsToFile(picker(file), BOOKS, NOW)).toBe(true)
  })

  it('refuses a filing too big to read back before any dialog opens', async () => {
    const { file, writeText } = picked('t.json')
    const files = picker(file)
    const huge = [{ ...BOOKS[0], title: 'x'.repeat(ARCHIVE_MAX_BYTES + 1) }] as unknown as IndexedBook[]
    await expect(exportTagsToFile(files, huge, NOW)).rejects.toThrow(ArchiveOverLimit)
    expect(files.pickSave).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('writes a document a person can repair: two spaces of indent', async () => {
    const { file, writeText } = picked('t.json')
    await exportTagsToFile(picker(file), BOOKS, NOW)
    const text = writeText.mock.calls[0]![0]
    expect(text).toContain('\n  "books"')
    expect(JSON.parse(text).books[0].tags).toEqual(['Sea'])
  })
})

describe('importing tags', () => {
  it('asks for the tag kind and hands back what it read', async () => {
    const dismissed = picker(null)
    expect(await importTagsFromFile(dismissed)).toBeNull()
    expect(dismissed.pickOpen.mock.calls[0]![0]).toEqual([{ name: 'Paper tags', extensions: ['json'] }])

    const bad = picked('t.json', 'not json')
    expect(await importTagsFromFile(picker(bad.file))).toEqual({ archive: null })
  })

  it('refuses a file past the limit before reading a byte of it', async () => {
    const { file, readText } = picked('t.json', '', ARCHIVE_MAX_BYTES + 1)
    await expect(importTagsFromFile(picker(file))).rejects.toThrow(/That tags file/u)
    expect(readText).not.toHaveBeenCalled()
  })
})
