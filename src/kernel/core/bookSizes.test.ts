import { describe, expect, it } from 'vitest'
import { folderOf } from './bookFolder'
import { sizePortOver, type SizeOps } from './bookSizes'

/**
 * The size port's logic, without the plugin.
 *
 * Two things here have bitten elsewhere in this tree and are what the tests
 * are for: the EXTENSION ORDER, which has to be the one `content.locate` and
 * `content.read` walk or the three answers describe different files; and the
 * PARTIAL-ANSWER RULE, where a directory that would not read makes a total
 * unknown rather than smaller.
 */

/** A filesystem of `path → bytes`, with named paths that refuse to be read. */
function ops(files: Record<string, number>, unreadable: readonly string[] = []): SizeOps {
  return {
    bytesAt: async (path) => (path in files ? files[path]! : null),
    readDir: async (path) => {
      if (unreadable.includes(path)) throw new Error(`refused: ${path}`)
      const names = new Map<string, boolean>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(`${path}/`)) continue
        const rest = key.slice(path.length + 1).split('/')
        names.set(rest[0]!, rest.length > 1)
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
  }
}

const FOLDER = folderOf('one')

describe('contentBytes', () => {
  it('measures the book’s content file', async () => {
    const port = sizePortOver(ops({ [`${FOLDER}/content.epub`]: 4096 }))
    expect(await port.contentBytes('one')).toBe(4096)
  })

  /* THE SAME FILE THE OTHER TWO NAME. `content.locate` reports an `ext` and
     `content.read` streams bytes, both by `CONTENT_EXTENSIONS` order. A size
     picked alphabetically would report the azw3's byte count under the epub's
     name — and the browser client sizes a pdf.js range transport from exactly
     this number, so the mismatch truncates a book rather than showing an
     error. */
  it('walks CONTENT_EXTENSIONS order when a folder holds two', async () => {
    const port = sizePortOver(
      ops({ [`${FOLDER}/content.azw3`]: 111, [`${FOLDER}/content.epub`]: 222 }),
    )
    expect(await port.contentBytes('one')).toBe(222)
  })

  /* NULL, NEVER ZERO. A caller cannot tell "there are no bytes here" from "the
     book is empty" if both answer 0, and one of those means do not open it. */
  it('answers null for a book with no content, not zero', async () => {
    expect(await sizePortOver(ops({})).contentBytes('one')).toBeNull()
  })

  it('answers a real zero for a file that is genuinely empty', async () => {
    const port = sizePortOver(ops({ [`${FOLDER}/content.epub`]: 0 }))
    expect(await port.contentBytes('one')).toBe(0)
  })
})

describe('libraryBytes', () => {
  it('adds up every file under the books directory, at any depth', async () => {
    const port = sizePortOver(
      ops({
        [`${FOLDER}/content.epub`]: 100,
        [`${FOLDER}/cover.jpg`]: 20,
        [`${folderOf('two')}/content.pdf`]: 3,
      }),
    )
    expect(await port.libraryBytes()).toBe(123)
  })

  /* A WALK THAT DID NOT FINISH HAS NO TOTAL. Returning the part it managed
     reports a number that is confidently wrong, and the storage pane offers it
     to a reader deciding what to delete. */
  it('answers null when a directory would not read, rather than a smaller number', async () => {
    const port = sizePortOver(
      ops({ [`${FOLDER}/content.epub`]: 100, [`${folderOf('two')}/content.pdf`]: 3 }, [folderOf('two')]),
    )
    expect(await port.libraryBytes()).toBeNull()
  })

  it('answers null when a file inside it would not measure', async () => {
    const port: SizeOps = {
      ...ops({ [`${FOLDER}/content.epub`]: 100 }),
      bytesAt: async () => null,
    }
    expect(await sizePortOver(port).libraryBytes()).toBeNull()
  })

  it('answers zero for a library that is there and empty', async () => {
    /* NOT null. The directory read, and it held nothing — which is a
       measurement, unlike a directory nobody could open. */
    expect(await sizePortOver(ops({})).libraryBytes()).toBe(0)
  })
})
