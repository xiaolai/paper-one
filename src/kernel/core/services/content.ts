import type { IndexedBook } from '../bookIndex'
import { contentPathIn, folderOf } from '../bookFolder'
import { CONTENT_EXTENSIONS, readRangeOf } from '../bookVault'
import { CONTENT_BLOB_NAMES, REMOVABLE_BLOB_NAMES, type RemovableBlobName } from '../ports'
import { findBook as find, type ServiceEnvironment } from './environment'
import { descriptorOf, readInput, reqStr } from './input'
import { SERVICE_ERRORS, refuse } from './refusals'
import type { ContentChunk, ContentLocation } from './rows'

/**
 * `content.*` — a book's bytes, as far as they can be described without
 * carrying them (phase 11, WI-11.3/11.5).
 *
 * THE BYTE STREAM IS NOT A SERVICE, and this is the whole reason the noun
 * exists in the table at all. Content moves on the peer plugin's blob path,
 * gated by `blob:read` and verified by BLAKE3 with resume — a path already
 * tested against a flipped byte, a 5 MB interruption resumed, and a folder
 * trashed mid-transfer. A second byte path here would be a second set of
 * those tests, or, far more likely, none.
 *
 * So `content.locate` answers what a caller needs BEFORE opening a blob
 * stream: whether this shelf holds the bytes, what they are, their hash and
 * their size. `size` and `contentHash` may be null, and that is honest rather
 * than lazy — the hash is computed by the plugin and PARSED here, never
 * computed in TypeScript, and no filesystem seam the kernel owns has a
 * `stat`. Null means "nobody here can say", which a caller must be able to
 * tell from zero.
 *
 * ⚠️ `content.read` (phase 18) IS THE EXCEPTION to the paragraph above, and it
 * is a narrow one. It is a READ, not a TRANSFER, and that difference is what
 * makes it safe: no resume, no partial file on disk, no second hash to keep
 * honest. Integrity comes from the TLS the browser client already cannot work
 * without. A browser has no iroh and so cannot take the blob path at all, and
 * the alternative — an HTTP byte endpoint — would have existed on one
 * transport and not the other.
 *
 * `content.evict` deletes THIS DEVICE'S copy and replicates nothing, by
 * construction: the outbox is filtered to `record | marks | removed | cards`,
 * so the `content` commit it journals exists and never pushes. That is what
 * makes eviction device-local by construction rather than by convention — and
 * it is why the verb is `evict` and not `remove`, whose contract in this
 * table is recoverable.
 */

async function locationOf(env: ServiceEnvironment, book: IndexedBook): Promise<ContentLocation> {
  /* THE FOLDER DECIDES, and the cached flag is the fallback — not the other
   * way round.
   *
   * `hasContent` is DERIVED from the folder and CACHED in `index.json`, and
   * the index is explicitly allowed to be behind the records it summarises.
   * Trusting a stale `false` made `content.evict` delete nothing and answer
   * `here: false` over a `content.pdf` that was plainly on disk — the exact
   * shape of a lie the reader cannot see. Asking the folder is one listing,
   * on a call that is about that folder. */
  const stored = await storedNames(env, book.bookId)
  const here = stored.length > 0 || (stored === NOTHING_READABLE && book.hasContent === true)
  return {
    bookId: book.bookId,
    here,
    /* THE SAME FILE THE SIZE DESCRIBES.
     *
     * `storedNames` answers sorted, so this named the LEXICOGRAPHICALLY first
     * file while `size` below asks a port that picks by `CONTENT_EXTENSIONS`
     * order — so a folder holding both `content.azw3` and `content.epub`
     * reported `azw3` with the epub's byte count. Two fields describing two
     * different files, in one answer about one book. Both follow the port's
     * order now. */
    ext: preferredName(stored)?.slice('content.'.length) ?? book.ext ?? null,
    /* Measured only when there is something to measure. */
    format: book.format ?? null,
    contentHash: book.contentHash ?? null,
    size: here ? ((await env.services.sizes()?.contentBytes(book.bookId)) ?? null) : null,
  }
}

/**
 * Which of a folder's content files the answer is ABOUT.
 *
 * `CONTENT_EXTENSIONS` order, because that is what `SizePort.contentBytes`
 * walks — the two have to agree or `ext` and `size` describe different files.
 * A folder is not supposed to hold two, but it can, and an answer that
 * contradicts itself is worse than either half.
 */
function preferredName(stored: readonly RemovableBlobName[]): string | undefined {
  for (const ext of CONTENT_EXTENSIONS) {
    const name = `content.${ext}`
    if (stored.includes(name as RemovableBlobName)) return name
  }
  return stored[0]
}

export function contentLocate(env: ServiceEnvironment) {
  return async (req: unknown): Promise<ContentLocation> => {
    const input = readInput(descriptorOf('content.locate'), req)
    return locationOf(env, find(env, reqStr(input, 'book')))
  }
}

