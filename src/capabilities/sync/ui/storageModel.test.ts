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
  /* THE LEDGER IS THE LIST. This listed every shelf row holding bytes, which
   * on an imported library is the whole library — and every row carries a
   * Remove download button that deletes the book's content file. The pane
   * offered to delete books the reader had imported themselves. */
  it('lists what the ledger recorded, with its sizes', async () => {
    const w = await world()
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    expect(w.model.getSnapshot().downloads).toEqual([
      { book: 'book:a', title: 'book:a', size: 12345 },
    ])
  })

  it('does not offer to remove a book that was never downloaded', async () => {
    const w = await world()
    // Bytes on this machine, no ledger row: an imported book.
    await w.seed('book:imported', true)
    await w.seed('book:no-bytes', false)
    await w.model.refresh()
    expect(w.model.getSnapshot().downloads).toEqual([])
  })

  /* A ledger row whose bytes have gone — removed outside the app — is not a
   * download anybody can reclaim, and a button that deletes nothing is worse
   * than no button. */
  it('drops a ledger row whose bytes are not here', async () => {
    const w = await world()
    await w.seed('book:a', false)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    expect(w.model.getSnapshot().downloads).toEqual([])
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

  /**
   * WHAT A SHELF WRITE COSTS THIS PANE.
   *
   * `library.subscribe(() => void refresh())` — two filesystem reads and a
   * walk of the whole shelf, per shelf change, for a model built when the
   * capability starts rather than when the pane is opened. A folder import
   * writes one row per book and the parse pass that follows writes them all
   * again, so a two-thousand-book import spent about four thousand of these
   * on a section that was not on screen.
   */
  describe('reading the disk', () => {
    /**
     * Counts reads of the download ledger.
     *
     * MEASURED AS A DELTA around the action, because `recordDownloadSize` is
     * a read-modify-write and reads the same file — counting from zero
     * charged the model for the test's own setup, which is how this first
     * read 2 where 1 was right.
     */
    async function watched() {
      const w = await world()
      let reads = 0
      const base = w.fs.readFile.bind(w.fs)
      w.fs.readFile = async (path: string) => {
        if (path === 'sync/downloads.json') reads += 1
        return base(path)
      }
      return { ...w, reads: () => reads }
    }

    /** Let every scheduled read fire — comfortably past `REFRESH_QUIET_MS`. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

    it('reads nothing when nobody is subscribed', async () => {
      const w = await watched()
      const before = w.reads()
      await w.seed('book:a', true)
      await w.seed('book:b', true)
      await settle()
      expect(w.reads() - before).toBe(0)
    })

    /* Deferred, not dropped: the pane opening must show what happened while
     * it was closed. */
    it('reads once for everything it missed, when somebody subscribes', async () => {
      const w = await watched()
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 10)
      const before = w.reads()
      w.model.subscribe(() => {})
      await settle()
      expect(w.reads() - before).toBe(1)
      expect(w.model.getSnapshot().downloads.map((one) => one.book)).toEqual(['book:a'])
    })

    /* THE BURST. Twenty writes with the pane open is one read, not twenty. */
    it('reads once for a burst of shelf writes', async () => {
      const w = await watched()
      w.model.subscribe(() => {})
      const before = w.reads()
      for (let at = 0; at < 20; at += 1) await w.seed(`book:${String(at)}`, true)
      await settle()
      expect(w.reads() - before).toBe(1)
    })

    /* An explicit `refresh` — the pane mounting, a download removed — is
     * still immediate and still sees its own change. */
    it('still refreshes at once when asked directly', async () => {
      const w = await watched()
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 99)
      await w.model.refresh()
      expect(w.model.getSnapshot().downloads[0]?.size).toBe(99)
    })
  })

  it('mirrors the status store', async () => {
    const w = await world()
    w.status.set({ state: 'degraded', detail: "Paper on your Mac isn't reachable" })
    expect(w.model.getSnapshot().status.state).toBe('degraded')
    expect(w.model.getSnapshot().status.detail).toMatch(/isn't reachable/)
  })
})
