import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { inTauri } from './appStorage'
import type { IndexedBook } from '../core/bookIndex'
import type { Card } from '../core/cards'
import type { Mark } from '../core/marks'
import {
  archiveName,
  exportMarks,
  parseArchive,
  toMarkdown,
  type MarksArchive,
} from '../core/marksArchive'

/**
 * The archive's two ends: a file the reader chooses, and the document
 * `marksArchive` knows how to build and read.
 *
 * Split for the reason everything in this codebase is split from its storage —
 * what an archive CONTAINS is a set of small decisions worth testing, and none
 * of them need a filesystem. This half needs one and has no decisions in it
 * worth testing.
 *
 * NO PATH IS CONSTRUCTED HERE. Both operations go through a dialog, so the file
 * is one the reader pointed at: that is what extends Tauri's filesystem scope
 * to it, and it is also the only honest way to write outside the app's own data
 * directory. A path assembled in code would be denied, and denied at run time.
 */

/** Whether the archive can be written at all — false in a plain browser tab. */
export function canArchiveMarks(): boolean {
  return inTauri()
}

/**
 * What a completed export did, so the caller can say it in a sentence.
 *
 * `format` is here because the reader chose it and the sentence should reflect
 * what they got: Markdown is a reading copy that cannot be imported back, and
 * telling them "exported" without saying which would let someone keep a
 * Markdown file as their only backup.
 */
export interface MarksExport {
  readonly path: string
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
  books: readonly IndexedBook[],
  marks: readonly Mark[],
  cards: readonly Card[],
  now: Date,
): Promise<MarksExport | null> {
  const path = await saveDialog({
    defaultPath: archiveName(now),
    filters: [
      { name: 'Paper marginalia', extensions: ['json'] },
      { name: 'Markdown (a reading copy)', extensions: ['md'] },
    ],
  })
  if (!path) return null
  const archive = exportMarks(books, marks, cards)
  const format: 'json' | 'md' = /\.md$/i.test(path) ? 'md' : 'json'
  /* Pretty-printed on purpose. This is a document the reader keeps, may open in
     a text editor, and may well repair by hand — the whole reason it exists is
     that their marginalia was previously locked inside the app. */
  await writeTextFile(path, format === 'md' ? toMarkdown(archive) : JSON.stringify(archive, null, 2))
  return {
    path,
    format,
    books: archive.books.length,
    marks: archive.books.reduce((sum, book) => sum + book.marks.length, 0),
    cards: archive.books.reduce((sum, book) => sum + book.cards.length, 0),
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
export async function importMarksFromFile(): Promise<
  { path: string; archive: MarksArchive | null } | null
> {
  const chosen = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: 'Paper marginalia', extensions: ['json'] }],
  })
  const path = typeof chosen === 'string' ? chosen : null
  if (!path) return null
  return { path, archive: parseArchive(await readTextFile(path)) }
}
