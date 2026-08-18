import { describe, expect, it } from 'vitest'
import { folderOf, recordPath, trashOf } from './bookFolder'
import { fakeFs, jsonAt, textAt } from './fakeFs.testkit'
import { hlcOf, makeHlc } from './hlc'
import {
  PRESENCE_PATH,
  finishPendingRemovals,
  notePresence,
  readPresence,
  recordStamp,
  writePresence,
} from './presence'

const DEV = 'a1b2c3d4e5f60718'
const t = (ms: number) => makeHlc(ms, 0, DEV)

describe('the register on disk', () => {
  it('round-trips, and an absent or unreadable file is the empty register', async () => {
    const fs = fakeFs()
    expect(await readPresence(fs)).toEqual({})
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(5) } })
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(5) } })
    fs.store.set(PRESENCE_PATH, new TextEncoder().encode('not json'))
    expect(await readPresence(fs)).toEqual({})
  })

  it('drops a malformed entry alone and keeps the register beside it', async () => {
    const fs = fakeFs({
      [PRESENCE_PATH]: JSON.stringify({
        'book:good': { state: 'removed', at: t(5) },
        'book:badState': { state: 'gone', at: t(5) },
        'book:badStamp': { state: 'live', at: 'yesterday' },
        'book:notAnObject': 7,
        '': { state: 'live', at: t(5) },
      }),
    })
    expect(await readPresence(fs)).toEqual({ 'book:good': { state: 'removed', at: t(5) } })
  })

  it('is safe under prototype-named book ids', async () => {
    const fs = fakeFs({
      [PRESENCE_PATH]: JSON.stringify({ constructor: { state: 'removed', at: t(5) } }),
    })
    const presence = await readPresence(fs)
    expect(presence['constructor']).toEqual({ state: 'removed', at: t(5) })
    expect(Object.keys(presence)).toEqual(['constructor'])
  })
})

describe('notePresence — last writer wins', () => {
  it('writes a first entry, and a newer one over it', async () => {
    const fs = fakeFs()
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(true)
    expect(await notePresence(fs, 'book:a', 'live', t(6))).toBe(true)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'live', at: t(6) } })
  })

  it('refuses a stale write — a slow replica cannot roll a decision back', async () => {
    const fs = fakeFs()
    await notePresence(fs, 'book:a', 'live', t(9))
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(false)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'live', at: t(9) } })
  })

  it('holds the held value on an exact tie, and does not rewrite a repeat', async () => {
    const fs = fakeFs()
    await notePresence(fs, 'book:a', 'removed', t(5))
    expect(await notePresence(fs, 'book:a', 'live', t(5))).toBe(false)
    expect(await notePresence(fs, 'book:a', 'removed', t(5))).toBe(false)
    expect(await readPresence(fs)).toEqual({ 'book:a': { state: 'removed', at: t(5) } })
  })
})

describe('recordStamp', () => {
  it('is the newest of everything a record knows, legacy times included', () => {
    expect(recordStamp({ title: '', author: '' })).toBe(hlcOf(0))
    expect(recordStamp({ title: '', author: '', addedAt: 50, openedAt: 80 })).toBe(hlcOf(80))
    expect(
      recordStamp({ title: '', author: '', addedAt: 50, positionAt: t(90) }),
    ).toBe(t(90))
    expect(
      recordStamp({
        title: '',
        author: '',
        finishedAt: t(70),
        tagClock: { sea: { at: t(95), on: true, spelling: 'Sea' } },
      }),
    ).toBe(t(95))
  })
})

describe('finishPendingRemovals — launch recovery', () => {
  const record = (addedAt: number) => JSON.stringify({ bookId: 'book:a', title: 'T', author: '', addedAt })

  it('finishes a removal the crash left half done', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual(['book:a'])
    expect(await fs.exists(folderOf('book:a'))).toBe(false)
    expect(await fs.exists(`${trashOf('book:a')}/book.json`)).toBe(true)
    // Into the ORDINARY trash, stamp and fortnight included.
    expect(textAt(fs, `${trashOf('book:a')}/.removed`)).toBeTruthy()
  })

  it('leaves a record newer than the removal — a re-add racing a crash', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(200) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual([])
    expect(await fs.exists(folderOf('book:a'))).toBe(true)
  })

  it('does nothing for live entries or folders already gone', async () => {
    const fs = fakeFs({ [recordPath('book:b')]: record(50) })
    await writePresence(fs, {
      'book:a': { state: 'removed', at: t(100) }, // no folder
      'book:b': { state: 'live', at: t(100) },
    })
    expect(await finishPendingRemovals(fs)).toEqual([])
    expect(await fs.exists(folderOf('book:b'))).toBe(true)
  })

  it('moves a folder whose record will not read — nothing says it is newer', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: 'not json' })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    expect(await finishPendingRemovals(fs)).toEqual(['book:a'])
    expect(await fs.exists(folderOf('book:a'))).toBe(false)
  })

  it('one folder that will not move does not stop the others', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50), [recordPath('book:b')]: record(50) })
    await writePresence(fs, {
      'book:a': { state: 'removed', at: t(100) },
      'book:b': { state: 'removed', at: t(100) },
    })
    const exists = fs.exists
    fs.exists = async (path) => {
      if (path === folderOf('book:a')) throw new Error('flaky disk')
      return exists(path)
    }
    expect(await finishPendingRemovals(fs)).toEqual(['book:b'])
  })

  it('presence entries survive the finish — the register outlives the trash', async () => {
    const fs = fakeFs({ [recordPath('book:a')]: record(50) })
    await writePresence(fs, { 'book:a': { state: 'removed', at: t(100) } })
    await finishPendingRemovals(fs)
    expect(jsonAt(fs, PRESENCE_PATH)).toEqual({ 'book:a': { state: 'removed', at: t(100) } })
  })
})
