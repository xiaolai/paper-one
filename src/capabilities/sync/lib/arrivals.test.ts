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

  /* AT OR AFTER, not strictly after: opened in the same millisecond it landed
     is opened, and the strict comparison kept a notice that had been read. */
  it('goes when it was opened in the very millisecond it landed', () => {
    expect(describeArrival({ from: 'Laptop', at: 1_000 }, { openedAt: 1_000 })).toBeNull()
  })

  it('treats a never-opened book as still worth saying', () => {
    /* The common case for a book that has just landed, and the one this
       exists to cover. An absent `openedAt` must not read as 0 — which is
       older than any arrival, and would silence every notice ever written. */
    expect(describeArrival({ from: 'Laptop', at: 1_000 }, {})).not.toBeNull()
    /* Including an arrival stamped at zero, where "absent" and "0" part company. */
    expect(describeArrival({ from: 'Laptop', at: 0 }, {})).toEqual({ label: 'Added from Laptop' })
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

  /* FORGETTING WHAT WAS NEVER HELD WRITES NOTHING — no file conjured from an
     absent index, and a held one left byte for byte as it was. */
  it('writes nothing to forget a book it never held', async () => {
    const none = fakeFs()
    await dropArrival(none, 'bk1')
    expect(await none.exists(ARRIVALS_INDEX_PATH)).toBe(false)

    const raw = '{ "bk2": { "from": "Phone", "at": 6 } }'
    const held = fakeFs({ [ARRIVALS_INDEX_PATH]: raw })
    await dropArrival(held, 'bk1')
    expect(new TextDecoder().decode(await held.readFile(ARRIVALS_INDEX_PATH))).toBe(raw)
  })

  /* THE PATH IS WHERE EVERY EARLIER BUILD WROTE IT. A different name would
     read as an absent index, and every notice on the shelf would go quiet. */
  it('reads the index from sync/arrivals.json', async () => {
    const fs = fakeFs({ 'sync/arrivals.json': JSON.stringify({ bk1: { from: 'Laptop', at: 5 } }) })
    expect(await readArrivals(fs)).toEqual({ bk1: { from: 'Laptop', at: 5 } })
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
        numberName: { from: 7, at: 5 },
        noTime: { from: 'Laptop' },
        negative: { from: 'Laptop', at: -1 },
        atZero: { from: 'Laptop', at: 0 },
        notAnObject: 7,
        nothing: null,
      }),
    })
    expect(await readArrivals(fs)).toEqual({ good: { from: 'Laptop', at: 5 }, atZero: { from: 'Laptop', at: 0 } })
  })

  /* WRITTEN AS TEXT: `JSON.stringify` spells Infinity as `null`, and `1e999`
     is how a file can hold a time that parses as Infinity. */
  it('drops a row whose time is not finite', async () => {
    const fs = fakeFs({ [ARRIVALS_INDEX_PATH]: '{"endless":{"from":"Laptop","at":1e999},"good":{"from":"Laptop","at":5}}' })
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

  /* ⚠️ **AND A CORRUPT FILE IS UNREADABLE TOO — IT USED TO READ AS EMPTY.**
     Only a failed READ was loud; bytes that were not JSON, and JSON that was
     not an index, answered {} — so the next `recordArrival` wrote that
     emptiness over every arrival this device had, which is the loss the test
     above exists to prevent, reached by the other door. The title's fear was
     unfounded: the one caller at the node start (`sync/index.ts:964`) already
     warns `sync.arrivals-read-failed` and carries on. Found by the 2026-09-13
     audit. */
  it.each([
    ['not JSON', 'not json', /the arrivals index is not JSON/u],
    ['a list', '[1,2]', /the arrivals index is not an object/u],
    ['JSON null', 'null', /the arrivals index is not an object/u],
    ['a bare number', '42', /the arrivals index is not an object/u],
    ['a bare string', '"arrivals"', /the arrivals index is not an object/u],
    ['a bare boolean', 'true', /the arrivals index is not an object/u],
  ])('refuses an index that is %s, and leaves its bytes where they are', async (_name, raw, clause) => {
    const fs = fakeFs({ [ARRIVALS_INDEX_PATH]: raw })

    const cause = await readArrivals(fs).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)

    const wrote = await recordArrival(fs, 'bk1', { from: 'Laptop', at: 5 }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(wrote).toBeInstanceOf(Error)
    expect(new TextDecoder().decode(await fs.readFile(ARRIVALS_INDEX_PATH))).toBe(raw)
  })

  /* THE PARSER'S OWN WORDS TRAVEL WITH THE REFUSAL, so a diagnostics line can
     say where in the file it broke rather than only that it did. */
  it('carries the parse error as the cause of a refusal', async () => {
    const cause = await readArrivals(fakeFs({ [ARRIVALS_INDEX_PATH]: '{"bk1":' })).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('the arrivals index is not JSON')
    expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
  })
})
