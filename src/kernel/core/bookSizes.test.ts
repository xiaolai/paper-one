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

/**
 * A filesystem of `path → bytes`, with named paths that refuse to be read.
 *
 * ⚠️ **`''` IS THE DATA ROOT, and this fake could not express it.** The prefix
 * test was `startsWith(\`${path}/\`)`, which at the root is `startsWith('/')`
 * and matches nothing — so a walk from the root read as an EMPTY library. The
 * fake agreed with the defect it was standing in for.
 */
function ops(files: Record<string, number>, unreadable: readonly string[] = []): SizeOps {
  return {
    bytesAt: async (path) => (path in files ? files[path]! : null),
    readDir: async (path) => {
      if (unreadable.includes(path)) throw new Error(`refused: ${path}`)
      const prefix = path === '' ? '' : `${path}/`
      const names = new Map<string, boolean>()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length).split('/')
        names.set(rest[0]!, rest.length > 1)
      }
      /* ⚠️ **A DIRECTORY THAT IS NOT THERE THROWS**, and this used to answer
       * `[]` for any path at all — so "the library is there and empty" and "the
       * library does not exist" were the SAME fixture, and the walk's whole
       * partial-answer rule turns on telling them apart. A real `readDir` on a
       * missing path rejects.
       *
       * The DATA ROOT is the exception and always reads: the app creates it at
       * boot, so a root that is missing is a different failure from an empty
       * one and is not what `ops({})` is standing in for. */
      if (names.size === 0 && path !== '') throw new Error(`no such directory: ${path}`)
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

  /**
   * ⚠️ **AND "THERE AND EMPTY" IS NOT "NOT THERE".** The fake used to answer
   * `[]` for every path, so the case above was satisfied by a filesystem with
   * no such directory as well as by an empty one — and those must give
   * different answers: zero is a measurement, and a root nobody can read is
   * `null`. Told apart at the fixture, so the case above means what it says.
   */
  it('answers null when the data root itself will not read', async () => {
    expect(await sizePortOver(ops({}, [''])).libraryBytes()).toBeNull()
  })

  /**
   * ⚠️ **THIS WALKED `books/`, AND THE PORT PROMISES THE WHOLE LIBRARY.**
   *
   * The Node host's own implementation walked the DATA ROOT — the same contract
   * answered two ways, in two copies of one walk — so `shelf.status.bytes`
   * depended on which host you asked. The desktop's answer silently omitted
   * `index.json`, the flat store, the sync metadata and everything in the
   * trash, and a reader deciding whether to evict a book was shown a number
   * smaller than what was on their disk.
   */
  it('counts what is beside the books as well as the books', async () => {
    const port = sizePortOver(
      ops({
        [`${FOLDER}/content.epub`]: 100,
        'index.json': 7,
        'store.json': 3,
        'trash/one/content.epub': 40,
        'sync/peers.json': 2,
      }),
    )
    expect(await port.libraryBytes(), 'a total that omits everything but books/ is not a library total').toBe(152)
  })

  /* ROOT-SAFE JOIN. At the root the walk must not build `/index.json`, which is
     an ABSOLUTE path resolving outside the data directory entirely. */
  it('asks for root files by a relative name', async () => {
    const asked: string[] = []
    const port = sizePortOver({
      bytesAt: async (path) => {
        asked.push(path)
        return 1
      },
      readDir: async (path) => (path === '' ? [{ name: 'index.json', isDirectory: false }] : []),
    })
    expect(await port.libraryBytes()).toBe(1)
    expect(asked, 'a leading slash escapes the data directory').toEqual(['index.json'])
  })
})
