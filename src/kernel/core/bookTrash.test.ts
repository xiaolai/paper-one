import { describe, expect, it } from 'vitest'
import { folderOf, trashOf } from './bookFolder'
import {
  TRASH_DAYS,
  emptyExpired,
  rescueStrandedMarks,
  restoreBook,
  trashBook,
} from './bookTrash'
import { fakeFs } from './fakeFs.testkit'

/**
 * Removing a book takes the reader's tags, their place in it and their marks
 * with it — because those live in its folder. That is not a file the reader
 * owns; it is what they wrote. So the folder moves rather than going away.
 */

const shelved = (id = 'book_a') => ({
  [`${folderOf(id)}/book.json`]: '{"title":"Moby-Dick","author":"M","tags":["Sea"]}',
  [`${folderOf(id)}/content.epub`]: 'WHALE',
  [`${folderOf(id)}/marks.json`]: '[{"cfi":"x"}]',
})

describe('trashBook', () => {
  it('moves the whole folder, marks and all', async () => {
    const fs = fakeFs(shelved())
    expect(await trashBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(false)
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })

  it('reports nothing to remove for a book that is not there', async () => {
    expect(await trashBook(fakeFs(), 'book_a')).toBe(false)
  })
})

describe('restoreBook', () => {
  /**
   * The property that makes removal safe to offer.
   *
   * Re-adding the same bytes lands on the same folder name, because the id is
   * derived from content — so a reader who removes a book and adds it again
   * finds their highlights waiting, and nothing had to remember they might.
   */
  it('puts a book back with everything it owned', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/book.json`)!)).toContain(
      'Sea',
    )
    expect(fs.store.has(`${folderOf('book_a')}/marks.json`)).toBe(true)
  })

  it('does not leave the removal stamp behind', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${folderOf('book_a')}/.removed`)).toBe(false)
  })

  it('reports nothing to restore when the trash is empty', async () => {
    expect(await restoreBook(fakeFs(), 'book_a')).toBe(false)
  })
})


describe('emptyExpired', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('deletes a book that has been in the trash longer than its stay', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    const gone = await emptyExpired(fs, Date.now() + (TRASH_DAYS + 1) * DAY)
    expect(gone).toEqual(['book_a'])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(false)
  })

  it('leaves one that is still within its stay', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    expect(await emptyExpired(fs, Date.now() + DAY)).toEqual([])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
  })

  /**
   * Erring towards KEEPING, which is the only direction that cannot lose work.
   *
   * A folder with no stamp — hand-moved, or written by a version that did not
   * stamp — has no age, and deleting something of unknown age to reclaim disk is
   * the wrong trade against somebody's annotations.
   */
  it('leaves a folder whose stamp is missing or unreadable', async () => {
    const fs = fakeFs({ [`${trashOf('book_a')}/book.json`]: '{}' })
    expect(await emptyExpired(fs, Date.now() + 10_000 * DAY)).toEqual([])
    fs.store.set(`${trashOf('book_a')}/.removed`, new TextEncoder().encode('not a number'))
    expect(await emptyExpired(fs, Date.now() + 10_000 * DAY)).toEqual([])
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
  })

  it('is quiet when there is no trash at all', async () => {
    expect(await emptyExpired(fakeFs())).toEqual([])
  })
})

/**
 * The case restore was actually asked for, and refused.
 *
 * An import writes `content.epub` FIRST and puts the book on the shelf second,
 * so by the time anything calls `restoreBook` the live folder already exists.
 * Renaming the trashed folder onto it fails, and returning false there left the
 * reader's tags, place and marks in the trash — at the exact moment
 * content-derived identity was about to hand them back.
 */
