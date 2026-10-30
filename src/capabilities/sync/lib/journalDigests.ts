import {
  folderOf,
  readBook,
  readMarks,
  readPresence,
  recordPath,
  validMarks,
  type Card,
  type IndexFs,
  type MutationKind,
} from '../../../kernel'
import { cardsDigest, marksDigest, recordDigest } from './merge'

/**
 * WHAT A COMMIT SAYS THE SURFACE LOOKED LIKE.
 *
 * Extracted from `createJournal`, which had grown past a thousand lines with
 * the parser, the durable writes, recovery, bootstrap, compaction and the
 * in-memory index in one closure. This half depends on the FILESYSTEM and the
 * card snapshot and on none of that mutable state, so it is separable — and
 * separating it is what makes the rule below reachable from a test.
 *
 * THE RULE, which is the whole of it: `null` is a genuine ABSENCE — a surface
 * with no digest to compute, or a record that is gone — which the verify pass
 * reads as "cannot compare, do not re-commit". An ERROR (a file present but
 * unreadable, a hash that threw) is NOT an absence and is THROWN. Verify must
 * not pass by turning a failed read into a matching-looking null.
 */

export interface DigestSources {
  readonly fs: IndexFs
  /** The card snapshot, read at call time — cards are one cross-book surface. */
  readonly cards: () => readonly Card[]
}

export interface Digests {
  /** The surface's digest, `null` when there is none to compute. Throws when
   *  the surface is present and could not be read. */
  of(book: string, what: MutationKind): Promise<string | null>
  /** The same, for a COMMIT: a read that fails yields no digest rather than
   *  failing the write. */
  forCommit(book: string, what: MutationKind): Promise<string | undefined>
}

export function createDigests({ fs, cards }: DigestSources): Digests {
  /* `book` here is what the kernel handed `begin` — a book ID, from which
   * `readBook`/`readMarks` derive the folder the same way every kernel writer
   * does. `null` is a genuine ABSENCE — a surface with no digest to compute,
   * or a record that is gone — which the verify pass reads as "cannot
   * compare, do not re-commit". An ERROR (a file present but unreadable, a
   * hash that threw) is NOT an absence and is THROWN (#10): verify must not
   * pass by turning a failed read into a matching-looking null. */
  const digestOf = async (book: string, what: MutationKind): Promise<string | null> => {
    if (what === 'record') {
      const record = await readBook(fs, book)
      if (record !== null) return recordDigest(record)
      /* `readBook` answers null for GONE and for BROKEN alike. Present but
       * unreadable is a torn/half-written folder the verify pass must keep
       * chasing, not a book that is simply not there. */
      if (await fs.exists(recordPath(book))) {
        throw new Error(`journal: book.json for ${book} is present but could not be read`)
      }
      return null
    }
    if (what === 'marks') {
      // `readMarks`: absent is `[]`, unreadable THROWS — which propagates as
      // the error it is rather than reading as "no marks".
      return marksDigest(validMarks(await readMarks(fs, book)))
    }
    if (what === 'cards') {
      return cardsDigest(cards())
    }
    /* THE THREE SURFACES THAT ARE NOT DOCUMENTS.
     *
     * These returned `null` — "no digest to compute" — which put every
     * `cover`, `content` and `removed` commit permanently outside the
     * unclean-shutdown check, while the journal's own contract says a commit
     * carries a digest. Those are exactly the surfaces where a crash between
     * the file write and the commit is most likely: an import writes bytes,
     * an eviction deletes them, a removal moves a folder.
     *
     * What they get is an EXISTENCE digest, not a content hash, and the
     * distinction is deliberate: hashing a five-hundred-megabyte PDF on every
     * open would make a launch cost a minute to answer a question the file's
     * presence already answers. What can be lost between a write and its
     * commit here is the file, not its bytes' identity — a half-written
     * import leaves no `content.*` at all, because the vault publishes by
     * rename. `contentHash` on the record covers identity, and it travels
     * under the `record` surface, which is digested properly.
     */
    if (what === 'removed') {
      /* The presence register IS the surface: it is what a `removed` commit
       * changes, and what a peer replicates. `readPresence` throws on an
       * unreadable file, which propagates as the error it is. */
      const presence = await readPresence(fs)
      return `presence:${presence[book]?.state ?? 'absent'}`
    }
    if (what === 'cover' || what === 'content') {
      const names = await folderNames(folderOf(book))
      if (names === null) return `${what}:no-folder`
      const held = names.filter((name) => name.startsWith(`${what}.`)).sort()
      return `${what}:${held.length === 0 ? 'none' : held.join(',')}`
    }
    return null
  }

  /**
   * The names in a book's folder, or `null` when there is no folder.
   *
   * `exists` FIRST, so a directory that is gone reads as an absence and one
   * that is present but unreadable THROWS — the rule this whole file is built
   * on (#10). Reading a failed listing as "empty" would let the verify pass
   * certify that a book's bytes are missing when nobody could look.
   */
  const folderNames = async (folder: string): Promise<readonly string[] | null> => {
    if (!(await fs.exists(folder))) return null
    return (await fs.readDir(folder)).map((entry) => entry.name)
  }

  /* Best-effort digest for a COMMIT (#6): the kernel writers pass none, so
   * one is computed from the just-written folder — that is what lets the
   * verify pass detect a durable commit paired with a lost data write. A
   * read that fails here must NOT fail the write, so it commits without a
   * digest — and a digest-less commit is honestly OUTSIDE the verify pass's
   * reach (it compares stored digests): the cost of one unreadable
   * post-write read is one commit the unclean-shutdown check cannot judge,
   * not a failed write. */
  const digestForCommit = async (book: string, what: MutationKind): Promise<string | undefined> => {
    try {
      return (await digestOf(book, what)) ?? undefined
    } catch {
      return undefined
    }
  }
  return { of: digestOf, forCommit: digestForCommit }
}
