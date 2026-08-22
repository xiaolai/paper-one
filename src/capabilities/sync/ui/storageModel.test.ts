import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKernelServices, type BookRecord } from '../../../kernel'
import { crashableFs, memoryStorage } from '../lib/journalFs.testkit'
import { COVER_CAP_SETTING } from '../lib/coverCache'
import { createSyncStatus } from '../lib/status'
import {
  COVER_CAP_MAX_MB,
  COVER_CAP_MIN_MB,
  MAX_SHOWN,
  createStorageModel,
  dropDownloadSize,
  readDownloadSizes,
  recordDownloadSize,
} from './storageModel'

/**
 * WI-C.5 — the Storage section's logic, no React: downloads listed from the
 * DOWNLOAD LEDGER (a copy that predates it is not listed at all, because a
 * row here carries a button that deletes bytes), removal delegated and the
 * row updated, the status line mirrored from the status store.
 *
 * The header used to say a pre-ledger download is listed with a `null` size.
 * It is not, and `DownloadRow.size` is a plain number — the model excludes
 * those rows entirely, for the reason given on `collect`.
 */

const rec = (title: string): BookRecord => ({ title, author: 'A', addedAt: 1, ext: 'epub' })

/**
 * A model over a fake shelf.
 *
 * `removeDownload` is the DELEGATE, and by default it does exactly what the
 * real action does — delete the bytes AND the ledger row, because the action
 * owns both. `options.removeDownload` replaces it, which is how the tests
 * below separate "the model dropped the row" from "the delegate did".
 */
