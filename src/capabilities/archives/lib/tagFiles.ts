import { ARCHIVE_MAX_BYTES, tooLarge, type FilePicker, type IndexedBook } from '../../../kernel'
import { archiveName, exportTags, parseArchive, type TagArchive } from './tagArchive'

/**
 * The archive's two ends: a file the reader chooses, and the document
 * `tagArchive` knows how to build and read.
 *
 * Split from `tagArchive` for the reason everything in this codebase is split
 * from its storage — what an archive CONTAINS is a set of small decisions worth
 * testing, and none of them need a filesystem. This half needs one and has no
 * decisions in it worth testing.
 *
 * NO PATH EXISTS HERE. Both operations go through `services.files`, so the file
 * is one the reader pointed at, and what comes back is a handle with its name
 * and the verb the reader asked for: there is no path to construct or to keep.
 */

/**
 * Offer the reader's filing as a file. Resolves to whether it was written: false
 * when the dialog was dismissed — which is not a failure and says nothing.
 */
export async function exportTagsToFile(
  files: FilePicker,
  books: readonly IndexedBook[],
  now: Date,
): Promise<boolean> {
  const file = await files.pickSave(archiveName(now), [{ name: 'Paper tags', extensions: ['json'] }])
  if (!file) return false
  /* Pretty-printed on purpose. This is a document the reader keeps, may open in
   * a text editor, and may well repair by hand — the whole reason it exists is
   * that their filing was previously locked inside three hundred files. Two
   * spaces of indent is a rounding error against that. */
  await file.writeText(JSON.stringify(exportTags(books), null, 2))
  return true
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
export async function importTagsFromFile(
  files: FilePicker,
): Promise<{ archive: TagArchive | null } | null> {
  const file = await files.pickOpen([{ name: 'Paper tags', extensions: ['json'] }])
  if (!file) return null
  /* ⚠️ **THE SIZE IS ASKED BEFORE THE FILE IS READ**, and it used to be asked
   * never. `readText` takes the whole thing into memory and `parseArchive`
   * validates afterwards — so a crafted archive, or an ordinary huge one picked
   * by mistake, exhausted memory or froze the interface before a single field
   * had been looked at. A bound that runs after the read has not bounded
   * anything. */
  const size = await file.size()
  if (size > ARCHIVE_MAX_BYTES) throw tooLarge('That tags file', size, ARCHIVE_MAX_BYTES)
  return { archive: parseArchive(await file.readText()) }
}
