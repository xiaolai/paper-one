import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { inTauri } from './appStorage'
import type { IndexedBook } from '../core/bookIndex'
import { archiveName, exportTags, parseArchive, type TagArchive } from '../core/tagArchive'

/**
 * The archive's two ends: a file the reader chooses, and the document
 * `tagArchive` knows how to build and read.
 *
 * Split from `tagArchive` for the reason everything in this codebase is split
 * from its storage — what an archive CONTAINS is a set of small decisions worth
 * testing, and none of them need a filesystem. This half needs one and has no
 * decisions in it worth testing.
 *
 * NO PATH IS CONSTRUCTED HERE. Both operations go through a dialog, so the file
 * is one the reader pointed at: that is what extends Tauri's filesystem scope to
 * it, and it is also the only honest way to write outside the app's own data
 * directory. A path assembled in code would be denied, and denied at run time.
 */

/** Whether the archive can be written at all — false in a plain browser tab. */
export function canArchiveTags(): boolean {
  return inTauri()
}

/**
 * Offer the reader's filing as a file. Resolves to the path written, or null
 * when the dialog was dismissed — which is not a failure and says nothing.
 */
export async function exportTagsToFile(
  books: readonly IndexedBook[],
  now: Date,
): Promise<string | null> {
  const path = await saveDialog({
    defaultPath: archiveName(now),
    filters: [{ name: 'Paper tags', extensions: ['json'] }],
  })
  if (!path) return null
  /* Pretty-printed on purpose. This is a document the reader keeps, may open in
   * a text editor, and may well repair by hand — the whole reason it exists is
   * that their filing was previously locked inside three hundred files. Two
   * spaces of indent is a rounding error against that. */
  await writeTextFile(path, JSON.stringify(exportTags(books), null, 2))
  return path
}

/**
 * Read an archive the reader points at.
 *
 * Three outcomes, kept apart because they need different sentences: `null` for
 * a dismissed dialog, which deserves no message at all; a thrown error for a
 * file that could not be read, which is the disk's problem; and a `null`
 * document for a file that is not an archive, which is the reader having picked
 * the wrong file and is worth saying plainly.
 */
export async function importTagsFromFile(): Promise<
  { path: string; archive: TagArchive | null } | null
> {
  const chosen = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: 'Paper tags', extensions: ['json'] }],
  })
  const path = typeof chosen === 'string' ? chosen : null
  if (!path) return null
  return { path, archive: parseArchive(await readTextFile(path)) }
}
