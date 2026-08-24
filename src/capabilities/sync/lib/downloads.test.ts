import { describe, expect, it, vi } from 'vitest'
import { createDownloads, describeDownload } from './downloads'

/**
 * WHAT A DOWNLOAD SAYS ABOUT ITSELF, and to whom.
 *
 * This replaced a list in Settings that rendered "Transfer 1 — done" twenty
 * rows deep. That surface was not badly worded: `TransferProgress` carried no
 * book, so no wording could have named one.
 *
 * THE MATCHING IS GONE, and that is the point of this file's second version.
 * Progress used to arrive on a global stream and be attributed to a book by
 * BLOB FOLDER — and a book's cover lives in the same folder as its content,
 * derived by the same `blobFolderOf`, so a jacket fetched mid-download drove
 * the reader's progress line and its terminal event cleared the row early. The
 * old tests could not catch it: the "a cover the cache fetched on its own"
 * case passed a DIFFERENT folder, which is the one arrangement where folder
 * matching works. Each fetch now reports through its own `onProgress`, so
 * there is nothing left to attribute.
 */

describe('what is coming down right now', () => {
  it('answers the click before any byte arrives', () => {
    /* The reader pressed Download. A row that says nothing until the first
       event lands reads as a click that did nothing. */
    const downloads = createDownloads()
    downloads.expect('bk1')
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
  })

  it('takes the bytes its own transfer reports', () => {
    const downloads = createDownloads()
    downloads.expect('bk1')
    downloads.progress('bk1', 512, 2048)
    expect(downloads.of('bk1')).toEqual({ received: 512, total: 2048 })
  })

  it('cannot be driven by a book nobody asked about', () => {
    /* There is no global stream to mis-attribute any more, but the store must
       still refuse a report for a book it is not watching — a late frame from
       a download whose caller gave up would otherwise put the row back. */
    const downloads = createDownloads()
    downloads.expect('bk1')
    downloads.progress('bk2', 9, 9)
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
    expect(downloads.of('bk2')).toBeNull()
  })

  it('is not revived by a frame that arrives after it was forgotten', () => {
    /* `downloadAction` forgets in a `finally`; the transport can emit once
       more on the way down. A row saying "Downloading…" for ever is worse
       than the failure it hides. */
    const downloads = createDownloads()
    downloads.expect('bk1')
    downloads.forget('bk1')
    downloads.progress('bk1', 1, 2)
    expect(downloads.of('bk1')).toBeNull()
  })

  it('tracks two books at once without crossing them', () => {
    const downloads = createDownloads()
    downloads.expect('bk1')
    downloads.expect('bk2')
    downloads.progress('bk2', 3, 10)
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
    expect(downloads.of('bk2')).toEqual({ received: 3, total: 10 })
  })

  it('keeps two books in the same folder apart', () => {
    /* THE CASE THE OLD DESIGN COULD NOT EXPRESS. Content and cover share a
       folder, so folder matching had no way to tell them apart; keyed by the
       book that asked, the question does not arise. */
    const downloads = createDownloads()
    downloads.expect('bk1')
    downloads.progress('bk1', 100, 1000)
    /* A cover fetch for the SAME book reports nowhere — it has no `expect`,
       and it is not this book's content. */
    downloads.progress('bk1-cover', 5, 5)
    expect(downloads.of('bk1')).toEqual({ received: 100, total: 1000 })
  })

  it('tells the shelf when to ask again, and stops when unsubscribed', () => {
    const downloads = createDownloads()
    const listener = vi.fn()
    const off = downloads.subscribe(listener)
    downloads.expect('bk1')
    downloads.progress('bk1', 1, 2)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    downloads.forget('bk1')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not wake the shelf for a report it ignored', () => {
    /* The shelf re-asks every visible row when this fires. A store that
       published on every stray frame would walk 1,962 rows to say nothing. */
    const downloads = createDownloads()
    const listener = vi.fn()
    downloads.subscribe(listener)
    downloads.progress('unknown', 1, 2)
    downloads.forget('unknown')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the sentence on the row', () => {
  it('gives a percentage when a total is known', () => {
    expect(describeDownload({ received: 512, total: 2048 })).toEqual({
      label: 'Downloading 25%',
      fraction: 0.25,
    })
  })

  it('says only that it is downloading when no total has arrived', () => {
    /* "0%" on a fetch that has merely not reported yet reads as stalled. */
    expect(describeDownload({ received: 0, total: 0 })).toEqual({ label: 'Downloading…' })
  })

  it('never reports more than the whole', () => {
    /* A resumed transfer counts bytes already on disk; the arithmetic can
       exceed the expected size, and "Downloading 103%" is a bug on screen. */
    expect(describeDownload({ received: 30, total: 20 }).fraction).toBe(1)
  })

  it('reserves 100% for a download that has finished', () => {
    /* Rounding said "Downloading 100%" at 999 of 1000 bytes and then sat
       there — the one number a reader reads as "done", shown while it was
       not. */
    expect(describeDownload({ received: 999, total: 1000 }).label).toBe('Downloading 99%')
    expect(describeDownload({ received: 1000, total: 1000 }).label).toBe('Downloading 100%')
  })
})