describe('restoring onto a folder that is already there', () => {
  const withContentOnly = (id = 'book_a') => ({
    [`${folderOf(id)}/content.epub`]: 'FRESH BYTES',
  })

  it('brings back the record and the marks', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // The import lands while the old copy is still in the trash.
    for (const [k, v] of Object.entries(withContentOnly())) {
      fs.store.set(k, new TextEncoder().encode(v))
    }
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/book.json`)!)).toContain(
      'Sea',
    )
    expect(fs.store.has(`${folderOf('book_a')}/marks.json`)).toBe(true)
  })

  /* The bytes just written WIN. They are the current copy; the trashed one is
   * the same book by definition, since the id is the content. */
  it('keeps the freshly imported content rather than the trashed copy', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH BYTES'))
    await restoreBook(fs, 'book_a')
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/content.epub`)!)).toBe(
      'FRESH BYTES',
    )
  })

  it('empties the trash entry when everything moved', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // Nothing live to collide with — the whole book comes back.
    await restoreBook(fs, 'book_a')
    expect([...fs.store.keys()].some((k) => k.startsWith(`${trashOf('book_a')}/`))).toBe(false)
  })

  /**
   * A collided `content.<ext>` is KEPT, not deleted.
   *
   * An earlier version deleted it, reasoning that the folder is named by a hash
   * of those bytes so the two must be the same book. Above 64MB `bookIdFor`
   * samples rather than hashes whole — the comment on `INTERIOR_PROBES` says so
   * outright — and deleting a file on a premise the code documents as
   * approximate is how a scanned book disappears.
   */
  it('keeps a trashed copy it cannot prove is a duplicate', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/content.epub`)).toBe(true)
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(true)
  })
})

/**
 * A restore that cannot finish must not delete what it failed to move.
 *
 * The first entry-by-entry version swallowed each rename failure and then
 * emptied the trash regardless — so an entry that failed to move was deleted
 * instead. A restore that loses the thing it is restoring is worse than one
 * that refuses.
 */
describe('restoring when something is in the way', () => {
  it('leaves a trashed file behind rather than deleting it, when a live one wins', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // A live marks file, which is the collision that would cost the reader work.
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
    // The record still came back — one collision does not stop the rest.
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(true)
  })

  it('keeps the stamp on what it left, so the sweep can still age it', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/.removed`)).toBe(true)
    const DAY = 24 * 60 * 60 * 1000
    expect(await emptyExpired(fs, Date.now() + (TRASH_DAYS + 1) * DAY)).toEqual(['book_a'])
  })

  /**
   * And that stamp is a FRESH one.
   *
   * A restore attempted a day before expiry otherwise reported success and then
   * let the sweep delete the files it had just failed to bring back — the
   * reader asked for their book and lost the rest of it instead.
   */
  it('gives what it left behind a fresh fortnight', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    const DAY = 24 * 60 * 60 * 1000
    // Aged almost to expiry.
    const old = Date.now() - (TRASH_DAYS - 1) * DAY
    fs.store.set(`${trashOf('book_a')}/.removed`, new TextEncoder().encode(String(old)))
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    await restoreBook(fs, 'book_a')
    // Two days later the old stamp would have expired. The new one has not.
    expect(await emptyExpired(fs, Date.now() + 2 * DAY)).toEqual([])
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })

  it('does not delete an entry whose move failed', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (from.endsWith('marks.json')) throw new Error('locked')
      return rename(from, to)
    }
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })
})

/**
 * A partial restore has to be retried, or its leftovers are deleted for it.
 *
 * `restoreBook` leaves behind what it could not move. The caller attempted it
 * only when the book was absent from the shelf, so the first attempt was also
 * the last: the row existed afterwards, nothing looked at the trash again, and
 * the sweep cleared it a fortnight later.
 */
describe('finishing a restore that could not finish before', () => {
  it('moves what was left once the obstruction is gone', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/marks.json`, new TextEncoder().encode('[]'))
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)

    // The live file goes away — a failed write cleaned up, say — and a later
    // add tries again.
    fs.store.delete(`${folderOf('book_a')}/marks.json`)
    expect(await restoreBook(fs, 'book_a')).toBe(true)
    expect(new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/marks.json`)!)).toContain(
      'x',
    )
    expect([...fs.store.keys()].some((k) => k.startsWith(`${trashOf('book_a')}/`))).toBe(false)
  })

  it('is a no-op when there is nothing in the trash', async () => {
    const fs = fakeFs(shelved())
    expect(await restoreBook(fs, 'book_a')).toBe(false)
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(true)
  })
})

/**
 * The one annotation that cost all the others.
 *
 * Re-adding a book writes its bytes first, so there is a real window — seconds,
 * for a large file — in which the folder exists and the restore has not run. A
 * highlight made in it creates a live `marks.json`, `restoreBook` treats it as a
 * collision and correctly refuses to overwrite it, and the complete list then
 * sat in the trash until the sweep deleted it.
 */