/**
 * Base64 for a slice, without blowing the stack.
 *
 * `btoa(String.fromCharCode(...bytes))` is the one-liner and it throws on a
 * large array — the argument list is the limit, and a 512 KiB chunk is far past
 * it. Built in fixed steps instead.
 */
function base64Of(bytes: Uint8Array): string {
  const STEP = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += STEP) {
    binary += String.fromCharCode(...bytes.subarray(at, at + STEP))
  }
  return btoa(binary)
}

/**
 * How much of a book crosses the wire at once.
 *
 * The envelope caps a frame at 4 MiB and base64 costs four bytes per three, so
 * this has to leave room: 512 KiB of book is about 683 KiB encoded, comfortably
 * under, and small enough that a reader assembling a book does not hold a
 * multi-megabyte string per chunk.
 */
const CHUNK_BYTES = 512 * 1024

export function contentRead(env: ServiceEnvironment) {
  /* A PAGE PER YIELD, not a chunk — every other stream in this table yields an
   * array of rows and every reader of one flattens pages. A bare object here
   * type-checked and then broke the shared drain helper on the first spread. A
   * page of one costs two characters of JSON. */
  return async function* (req: unknown): AsyncIterable<readonly ContentChunk[]> {
    const input = readInput(descriptorOf('content.read'), req)
    const bookId = reqStr(input, 'book')
    const book = find(env, bookId)

    const fs = env.services.fs
    /* NOT AN EMPTY STREAM. A caller that cannot tell "this shelf has no
     * filesystem" from "this book is zero bytes" will write a zero-byte file
     * and call it a book. */
    if (fs === null) throw refuse(SERVICE_ERRORS.unsupported, 'this shelf cannot read bytes')

    /* THE SAME FILE `content.locate` DESCRIBED, and `preferredName` is what
     * makes that one decision rather than two. This took the FIRST stored
     * name, which is `storedNames`'s sort order — so a folder holding both a
     * `content.azw3` and a `content.epub` had `locate` report the epub and its
     * byte count while `read` streamed the azw3. A client sizing a buffer from
     * one and filling it from the other gets a truncated book and no error.
     * A folder is not supposed to hold two; it can, and the answer that
     * contradicts itself is worse than either half. */
    const names = await blobNames(env, book)
    const name = preferredName(names)
    if (name === undefined) {
      throw refuse(SERVICE_ERRORS.notFound, `no content for ${bookId} on this shelf`)
    }
    /* `contentPathIn` takes the BOOK ID and calls `folderOf` itself. Passing
     * an already-folded folder double-applies it and builds a path under a
     * directory that does not exist — which reads as "no content" rather than
     * as a mistake. */
    const path = contentPathIn(bookId, name)

    const from = typeof input['offset'] === 'number' ? input['offset'] : 0
    const want = typeof input['length'] === 'number' ? input['length'] : Number.POSITIVE_INFINITY

    let at = from
    let sent = 0
    for (;;) {
      const take = Math.min(CHUNK_BYTES, want - sent)
      if (take <= 0) return
      const slice = await readRangeOf(fs, path, at, take)
      /* A SHORT ANSWER IS THE END OF THE FILE, which is the only way this loop
       * terminates when no `length` was given. Treating it as an error would
       * make reading a whole book impossible without knowing its size first. */
      if (slice.length === 0) return
      yield [{ bookId, offset: at, bytes: base64Of(slice) }]
      at += slice.length
      sent += slice.length
      if (slice.length < take) return
    }
  }
}

export function contentEvict(env: ServiceEnvironment) {
  return async (req: unknown): Promise<ContentLocation> => {
    const input = readInput(descriptorOf('content.evict'), req)
    const book = find(env, reqStr(input, 'book'))
    /* EVERY stored content file, not the first. A folder holding both a
     * `content.epub` and a `content.pdf` is not supposed to happen — but an
     * eviction that removed one and answered `here: false` would leave the
     * other on disk under a row that says the bytes are gone, which is the
     * shape of a lie the reader cannot see. */
    const names = await blobNames(env, book)
    /* Nothing to delete is not a failure — evicting what is not there is
     * done — and `locationOf` below reports what the folder now holds. */
    /* THE ROW IS SETTLED EVEN WHEN THERE WAS NOTHING TO DELETE.
     *
     * A listing that succeeds and finds no content, against a row still
     * saying `hasContent: true`, is exactly a stale cache — and skipping the
     * refresh left `content.evict` answering `here: false` while the shelf
     * went on offering the book as downloaded until a rescan disagreed. */
    if (names.length === 0 && book.hasContent === true) {
      await env.services.library.refreshContent(book.bookId)
    }
    if (names.length > 0) {
      /* ONE OPERATION, not four. This was: enumerate, `removeBlob` per file
       * (a queued task each), then `refreshContent` (another). Content landing
       * concurrently could interleave between them, and a crash after the
       * deletions but before the refresh left the bytes gone, the mutation
       * unjournalled, and the row still saying the book was downloaded —
       * invisible until a rescan, because `hasContent` is cached.
       *
       * `evictContent` does the existence check, every delete and the row
       * refresh inside a single task on the book's lane and a single journal
       * bracket, so none of those can be separated by another writer. It keeps
       * the same guard `removeBlob` had: a name outside the kernel's closed
       * set is refused rather than turned into a path. */
      /* EVERY removable name, not the ones that happened to be there a moment
       * ago. `blobNames` reads the folder outside the lane, so a landing of a
       * DIFFERENT extension queued ahead of the eviction runs first and is
       * absent from that list — it survives an evict that reports success.
       * The set is small and closed, so offering all of it costs an `exists`
       * apiece and removes the window entirely; which of them are really
       * there is decided inside the lane task.
       *
       * CONTENT NAMES ONLY. This offered `REMOVABLE_BLOB_NAMES`, which also
       * holds `cover.jpg` and the legacy `cover.webp` — so a verb documented
       * as deleting THIS DEVICE'S COPY OF THE BOOK also destroyed its jacket,
       * and the satchel fetched it again over the wire. The cover has its own
       * eviction, in the cache that knows how many jackets this device can
       * afford. */
      await env.services.library.evictContent(book.bookId, CONTENT_BLOB_NAMES)
    }
    return locationOf(env, find(env, book.bookId))
  }
}

