import { describe, expect, it } from 'vitest'
import { createKernelServices, type BookRecord } from '../../../kernel'
import { crashableFs, memoryStorage } from '../lib/journalFs.testkit'
import { createSyncStatus } from '../lib/status'
import { createStorageModel, dropDownloadSize, readDownloadSizes, recordDownloadSize } from './storageModel'

/**
 * WI-C.5 — the Storage section's logic, no React: downloads listed from the
 * shelf rows that hold bytes, sizes from the download ledger (an honest
 * null for a copy that predates it), removal delegated and the row updated,
 * the status line mirrored from the status store.
 */

const rec = (title: string): BookRecord => ({ title, author: 'A', addedAt: 1, ext: 'epub' })

async function world() {
  const fs = crashableFs()
  const storage = memoryStorage()
  const services = createKernelServices({ fs, storage })
  const status = createSyncStatus()
  const removed: string[] = []
  const model = createStorageModel({
    services,
    coverCache: null,
    status,
    removeDownload: async (book) => {
      removed.push(book)
      const folder = `book_${book.slice('book:'.length)}`
      await fs.remove(`books/${folder}/content.epub`)
      /* The ACTION owns the size row (`removeDownloadAction` drops it after
       * the ledger delete) — this fake mirrors that ownership, and the model
       * must not drop it a second time. */
      await dropDownloadSize(fs, book)
      await services.library.refreshContent(book)
    },
  })
  const seed = async (book: string, withBytes: boolean) => {
    await services.library.add(book, rec(book))
    if (withBytes) {
      const folder = `book_${book.slice('book:'.length)}`
      await fs.writeFile(`books/${folder}/content.epub`, new TextEncoder().encode(book))
      await services.library.refreshContent(book)
    }
  }
  return { fs, services, status, model, removed, seed }
}

describe('the storage model', () => {
  it('lists books with bytes, sizes from the ledger, null for the unrecorded', async () => {
    const w = await world()
    await w.seed('book:a', true)
    await w.seed('book:b', true)
    await w.seed('book:c', false)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    const rows = w.model.getSnapshot().downloads
    expect(rows.map((r) => r.book).sort()).toEqual(['book:a', 'book:b'])
    expect(rows.find((r) => r.book === 'book:a')?.size).toBe(12345)
    expect(rows.find((r) => r.book === 'book:b')?.size).toBeNull()
  })

  it('remove download delegates — the action owns the ledger row — and refreshes', async () => {
    const w = await world()
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    await w.model.removeDownload('book:a')
    expect(w.removed).toEqual(['book:a'])
    expect(await readDownloadSizes(w.fs)).toEqual({})
    expect(w.model.getSnapshot().downloads).toEqual([])
  })

  it('the download ledger round-trips and tolerates junk', async () => {
    const w = await world()
    await recordDownloadSize(w.fs, 'book:a', 10)
    await recordDownloadSize(w.fs, 'book:b', 20)
    await dropDownloadSize(w.fs, 'book:a')
    expect(await readDownloadSizes(w.fs)).toEqual({ 'book:b': 20 })
    await w.fs.writeFile('sync/downloads.json', new TextEncoder().encode('not json'))
    expect(await readDownloadSizes(w.fs)).toEqual({})
  })

  it('mirrors the status store', async () => {
    const w = await world()
    w.status.set({ state: 'degraded', detail: "Paper on your Mac isn't reachable" })
    expect(w.model.getSnapshot().status.state).toBe('degraded')
    expect(w.model.getSnapshot().status.detail).toMatch(/isn't reachable/)
  })
})