describe('rescueStrandedMarks', () => {
  const staged = async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // The reader highlights something while the book is coming back.
    fs.store.set(
      `${folderOf('book_a')}/marks.json`,
      new TextEncoder().encode('[{"id":"new","cfi":"z"}]'),
    )
    await restoreBook(fs, 'book_a')
    return fs
  }

  it('folds the trashed marks in beside the new one', async () => {
    const fs = await staged()
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
    expect(await rescueStrandedMarks(fs, 'book_a')).toBe(true)
    const kept = JSON.parse(
      new TextDecoder().decode(fs.store.get(`${folderOf('book_a')}/marks.json`)!),
    ) as { id?: string; cfi?: string }[]
    // The one made during the window, and the one that was in the trash. The
    // fixture's mark carries no id, which is the case that must be CARRIED
    // rather than dropped — it cannot be deduplicated, and losing somebody's
    // note to tidy bookkeeping is the wrong way round.
    expect(kept).toHaveLength(2)
    expect(kept.map((m) => m.cfi).sort()).toEqual(['x', 'z'])
  })

  it('clears the trashed copy only once the merged list is written', async () => {
    const fs = await staged()
    await rescueStrandedMarks(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(false)
  })

  it('is quiet when there is nothing stranded', async () => {
    const fs = fakeFs(shelved())
    expect(await rescueStrandedMarks(fs, 'book_a')).toBe(false)
  })

  /* A trashed marks file that will not read is not one to delete on the way
   * past — it keeps its stamp and its fortnight. */
  it('leaves an unreadable trashed file alone', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${trashOf('book_a')}/marks.json`, new TextEncoder().encode('half a write'))
    expect(await rescueStrandedMarks(fs, 'book_a')).toBe(false)
    expect(fs.store.has(`${trashOf('book_a')}/marks.json`)).toBe(true)
  })
})

/**
 * Remove, add again, remove.
 *
 * A restore deliberately leaves behind anything it could not bring back, so a
 * trash entry can still exist for a book that is live again. Renaming a
 * directory ONTO a non-empty one fails — and the caller ignored the `false`, so
 * the row vanished, the index was written without it, and the book came back on
 * the next launch. Remove appearing not to work is about the worst thing the
 * shelf can do quietly.
 */
describe('removing a book that has been removed before', () => {
  it('succeeds even when the trash still holds part of the old copy', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    // The re-add: content lands first, so restore leaves the old content behind.
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')
    expect(fs.store.has(`${trashOf('book_a')}/content.epub`)).toBe(true)

    expect(await trashBook(fs, 'book_a')).toBe(true)
    expect([...fs.store.keys()].some((k) => k.startsWith(`${folderOf('book_a')}/`))).toBe(false)
    expect(fs.store.has(`${trashOf('book_a')}/book.json`)).toBe(true)
  })

  /* The LIVE copy wins on a collision, mirroring restore: it is the one the
   * reader has been using. */
  it('keeps the live copy of a file the trash also has', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')
    await trashBook(fs, 'book_a')
    expect(new TextDecoder().decode(fs.store.get(`${trashOf('book_a')}/content.epub`)!)).toBe(
      'FRESH',
    )
  })

  it('still reports nothing to remove for a book that is not there', async () => {
    expect(await trashBook(fakeFs(), 'book_a')).toBe(false)
  })
})

/**
 * A removal that cannot finish must leave the book where it was.
 *
 * Moving one entry at a time is not one operation, so a failure part way left
 * `book.json` in the trash and the content live — a book split across two
 * directories, which is worse than a removal that did not happen and, unlike
 * one, is not fixed by pressing the button again.
 */
describe('a removal interrupted half way', () => {
  /* And the TRASHED copy a collision displaced survives too. Deleting it to
   * make room made the rollback a half-measure: it could put the live entries
   * back and had nothing left to restore on the other side. That matters most
   * for `content.*`, which this file says elsewhere is not provably the same
   * book above 64MB. */
  it('keeps the trashed copy it had to move out of the way', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')
    const trashed = new TextDecoder().decode(fs.store.get(`${trashOf('book_a')}/content.epub`)!)

    // Every move fails, so nothing should end up anywhere new.
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (from.startsWith(folderOf('book_a'))) throw new Error('locked')
      return rename(from, to)
    }
    expect(await trashBook(fs, 'book_a')).toBe(false)
    fs.rename = rename

    expect(new TextDecoder().decode(fs.store.get(`${trashOf('book_a')}/content.epub`)!)).toBe(
      trashed,
    )
    expect([...fs.store.keys()].some((k) => k.endsWith('.displaced'))).toBe(false)
  })

  it('puts back everything it had already moved', async () => {
    const fs = fakeFs(shelved())
    await trashBook(fs, 'book_a')
    fs.store.set(`${folderOf('book_a')}/content.epub`, new TextEncoder().encode('FRESH'))
    await restoreBook(fs, 'book_a')

    // The second removal takes the entry-by-entry path, and one entry refuses.
    const rename = fs.rename
    let moves = 0
    fs.rename = async (from, to) => {
      if (from.startsWith(folderOf('book_a')) && ++moves > 1) throw new Error('locked')
      return rename(from, to)
    }
    expect(await trashBook(fs, 'book_a')).toBe(false)
    fs.rename = rename

    // Everything that was live is still live.
    expect(fs.store.has(`${folderOf('book_a')}/book.json`)).toBe(true)
    expect(fs.store.has(`${folderOf('book_a')}/content.epub`)).toBe(true)
    expect(fs.store.has(`${folderOf('book_a')}/marks.json`)).toBe(true)
  })
})
