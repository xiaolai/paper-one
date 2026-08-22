import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_FILES } from '../hosts/node/fixture.testkit'
import { paper } from './paper'
import { EXIT, type CliSinks } from './run'

/**
 * ONE FOLDER, TWO IDS — the alias class, closed at both ends.
 *
 * `folderOf` sanitises every character outside `[A-Za-z0-9]` to `_`, so the
 * mapping from id to directory is MANY-TO-ONE: `a/b` and `a_b` are different
 * books and one folder. `book.add` already refused a live collision. Two paths
 * did not:
 *
 * - ADD checked only the live shelf. `library.add` restores a matching trash
 *   path — that is how re-adding a removed book brings its marks back — so
 *   adding an alias of a TRASHED id silently moved that book out of the trash
 *   and relabelled it.
 * - RESTORE matched a trash folder without reading whose book was in it, so an
 *   alias could restore and reidentify somebody else's book.
 *
 * Both are refusals now, and both name the id actually occupying the folder,
 * because "conflict" a caller cannot act on is the same as no message.
 */

const roots: string[] = []

async function library(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paper-alias-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const full = join(root, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

function sinks(): { sinks: CliSinks; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { sinks: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

const absent = async () => 'absent' as const

async function run(root: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const { sinks: s, out, err } = sinks()
  const code = await paper({ argv, sinks: s, dataDir: root, appPresence: absent })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('a folder already spoken for', () => {
  it('refuses to add an alias of a book on the shelf', async () => {
    const root = await library()
    expect((await run(root, ['book', 'add', 'a_b', 'First'])).code).toBe(EXIT.ok)
    const clash = await run(root, ['book', 'add', 'a/b', 'Second'])
    expect(clash.code).not.toBe(EXIT.ok)
    expect(clash.err).toContain('would share a folder with a_b')
  })

  /* The case the live-snapshot check could not see. */
  it('refuses to add an alias of a book in the trash, rather than resurrecting it', async () => {
    const root = await library()
    expect((await run(root, ['book', 'add', 'a_b', 'First'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'remove', 'a_b'])).code).toBe(EXIT.ok)

    const clash = await run(root, ['book', 'add', 'a/b', 'Second'])
    expect(clash.code).not.toBe(EXIT.ok)
    expect(clash.err).toContain('a_b')
    expect(clash.err).toContain('trash')

    /* And nothing came back under the new name. */
    const got = await run(root, ['book', 'get', 'a/b', '--json'])
    expect(got.code).not.toBe(EXIT.ok)
  })

  it('names the same book plainly when it is the same book', async () => {
    const root = await library()
    expect((await run(root, ['book', 'add', 'a_b', 'First'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'remove', 'a_b'])).code).toBe(EXIT.ok)
    const again = await run(root, ['book', 'add', 'a_b', 'First'])
    expect(again.err).toContain('in the trash')
  })
})

describe('restore reads the identity, not the path', () => {
  it('refuses to restore somebody else’s book through an alias', async () => {
    const root = await library()
    expect((await run(root, ['book', 'add', 'a_b', 'First'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'remove', 'a_b'])).code).toBe(EXIT.ok)

    const wrong = await run(root, ['book', 'restore', 'a/b'])
    expect(wrong.code).not.toBe(EXIT.ok)
    expect(wrong.err).toContain('holds a_b')
  })

  it('still restores the book that is actually there', async () => {
    const root = await library()
    expect((await run(root, ['book', 'add', 'a_b', 'First'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'remove', 'a_b'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'restore', 'a_b'])).code).toBe(EXIT.ok)
    expect((await run(root, ['book', 'get', 'a_b', '--json'])).code).toBe(EXIT.ok)
  })
})

/**
 * THE IRREVERSIBLE VERB, and the two things guarding it.
 *
 * A count cannot see MEMBERSHIP change — one book restored and another trashed
 * leaves it identical — so `--books` states what the caller actually reviewed
 * and the trash must hold precisely that. And the purge itself runs on each
 * book's own write lane rather than deleting `trash/<folder>` directly, so the
 * exists-and-delete pair cannot interleave with a restore or a re-removal of
 * the same book.
 */
describe('emptying the trash', () => {
  it('destroys exactly what was confirmed', async () => {
    const root = await library()
    await run(root, ['book', 'add', 'one', 'One'])
    await run(root, ['book', 'remove', 'one'])
    const purge = await run(root, ['trash', 'empty', '1', '--books', 'one'])
    expect(purge.code).toBe(EXIT.ok)
    expect((await run(root, ['trash', 'list', '--json'])).out).toContain('[]')
  })

  it('refuses when the count is right but the membership is not', async () => {
    const root = await library()
    await run(root, ['book', 'add', 'one', 'One'])
    await run(root, ['book', 'remove', 'one'])

    /* The caller reviewed a book that is no longer the one in the trash. The
     * count still says one — which is exactly the case cardinality cannot
     * catch, and the case that destroys an unreviewed book. */
    const wrong = await run(root, ['trash', 'empty', '1', '--books', 'other'])
    expect(wrong.code).not.toBe(EXIT.ok)
    expect(wrong.err).toContain('changed since you looked')

    /* Nothing was destroyed. */
    expect((await run(root, ['trash', 'list', '--json'])).out).toContain('one')
  })

  it('still refuses on a plain count mismatch', async () => {
    const root = await library()
    await run(root, ['book', 'add', 'one', 'One'])
    await run(root, ['book', 'remove', 'one'])
    const wrong = await run(root, ['trash', 'empty', '2'])
    expect(wrong.code).not.toBe(EXIT.ok)
    expect(wrong.err).toContain('not 2')
  })
})

/**
 * TAG COUNTS MUST MATCH WHAT THE STORE ACTUALLY WROTE.
 *
 * `library.tagBooks` folds against BOTH the reader's `tags` and the
 * publisher's `subjects` — deliberately, so a publisher's `philosophy` and a
 * reader's `Philosophy` are one tag on that book. The service counted only
 * `tags`, so a book the store quietly skipped was reported as changed and
 * `tag.add` answered with a number larger than the records it wrote.
 *
 * And `tag.list` is a paged stream now: a record permits 4 096 tags per book,
 * so one unpaged answer could pass the wire limit on a heavily tagged shelf.
 */
describe('tagging', () => {
  it('reports only the books it actually changed', async () => {
    const root = await library()
    await run(root, ['book', 'add', 'one', 'One'])
    const first = await run(root, ['tag', 'add', 'philosophy', '--book', 'one', '--json'])
    expect(first.code).toBe(EXIT.ok)
    expect(JSON.parse(first.out) as { books: number }).toMatchObject({ tag: 'philosophy', books: 1 })

    /* Applying the same tag again changes nothing, and the count must say so
     * rather than counting the request. */
    const again = await run(root, ['tag', 'add', 'philosophy', '--book', 'one', '--json'])
    expect(again.code).toBe(EXIT.ok)
    expect(JSON.parse(again.out) as { books: number }).toMatchObject({ books: 0 })
  })

  /* THE CASE THAT DISTINGUISHES THE TWO COUNTS.
   *
   * A book whose PUBLISHER'S SUBJECT already carries the key: the store skips
   * it (one tag, however it got there), so nothing is written — and a count
   * that looked only at `tags` reported it as changed anyway. Without this
   * fixture the fix and the bug behave identically, which a first draft of
   * these tests demonstrated by passing under both. */
  it('does not count a book whose publisher subject already carries the tag', async () => {
    const root = await library()
    /* SEEDED BEFORE THE FIRST LOAD, so the scan indexes the subjects and the
     * row and the record agree — which is what normal operation produces.
     * Writing the record AFTER the index exists creates a disagreement the app
     * never makes, and a test built on one measures the fixture. `book add`
     * has no subjects argument because subjects come from the parsed file. */
    await mkdir(join(root, 'books', 'subjecty'), { recursive: true })
    await writeFile(
      join(root, 'books', 'subjecty', 'book.json'),
      JSON.stringify({ bookId: 'subjecty', title: 'Subjecty', author: 'A', addedAt: 1, subjects: ['philosophy'] }),
    )

    const added = await run(root, ['tag', 'add', 'philosophy', '--book', 'subjecty', '--json'])
    expect(added.code).toBe(EXIT.ok)
    /* The store folds against BOTH lists — a publisher's `philosophy` and a
     * reader's `Philosophy` are one tag on this book — so nothing is written
     * and the answer must say nothing was. */
    expect(JSON.parse(added.out) as { books: number }).toMatchObject({ books: 0 })
  })

  it('lists tags as a stream that still answers in one page for an ordinary shelf', async () => {
    const root = await library()
    await run(root, ['book', 'add', 'one', 'One'])
    await run(root, ['tag', 'add', 'philosophy', '--book', 'one'])
    const listed = await run(root, ['tag', 'list', '--json'])
    expect(listed.code).toBe(EXIT.ok)
    const rows = JSON.parse(listed.out) as { tag: string }[]
    expect(rows.some((one) => one.tag === 'philosophy')).toBe(true)
  })
})
