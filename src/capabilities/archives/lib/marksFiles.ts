import {
  ARCHIVE_MAX_BYTES,
  tooLarge,
  type Card,
  type FilePicker,
  type IndexedBook,
  type Mark,
} from '../../../kernel'
import {
  archiveName,
  archiveText,
  exportMarks,
  parseArchive,
  toMarkdown,
  type MarksArchive,
} from './marksArchive'

/**
 * The archive's two ends: a file the reader chooses, and the document
 * `marksArchive` knows how to build and read.
 *
 * Split for the reason everything in this codebase is split from its storage —
 * what an archive CONTAINS is a set of small decisions worth testing, and none
 * of them need a filesystem. This half needs one and has no decisions in it
 * worth testing.
 *
 * NO PATH EXISTS HERE. Both operations go through `services.files`, so the file
 * is one the reader pointed at, and what comes back is a handle with its name
 * and the verb the reader asked for: there is no path to construct or to keep.
 */

/**
 * What a completed export did, so the caller can say it in a sentence.
 *
 * `format` is here because the reader chose it and the sentence should reflect
 * what they got: Markdown is a reading copy that cannot be imported back, and
 * telling them "exported" without saying which would let someone keep a
 * Markdown file as their only backup.
 */
export interface MarksExport {
  readonly format: 'json' | 'md'
  readonly books: number
  readonly marks: number
  readonly cards: number
}

/**
 * Offer the reader's marginalia as a file. Resolves to null when the dialog was
 * dismissed — which is not a failure and says nothing.
 *
 * THE FORMAT FOLLOWS THE NAME the reader typed. Two dialogs, or a format
 * switch beside the file picker, is a second decision in a surface that already
 * asks one; the extension is a decision they are making anyway. `.md` is
 * rendered from the same document `.json` is written from — see `toMarkdown`.
 */
export async function exportMarksToFile(
  files: FilePicker,
  books: readonly IndexedBook[],
  marks: readonly Mark[],
  cards: readonly Card[],
  now: Date,
): Promise<MarksExport | null> {
  const file = await files.pickSave(archiveName(now), [
    { name: 'Paper marginalia', extensions: ['json'] },
    { name: 'Markdown (a reading copy)', extensions: ['md'] },
  ])
  if (!file) return null
  const archive = exportMarks(books, marks, cards)
  const format: 'json' | 'md' = /\.md$/i.test(file.name) ? 'md' : 'json'
  await file.writeText(format === 'md' ? toMarkdown(archive) : archiveText(archive))
  return {
    format,
    books: archive.books.length,
    marks: archive.books.reduce((sum, book) => sum + book.marks.length, 0),
    cards: archive.books.reduce((sum, book) => sum + book.cards.length, archive.looseCards?.length ?? 0),
  }
}

/**
 * Read an archive the reader points at.
 *
 * Three outcomes, kept apart because they need different sentences: `null` for
 * a dismissed dialog, which deserves no message at all; a thrown error for a
 * file that could not be read, which is the disk's problem; and a `null`
 * document for a file that is not an archive, which is the reader having picked
 * the wrong file and is worth saying plainly.
 *
 * JSON ONLY, and the filter says so. Markdown is a reading copy — it carries no
 * anchors and no colours, so parsing it back would produce marks that look like
 * the reader's and are not.
 */
export async function importMarksFromFile(
  files: FilePicker,
): Promise<{ archive: MarksArchive | null } | null> {
  const file = await files.pickOpen([{ name: 'Paper marginalia', extensions: ['json'] }])
  if (!file) return null
  /* ⚠️ **THE SIZE IS ASKED BEFORE THE FILE IS READ**, and it used to be asked
   * never. `readText` takes the whole thing into memory and `parseArchive`
   * validates afterwards — so a crafted archive, or an ordinary huge one picked
   * by mistake, exhausted memory or froze the interface before a single field
   * had been looked at. A bound that runs after the read has not bounded
   * anything. */
  const size = await file.size()
  if (size > ARCHIVE_MAX_BYTES) throw tooLarge('That marginalia file', size, ARCHIVE_MAX_BYTES)
  return { archive: parseArchive(await file.readText()) }
}