function world(options: { removeDownload?: (book: string) => Promise<void> } = {}) {
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
      if (options.removeDownload) return options.removeDownload(book)
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
   * an Evict button that deletes the book's content file. The pane
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
    const w = world()
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    await w.model.removeDownload('book:a')
    expect(w.removed).toEqual(['book:a'])
    expect(await readDownloadSizes(w.fs)).toEqual({})
    expect(w.model.getSnapshot().downloads).toEqual([])
  })

  /**
   * THE MODEL MUST NOT DROP THE LEDGER ROW ITSELF.
   *
   * The test above cannot see the difference: its delegate deletes the row,
   * so an empty ledger afterwards is satisfied whether the model dropped it
   * or the action did — and it would keep passing if the action stopped
   * deleting it, or if the model started deleting it twice. Here the
   * delegate deletes ONLY the bytes, so the row surviving is the assertion.
   */
  it('leaves the ledger row to the delegate, deleting nothing itself', async () => {
    const w = world({
      removeDownload: async (book) => {
        await w.fs.remove(`books/book_${book.slice('book:'.length)}/content.epub`)
        await w.services.library.refreshContent(book)
      },
    })
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    await w.model.removeDownload('book:a')
    /* The model did not touch it. */
    expect(await readDownloadSizes(w.fs)).toEqual({ 'book:a': 12345 })
    /* And the row is gone from the pane anyway, because the BYTES are gone —
     * which is the rule `collect` applies and the reason a stale ledger row
     * cannot produce a button that deletes nothing. */
    expect(w.model.getSnapshot().downloads).toEqual([])
  })

  /**
   * A REMOVAL THAT FAILED MUST SAY SO, and must not leave the pane stuck.
   *
   * `busy` names the row the spinner belongs to and `failure` is what the
   * reader is told. Neither had a test: a delegate that rejected could have
   * left `busy` set forever — every subsequent row disabled — with no message
   * explaining why nothing happened.
   */
  it('publishes busy, reports a failed removal, and clears busy either way', async () => {
    const seen: { busy: string | null; failure: string | null }[] = []
    const w = world({
      removeDownload: async () => {
        throw new Error('the file is locked')
      },
    })
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 12345)
    await w.model.refresh()
    w.model.subscribe(() => {
      const snap = w.model.getSnapshot()
      seen.push({ busy: snap.busy, failure: snap.failure })
    })

    /* IT DOES NOT REJECT. The pane's click handler is not a place to put a
     * catch, and an unhandled rejection there is a blank screen. */
    await expect(w.model.removeDownload('book:a')).resolves.toBeUndefined()

    /* The row was marked busy while it ran... */
    expect(seen.some((one) => one.busy === 'book:a')).toBe(true)
    /* ...the reason is on the snapshot... */
    expect(w.model.getSnapshot().failure).toMatch(/locked/)
    /* ...and nothing is left busy. */
    expect(w.model.getSnapshot().busy).toBeNull()
    /* The row is still there, because the bytes still are. */
    expect(w.model.getSnapshot().downloads.map((one) => one.book)).toEqual(['book:a'])
  })

  it('clears a previous failure when the next removal starts', async () => {
    let fail = true
    const w = world({
      removeDownload: async (book) => {
        if (fail) throw new Error('the file is locked')
        await w.fs.remove(`books/book_${book.slice('book:'.length)}/content.epub`)
        await dropDownloadSize(w.fs, book)
        await w.services.library.refreshContent(book)
      },
    })
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 1)
    await w.model.refresh()
    await w.model.removeDownload('book:a')
    expect(w.model.getSnapshot().failure).toMatch(/locked/)
    fail = false
    await w.model.removeDownload('book:a')
    expect(w.model.getSnapshot().failure).toBeNull()
    expect(w.model.getSnapshot().downloads).toEqual([])
  })

  /* WITH NO DELEGATE — before sync has started — the verb is a no-op rather
   * than a crash, and says nothing that would make the reader think a
   * removal happened. */
  it('does nothing when no removal delegate is wired', async () => {
    const fs = crashableFs()
    const services = createKernelServices({ fs, storage: memoryStorage() })
    const model = createStorageModel({ services, coverCache: null, status: createSyncStatus(), removeDownload: null })
    await expect(model.removeDownload('book:a')).resolves.toBeUndefined()
    expect(model.getSnapshot().busy).toBeNull()
    expect(model.getSnapshot().failure).toBeNull()
  })

  it('the download ledger round-trips and tolerates junk', async () => {
    const w = world()
    await recordDownloadSize(w.fs, 'book:a', 10)
    await recordDownloadSize(w.fs, 'book:b', 20)
    await dropDownloadSize(w.fs, 'book:a')
    expect(await readDownloadSizes(w.fs)).toEqual({ 'book:b': 20 })
    await w.fs.writeFile('sync/downloads.json', new TextEncoder().encode('not json'))
    expect(await readDownloadSizes(w.fs)).toEqual({})
  })

  /**
   * VALID JSON OF THE WRONG SHAPE, which is what a hand-edited or
   * half-migrated ledger actually looks like — the syntax check above never
   * sees any of these.
   */
  it('drops corrupt entries individually and refuses a document that is not a ledger', async () => {
    const w = world()
    const write = (value: unknown) => w.fs.writeFile('sync/downloads.json', new TextEncoder().encode(JSON.stringify(value)))

    /* Not an object at all: there is nothing here to preserve. */
    for (const whole of [[1, 2, 3], null, 42, 'downloads', true]) {
      await write(whole)
      expect(await readDownloadSizes(w.fs), JSON.stringify(whole)).toEqual({})
    }

    /* An object WITH good rows in it: the bad ones go, the good ones stay. A
     * whole-document refusal here would throw away the reader's real
     * entries over one garbled neighbour. */
    await write({
      good: 100,
      zero: 0,
      text: '100',
      negative: -1,
      fractional: 1.5,
      nan: Number.NaN,
      huge: 2 ** 53,
      list: [1],
      nested: { size: 5 },
      nothing: null,
      alsoGood: 7,
    })
    expect(await readDownloadSizes(w.fs)).toEqual({ good: 100, zero: 0, alsoGood: 7 })
  })

  /**
   * ABSENT IS AN EMPTY LEDGER; UNREADABLE IS NOT.
   *
   * Both used to answer `{}` — and the writers are read-modify-write, so the
   * next `recordDownloadSize` persisted that empty object over the whole
   * ledger. One transient read error erased every download this device had
   * recorded, and the pane stopped offering to reclaim any of them.
   */
  it('throws rather than reading an unreadable ledger as an empty one', async () => {
    const w = world()
    await recordDownloadSize(w.fs, 'book:a', 10)
    const real = w.fs.readFile.bind(w.fs)
    w.fs.readFile = async (path: string) => {
      if (path === 'sync/downloads.json') throw new Error('EIO')
      return real(path)
    }
    await expect(readDownloadSizes(w.fs)).rejects.toThrow(/EIO/)
    /* AND THE WRITER DOES NOT CLOBBER IT. The entry survives the failed
     * write, which is the whole point of the distinction. */
    await expect(recordDownloadSize(w.fs, 'book:b', 20)).rejects.toThrow(/EIO/)
    w.fs.readFile = real
    expect(await readDownloadSizes(w.fs)).toEqual({ 'book:a': 10 })
  })

  /**
   * THE WRITERS ARE SERIALISED, and nothing measured it.
   *
   * `recordDownloadSize` and `dropDownloadSize` are each a read-modify-write
   * over one file. Run concurrently without the queue, the later read sees
   * the earlier state and the later write erases the entry between them —
   * and both would collide on the same `.writing` neighbour.
   */
  it('does not lose an entry when many writers run at once', async () => {
    const w = world()
    await Promise.all(Array.from({ length: 25 }, (_one, at) => recordDownloadSize(w.fs, `book:${at}`, at + 1)))
    const held = await readDownloadSizes(w.fs)
    expect(Object.keys(held)).toHaveLength(25)
    expect(held['book:24']).toBe(25)

    /* And interleaved drops leave exactly the untouched half. */
    await Promise.all(Array.from({ length: 25 }, (_one, at) => (at % 2 === 0 ? dropDownloadSize(w.fs, `book:${at}`) : recordDownloadSize(w.fs, `book:${at}`, 99))))
    const after = await readDownloadSizes(w.fs)
    expect(Object.keys(after)).toHaveLength(12)
    expect(Object.values(after).every((size) => size === 99)).toBe(true)
  })

  /* THE QUEUE SURVIVES A FAILED WRITE. A rejected task must not wedge the
   * chain — every later write would hang forever behind it. */
  it('keeps writing after one write fails', async () => {
    const w = world()
    const real = w.fs.writeFile.bind(w.fs)
    let boom = true
    w.fs.writeFile = async (path: string, bytes: Uint8Array) => {
      if (boom && path.startsWith('sync/downloads.json')) {
        boom = false
        throw new Error('ENOSPC')
      }
      return real(path, bytes)
    }
    await expect(recordDownloadSize(w.fs, 'book:a', 1)).rejects.toThrow(/ENOSPC/)
    await recordDownloadSize(w.fs, 'book:b', 2)
    expect(await readDownloadSizes(w.fs)).toEqual({ 'book:b': 2 })
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
    /* The whole group runs on a fake clock; the seeds do real filesystem work
     * on the microtask queue, which `advanceTimersByTimeAsync` still drains. */
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

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

    /**
     * Let every scheduled read fire.
     *
     * FAKE TIMERS, not a real 400 ms sleep. Three of these added over a
     * second to the suite and coupled it to a private debounce constant —
     * lengthen `REFRESH_QUIET_MS` and the tests do not fail, they go quietly
     * wrong. Advancing the clock is exact: nothing can still be pending
     * afterwards, whatever the constant is.
     */
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(60_000)
      /* And let the refresh's own async work run to completion. */
      await vi.advanceTimersByTimeAsync(0)
    }

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

    /**
     * An explicit `refresh` is IMMEDIATE — not merely eventual.
     *
     * Awaiting it and then asserting proves it happened, not that it happened
     * without waiting for the debounce: a refresh mistakenly routed through
     * the timer would satisfy that too, because awaiting the promise is what
     * the test does either way. On a fake clock that never advances, only a
     * genuinely immediate read can resolve.
     */
    it('still refreshes at once when asked directly', async () => {
      const w = await watched()
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 99)
      const before = w.reads()
      /* NOT advancing the clock: if this were debounced it would never
       * resolve, and the test would time out rather than pass. */
      await w.model.refresh()
      expect(w.reads() - before).toBe(1)
      expect(w.model.getSnapshot().downloads[0]?.size).toBe(99)
    })

    /**
     * AT MOST ONE READ IN FLIGHT, AND ONE FOLLOW-UP — the contract the
     * coalescing loop exists for, and the half nothing tested.
     *
     * Two refreshes overlapping must not both scan; the second must be folded
     * into a single follow-up pass so that a caller awaiting EITHER promise
     * gets a snapshot taken after its own change. A test that only fires them
     * sequentially never enters the branch.
     */
    it('collapses overlapping refreshes into one read and one follow-up', async () => {
      const w = await watched()
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 1)
      const before = w.reads()

      /* Four at once, none awaited yet: one is reading, the rest fold into a
       * single follow-up. */
      const all = [w.model.refresh(), w.model.refresh(), w.model.refresh(), w.model.refresh()]
      await Promise.all(all)
      expect(w.reads() - before).toBe(2)
      /* Every caller got the same settled promise. */
      expect(new Set(all).size).toBeLessThanOrEqual(2)
    })

    /**
     * A SECOND `refresh` DURING A READ GETS A SNAPSHOT TAKEN AFTER ITS OWN
     * CHANGE — the promise it holds resolves on the FOLLOW-UP pass, not on
     * the read that was already in flight and predates it.
     *
     * This is the coalescing loop's actual guarantee, and the reason the
     * second caller is not simply handed the in-flight promise and told the
     * answer is current.
     */
    it('gives a caller who arrives mid-read a snapshot that includes their change', async () => {
      const w = await watched()
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 1)

      const real = w.fs.readFile.bind(w.fs)
      let second: Promise<void> | null = null
      /* The flag flips BEFORE the awaits below: the seed reads this same file,
       * so a guard set afterwards re-enters forever. */
      let injecting = false
      w.fs.readFile = async (path: string) => {
        const answer = await real(path)
        if (!injecting && second === null && path === 'sync/downloads.json') {
          injecting = true
          /* A download lands while the first read is in flight, and its own
           * refresh is asked for. */
          await w.seed('book:b', true)
          await recordDownloadSize(w.fs, 'book:b', 2)
          second = w.model.refresh()
        }
        return answer
      }
      await w.model.refresh()
      await second
      expect(w.model.getSnapshot().downloads.map((one) => one.book).sort()).toEqual(['book:a', 'book:b'])
    })

    /**
     * A SHELF CHANGE ARRIVING MID-READ IS REMEMBERED, NOT LOST.
     *
     * It does not force an immediate second scan — that is the debounce's
     * job — but `stale` has to survive the read that was already running, or
     * the change is dropped until something else happens to write.
     */
    it('remembers a shelf change that arrived while it was reading', async () => {
      const w = await watched()
      w.model.subscribe(() => {})
      await w.seed('book:a', true)
      await recordDownloadSize(w.fs, 'book:a', 1)
      await settle()

      const real = w.fs.readFile.bind(w.fs)
      let injected = false
      w.fs.readFile = async (path: string) => {
        const answer = await real(path)
        if (!injected && path === 'sync/downloads.json') {
          /* Set BEFORE the awaits: the seed reads this same file. */
          injected = true
          await w.seed('book:b', true)
          await recordDownloadSize(w.fs, 'book:b', 2)
        }
        return answer
      }
      await w.model.refresh()
      /* Not yet — the debounce has not fired. */
      expect(w.model.getSnapshot().downloads.map((one) => one.book)).toEqual(['book:a'])
      await settle()
      expect(w.model.getSnapshot().downloads.map((one) => one.book).sort()).toEqual(['book:a', 'book:b'])
    })

    /**
     * `dispose` DETACHES, and a pending read does not fire after it.
     *
     * The model is built when the capability starts and outlives any pane, so
     * a subscription it never lets go of is a leak that keeps two filesystem
     * reads running per shelf write for the rest of the session.
     */
    it('stops reading once disposed, including a refresh already scheduled', async () => {
      const w = await watched()
      w.model.subscribe(() => {})
      await w.seed('book:a', true)
      const before = w.reads()
      /* A read is now scheduled behind the debounce. */
      w.model.dispose()
      await settle()
      expect(w.reads() - before).toBe(0)
      /* And a later shelf write reaches nobody. */
      await w.seed('book:b', true)
      await settle()
      expect(w.reads() - before).toBe(0)
    })

    /* UNSUBSCRIBING IS ENOUGH ON ITS OWN. The last listener leaving puts the
     * model back to reading nothing, which is what makes closing the Settings
     * pane stop the cost rather than merely hide it. */
    it('stops reading when the last listener unsubscribes', async () => {
      const w = await watched()
      const off = w.model.subscribe(() => {})
      await w.seed('book:a', true)
      await settle()
      const before = w.reads()
      off()
      await w.seed('book:b', true)
      await settle()
      expect(w.reads() - before).toBe(0)
    })
  })

  /**
   * THE LIST IS BOUNDED, AND THE COUNT IS NOT.
   *
   * Every download was published and every one rendered. A satchel holding a
   * few hundred books paid for a few hundred DOM rows every time Settings
   * opened, and again on every shelf write while it stayed open — for a list
   * nobody scrolls to the end of.
   */
  it('publishes at most MAX_SHOWN rows, biggest first, and the true total', async () => {
    const w = world()
    const many = MAX_SHOWN + 20
    for (let at = 0; at < many; at += 1) {
      await w.seed(`book:${at}`, true)
      /* Ascending sizes, so the largest are the LAST seeded — a bound that
       * simply took the first fifty would show the smallest. */
      await recordDownloadSize(w.fs, `book:${at}`, at + 1)
    }
    await w.model.refresh()
    const snap = w.model.getSnapshot()
    expect(snap.downloadCount).toBe(many)
    expect(snap.downloads).toHaveLength(MAX_SHOWN)
    expect(snap.downloads[0]?.size).toBe(many)
    expect(snap.downloads.at(-1)?.size).toBe(many - MAX_SHOWN + 1)
  })

  it('shows everything when there is little, and says the count once', async () => {
    const w = world()
    await w.seed('book:a', true)
    await recordDownloadSize(w.fs, 'book:a', 10)
    await w.model.refresh()
    expect(w.model.getSnapshot().downloads).toHaveLength(1)
    expect(w.model.getSnapshot().downloadCount).toBe(1)
  })

  /* TIES BROKEN BY BOOK ID, so two reads of an unchanged library agree — a
   * pane that reordered itself on every refresh would be unusable. */
  it('answers the same order twice for equal sizes', async () => {
    const w = world()
    for (const id of ['book:c', 'book:a', 'book:b']) {
      await w.seed(id, true)
      await recordDownloadSize(w.fs, id, 100)
    }
    await w.model.refresh()
    const first = w.model.getSnapshot().downloads.map((one) => one.book)
    await w.model.refresh()
    expect(w.model.getSnapshot().downloads.map((one) => one.book)).toEqual(first)
    expect(first).toEqual(['book:a', 'book:b', 'book:c'])
  })

  it('mirrors the status store', async () => {
    const w = await world()
    w.status.set({ state: 'degraded', detail: "Paper on your Mac isn't reachable" })
    expect(w.model.getSnapshot().status.state).toBe('degraded')
    expect(w.model.getSnapshot().status.detail).toMatch(/isn't reachable/)
  })
})

