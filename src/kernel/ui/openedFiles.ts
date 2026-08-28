import { readBookAt, type PickedBook } from '../core/bookFiles'

/**
 * Books the LAUNCH carried — a double-click in the Finder, a path on the
 * command line, a second launch that the first absorbed.
 *
 * The shell (`src-tauri/src/opened.rs`) turns all three into one event with
 * the paths, after admitting each to the fs scope so the read below can
 * succeed. It holds anything that arrives before the webview is listening,
 * because a file opened AT launch is known to Rust before this module has
 * loaded — an event emitted then goes into nothing, and the book the reader
 * double-clicked never opens, silently. So the composition root registers
 * its listener and only then says READY; the shell hands over what it held.
 *
 * From here the books take the picker's route, not the drop's: a path is kept
 * beside the bytes, so the shelf can reopen the book — a `File` alone is a
 * handle granted for one session, which is the whole reason `bookFiles.ts`
 * exists.
 */

/** The shell's event. Payload: absolute paths, as strings. */
export const OPEN_FILES_EVENT = 'paper://open-files'
/** The webview's answer, once its listener is up. No payload. */
export const OPEN_FILES_READY_EVENT = 'paper://open-files-ready'

/**
 * How a composition root hands the shell's opened files to the app.
 *
 * `subscribe` registers the handler and returns what stops it. The root says
 * READY to the shell only once the listener is registered — a READY sent
 * before that would have the shell release its queue into nothing.
 */
export interface OpenRequests {
  subscribe(handler: (paths: readonly string[]) => void): () => void
}

/** What one launch yielded: the books that read, and how many did not. */
export interface OpenedHaul {
  /** Deeply readonly: a haul is a fact about one launch, not a worklist. */
  readonly books: readonly PickedBook[]
  /** Paths that could not be read. Distinct from "not a book" — the shell
   *  already kept only books, so a miss here is a real failure. */
  readonly unreadable: number
}

/**
 * Read what the launch carried, ONE AT A TIME — the rule `pickBooks` follows,
 * for the same reason: a stack of large PDFs must not all be in flight at
 * once. One unreadable file does not cost the reader the others.
 */
export async function haulFromPaths(
  paths: readonly string[],
  read: (path: string) => Promise<File> = readBookAt,
): Promise<OpenedHaul> {
  const books: PickedBook[] = []
  let unreadable = 0
  for (const path of paths) {
    try {
      books.push({ file: await read(path), path })
    } catch (cause) {
      /* COUNTED, not swallowed: a book that exists and will not open is a
       * thing the reader needs told, and the shell's own log has the cause. */
      console.error(`Paper: could not read ${path}`, cause)
      unreadable += 1
    }
  }
  return { books, unreadable }
}

/** The sentence a haul's failures earn — the drop's wording, so the two agree. */
export function openedNotice({ books, unreadable }: OpenedHaul): string | undefined {
  if (books.length === 0) {
    return unreadable > 0
      ? `Nothing that was opened could be read — ${unreadable} ${unreadable === 1 ? 'file' : 'files'} failed.`
      : 'Nothing Paper can open was in what was opened.'
  }
  return unreadable > 0 ? `${unreadable} ${unreadable === 1 ? 'file' : 'files'} could not be read.` : undefined
}

export interface OpenedDeps {
  readonly read?: (path: string) => Promise<File>
  /** The picker's route: bytes with their paths, and a note for the final notice. */
  readonly addAndOpen: (picked: readonly PickedBook[], note?: string) => Promise<unknown>
  /** A one-line notice, for a launch that yielded nothing to add. */
  readonly notice: (text: string) => void
}

/** Take what the launch carried: read it, add and open it, or say why not. */
export async function takeOpened(paths: readonly string[], deps: OpenedDeps): Promise<void> {
  const haul = await haulFromPaths(paths, deps.read)
  const note = openedNotice(haul)
  if (haul.books.length === 0) {
    if (note) deps.notice(note)
    return
  }
  await deps.addAndOpen(haul.books, note)
}