/**
 * What this book's content file is called, or null when there is nothing to
 * evict.
 *
 * THE FOLDER IS ASKED FIRST, and that is the fix for a real hole rather than
 * belt and braces. `ext` is DEVICE-LOCAL — how THIS copy happens to be stored
 * — and a book whose bytes arrived over the wire may have none: what travels
 * is `format`. Guessing `epub` for such a record made `content.evict` try to
 * delete `content.epub`, find nothing, and answer as though it had worked
 * while the PDF was still on disk. `hasContent` is derived from the folder,
 * so the folder is where the answer is.
 *
 * The record's own fields are the fallback, for a host with no filesystem to
 * ask. Everything is judged against `REMOVABLE_BLOB_NAMES`, the kernel's
 * closed set, so a name outside it is refused here rather than by the deleter.
 */
async function blobNames(env: ServiceEnvironment, book: IndexedBook): Promise<readonly RemovableBlobName[]> {
  const stored = await storedNames(env, book.bookId)
  if (stored.length > 0) return stored
  /* Looked, and there is nothing there. The cached flag does not get a vote
   * against a folder that answered. */
  if (stored !== NOTHING_READABLE) return []
  if (book.hasContent !== true) return []
  /* Nothing readable in the folder: fall back to what the record says. A
   * refusal here would make an unreadable directory unevictable, and the
   * record is the same answer this had before it could look. */
  const named = (ext: string | null | undefined): RemovableBlobName | null => {
    if (ext === undefined || ext === null || ext === '') return null
    const name = `content.${ext}`
    return REMOVABLE_BLOB_NAMES.has(name) ? (name as RemovableBlobName) : null
  }
  const guessed = named(book.ext) ?? named(book.format)
  return guessed === null ? [] : [guessed]
}

/**
 * Every `content.<ext>` actually in this book's folder, judged against
 * `REMOVABLE_BLOB_NAMES` — the kernel's closed set, so a name outside it is
 * refused here rather than by the deleter. Empty when there is no filesystem
 * or the folder will not read.
 */
async function storedNames(env: ServiceEnvironment, bookId: string): Promise<readonly RemovableBlobName[]> {
  const fs = env.services.fs
  if (!fs) return NOTHING_READABLE
  /* A FOLDER THAT IS NOT THERE HAS NOTHING IN IT, and that is a different
   * answer from "could not look". Both used to collapse into
   * `NOTHING_READABLE`, which falls back to the RECORD's cached flag — so a
   * book whose folder had gone was reported as still holding content on the
   * strength of a stale `hasContent`. Absence is an empty list, which is the
   * truth; anything else keeps the honest "could not look". */
  if (!(await fs.exists(folderOf(bookId)))) return []
  try {
    return (await fs.readDir(folderOf(bookId)))
      .filter((entry) => !entry.isDirectory && entry.name.startsWith('content.'))
      .map((entry) => entry.name)
      .filter((name): name is RemovableBlobName => REMOVABLE_BLOB_NAMES.has(name))
      .sort()
  } catch {
    return NOTHING_READABLE
  }
}

/**
 * The answer `storedNames` gives when it could not LOOK — no filesystem, or a
 * folder that will not read — as opposed to the empty array it gives when it
 * looked and found nothing.
 *
 * One shared instance, compared by identity, because the two cases mean
 * opposite things: "there are no bytes" is an answer, and "nobody could tell"
 * has to fall back to the cached flag rather than be reported as absence.
 */
const NOTHING_READABLE: readonly RemovableBlobName[] = Object.freeze([])