/**
 * THE CAP IS A NUMBER OF WHOLE MEGABYTES IN A RANGE, and the guard used to be
 * only `> 0`.
 *
 * A fractional cap holds no cover at all, and one large enough to overflow the
 * byte total it is compared against stops eviction happening — both silent,
 * and the second grows the cache without bound while the arithmetic says it is
 * under the limit. The UI's half-typed values reach here too: the field
 * commits on blur rather than per keystroke, but a refusal is what makes a
 * typo harmless rather than destructive.
 */
/**
 * A model over a real settings store AND a recording cover cache.
 *
 * Every fixture in this file passed `coverCache: null`, so the half of
 * `setCoverCapMB` that matters — it EVICTS after changing the cap — never
 * ran: the tests proved the number was stored and nothing about the deletion
 * the number authorises.
 */
async function capModel() {
  const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage() })
  const evictions: number[] = []
  let bytes = 0
  const model = createStorageModel({
    services,
    coverCache: {
      ensure: async () => true,
      index: async () => ({}),
      totalBytes: async () => bytes,
      /* Records the cap AS IT STANDS WHEN EVICTION RUNS — the assertion below
       * is about ordering, not merely that eviction happened. */
      evict: async () => {
        evictions.push(services.settings.get(COVER_CAP_SETTING))
      },
    },
    status: createSyncStatus(),
    removeDownload: async () => {},
  })
  return { model, settings: services.settings, evictions, setBytes: (n: number) => (bytes = n) }
}

