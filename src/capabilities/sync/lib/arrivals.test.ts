import { describe, expect, it } from 'vitest'
import { describeArrival, readArrivals, recordArrival, dropArrival, ARRIVALS_INDEX_PATH } from './arrivals'
import { fakeFs } from '../../../kernel/testkit'

/**
 * WHERE A BOOK CAME FROM, and when the reader stops being told.
 *
 * The shelf fetches the bytes and commits before acking, so a book pushed from
 * a laptop simply APPEARS — complete, and with nothing saying it was not the
 * reader who added it. This is the note that fixes that, and it is
 * deliberately a note rather than a gate: the shelf is the unattended device,
 * and an approval queue there is a book waiting for consent on a machine
 * nobody is looking at.
 *
 * THE KERNEL'S `fakeFs`, not a local one. A second fake written here missed
 * `mkdir` — which `atomicWrite` calls for any path with a separator in it, and
 * `sync/arrivals.json` has one — so every write threw against a filesystem no
 * disk resembles. One fake, or the two drift on what a filesystem does.
 */

describe('the note about where a book came from', () => {
  it('is shown until the reader opens it', () => {
    const arrival = { from: 'Paper on macos', at: 1_000 }
    expect(describeArrival(arrival, {})).toEqual({ label: 'Added from Paper on macos' })
    expect(describeArrival(arrival, { openedAt: 999 })).toEqual({ label: 'Added from Paper on macos' })
  })

  it('goes once they have', () => {
    /* `openedAt` merges as a max across devices, so opening it anywhere
       counts — which is right: the reader knows about the book either way. */
    expect(describeArrival({ from: 'Laptop', at: 1_000 }, { openedAt: 1_001 })).toBeNull()
  })

  it('treats a never-opened book as still worth saying', () => {
    /* The common case for a book that has just landed, and the one this
       exists to cover. An absent `openedAt` must not read as 0 — which is
       older than any arrival, and would silence every notice ever written. */
    expect(describeArrival({ from: 'Laptop', at: 1_000 }, {})).not.toBeNull()
  })
})

describe('the arrivals index on disk', () => {
  it('survives a relaunch, which is the whole point on an unattended shelf', async () => {
    const fs = fakeFs()
    await recordArrival(fs, 'bk1', { from: 'Laptop', at: 5 })
    expect(await readArrivals(fs)).toEqual({ bk1: { from: 'Laptop', at: 5 } })
  })

  it('forgets one without disturbing the others', async () => {
    const fs = fakeFs()
    await recordArrival(fs, 'bk1', { from: 'Laptop', at: 5 })
    await recordArrival(fs, 'bk2', { from: 'Phone', at: 6 })
    await dropArrival(fs, 'bk1')
    expect(await readArrivals(fs)).toEqual({ bk2: { from: 'Phone', at: 6 } })
  })

  it('reads an absent index as empty rather than as a failure', async () => {
    expect(await readArrivals(fakeFs())).toEqual({})
  })

  it('drops an unusable row individually, never the file', async () => {
    /* The measured reason `readDownloadSizes` is written this way: one bad
       entry must not cost the entries beside it, and a read that threw would
       be followed by a read-modify-write persisting {} over everything. */
    const fs = fakeFs({
      [ARRIVALS_INDEX_PATH]: JSON.stringify({
        good: { from: 'Laptop', at: 5 },
        noName: { from: '', at: 5 },
        noTime: { from: 'Laptop' },
        negative: { from: 'Laptop', at: -1 },
        notAnObject: 7,
      }),
    })
    expect(await readArrivals(fs)).toEqual({ good: { from: 'Laptop', at: 5 } })
  })

  it('is loud when the file is there and unreadable', async () => {
    /* The one failure that must NOT read as empty. `recordArrival` is a
       read-modify-write, so a transient read error swallowed here would write
       {} over every arrival this device had. Absent is empty; present and
       unreadable is a fault. */
    const fs = fakeFs({ [ARRIVALS_INDEX_PATH]: '{}' })
    fs.readFile = async () => {
      throw new Error('EIO')
    }
    await expect(readArrivals(fs)).rejects.toThrow('EIO')
  })

  it('reads a corrupt file as empty rather than throwing into the node start', async () => {
    expect(await readArrivals(fakeFs({ [ARRIVALS_INDEX_PATH]: 'not json' }))).toEqual({})
    expect(await readArrivals(fakeFs({ [ARRIVALS_INDEX_PATH]: '[1,2]' }))).toEqual({})
  })
})
