import { describe, expect, it, vi } from 'vitest'
import { createDownloads, describeDownload } from './downloads'
import type { TransferProgress } from '../../peer'

/**
 * WHAT A DOWNLOAD SAYS ABOUT ITSELF, and to whom.
 *
 * This replaced a list in Settings that rendered "Transfer 1 — done" twenty
 * rows deep. That surface was not badly worded: `TransferProgress` carried no
 * book, so no wording could have named one. The plugin's event carries the
 * blob folder now, and these pin the matching — which is the part that can go
 * wrong silently, because an unmatched event simply shows nothing.
 */

const event = (over: Partial<TransferProgress> & { folder: string }): TransferProgress => ({
  transferId: 1,
  received: 0,
  total: 0,
  state: 'running',
  ...over,
})

describe('what is coming down right now', () => {
  it('answers the click before any byte arrives', () => {
    /* The reader pressed Download. A row that says nothing until the first
       event lands reads as a click that did nothing. */
    const downloads = createDownloads()
    downloads.expect('bk1', 'bk1-folder')
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
  })

  it('matches an event to the book that registered its folder', () => {
    const downloads = createDownloads()
    downloads.expect('bk1', 'bk1-folder')
    downloads.apply(event({ folder: 'bk1-folder', received: 512, total: 2048 }))
    expect(downloads.of('bk1')).toEqual({ received: 512, total: 2048 })
  })

  it('ignores a transfer nobody registered', () => {
    /* The cover cache fetches on its own, and a peer's own business is not
       this store's. Guessing at an unregistered folder would put a sentence on
       a book the reader never asked about. */
    const downloads = createDownloads()
    downloads.expect('bk1', 'bk1-folder')
    downloads.apply(event({ folder: 'someone-elses', received: 9, total: 9 }))
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
  })

  it('clears on done AND on failed', () => {
    for (const state of ['done', 'failed'] as const) {
      const downloads = createDownloads()
      downloads.expect('bk1', 'bk1-folder')
      downloads.apply(event({ folder: 'bk1-folder', state, received: 5, total: 5 }))
      expect(downloads.of('bk1')).toBeNull()
    }
  })

  it('forgets a download that produced no event at all', () => {
    /* No session, a refused grant — the fetch fails before the plugin emits
       anything, and a row left saying "Downloading…" forever is worse than the
       failure it hides. `downloadAction` calls this in a `finally`. */
    const downloads = createDownloads()
    downloads.expect('bk1', 'bk1-folder')
    downloads.forget('bk1')
    expect(downloads.of('bk1')).toBeNull()
    /* And the folder goes with it, so a late event cannot revive the row. */
    downloads.apply(event({ folder: 'bk1-folder', received: 1, total: 2 }))
    expect(downloads.of('bk1')).toBeNull()
  })

  it('tracks two books at once without crossing them', () => {
    const downloads = createDownloads()
    downloads.expect('bk1', 'f1')
    downloads.expect('bk2', 'f2')
    downloads.apply(event({ folder: 'f2', received: 3, total: 10 }))
    expect(downloads.of('bk1')).toEqual({ received: 0, total: 0 })
    expect(downloads.of('bk2')).toEqual({ received: 3, total: 10 })
  })

  it('tells the shelf when to ask again, and stops when unsubscribed', () => {
    const downloads = createDownloads()
    const listener = vi.fn()
    const off = downloads.subscribe(listener)
    downloads.expect('bk1', 'f1')
    downloads.apply(event({ folder: 'f1', received: 1, total: 2 }))
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    downloads.apply(event({ folder: 'f1', state: 'done', received: 2, total: 2 }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('does not wake the shelf for an event it ignored', () => {
    /* The shelf re-asks every visible row when this fires. A store that
       published on every stray transfer would walk 1,962 rows to say nothing. */
    const downloads = createDownloads()
    const listener = vi.fn()
    downloads.subscribe(listener)
    downloads.apply(event({ folder: 'unknown', received: 1, total: 2 }))
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
})