describe('the cover cache cap', () => {
  it('refuses values outside the range and leaves the setting alone', async () => {
    const { model, settings } = await capModel()
    const before = settings.get(COVER_CAP_SETTING)
    for (const bad of [0, 0.5, -10, Number.NaN, Number.POSITIVE_INFINITY, COVER_CAP_MAX_MB + 1]) {
      await model.setCoverCapMB(bad)
      expect(settings.get(COVER_CAP_SETTING)).toBe(before)
    }
  })

  it('evicts against the NEW cap, not the old one', async () => {
    const { model, evictions } = await capModel()
    await model.setCoverCapMB(42)
    /* The eviction has to see the value that was just committed — running it
     * before the write would enforce the previous cap and leave the cache
     * over the new one until something else happened to trigger a sweep. */
    expect(evictions).toEqual([42])
  })

  it('does not evict when the value is refused', async () => {
    const { model, evictions } = await capModel()
    await model.setCoverCapMB(0)
    expect(evictions).toEqual([])
  })

  it('accepts a value in range, rounded to whole megabytes', async () => {
    const { model, settings } = await capModel()
    await model.setCoverCapMB(250.4)
    expect(settings.get(COVER_CAP_SETTING)).toBe(250)
    await model.setCoverCapMB(COVER_CAP_MIN_MB)
    expect(settings.get(COVER_CAP_SETTING)).toBe(COVER_CAP_MIN_MB)
  })
})

/**
 * A REJECTION IS PUBLISHED, not discarded.
 *
 * Every action in the pane used to drop its promise with `void`, so a failed
 * eviction or a cap that would not persist left the UI exactly as it was —
 * the reader pressed the button, saw the row stay, and had no way to tell a
 * refusal from a no-op.
 */
describe('failures reach the snapshot', () => {
  it('publishes a failed eviction and clears it on the next attempt', async () => {
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage() })
    let fail = true
    const model = createStorageModel({
      services,
      coverCache: null,
      status: createSyncStatus(),
      removeDownload: async () => {
        if (fail) throw new Error('the folder would not delete')
      },
    })
    await model.removeDownload('book:x')
    expect(model.getSnapshot().failure).toContain('would not delete')

    fail = false
    await model.removeDownload('book:x')
    expect(model.getSnapshot().failure).toBeNull()
  })

  it('leaves `busy` clear after a failure, so the row is not stuck', async () => {
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage() })
    const model = createStorageModel({
      services,
      coverCache: null,
      status: createSyncStatus(),
      removeDownload: async () => {
        throw new Error('nope')
      },
    })
    await model.removeDownload('book:x')
    expect(model.getSnapshot().busy).toBeNull()
  })
})
