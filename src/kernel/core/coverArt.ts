/**
 * A book's actual jacket, kept as a file beside its bytes.
 *
 * The shelf drew a hash-derived colour with the title printed on it, and called
 * that a cover. foliate has exposed `book.getCover()` the whole time.
 *
 * THE BLOB IS NEVER STORED AS DATA, and that is the constraint everything here
 * is shaped by. A jacket is tens of kilobytes; base64'd into a book's record it
 * would be read and rewritten on every position save. So a cover is a FILE —
 * `cover.webp` inside the book's own folder — and because that path is derived
 * from the book's id, there is no field naming it and nothing to go stale.
 *
 * They are downscaled once, on the way in, rather than on the way out. A
 * publisher's jacket is routinely 1600px wide and the shelf draws it at a
 * couple of hundred; decoding the full image per cell is how a shelf of forty
 * books drops frames, and it would do it on every render rather than once ever.
 */

import type { VaultFs } from './bookVault'
import { coverPathIn, folderOf, legacyCoverPathIn } from './bookFolder'

/**
 * Roughly twice the widest the shelf draws a cover.
 *
 * Twice rather than exactly, because the grid is responsive and a Retina panel
 * asks for two device pixels per CSS pixel. Past that the extra detail is
 * decoded, held and thrown away.
 */
export const COVER_WIDTH = 400

/**
 * WEBP, and quality below what a photographer would accept.
 *
 * A jacket is a thumbnail here, not an artwork. PNG would keep text crisper but
 * costs several times the bytes on the photographic covers that dominate, and
 * these are written once per book and read on every shelf render.
 *
 * JPEG, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE. This asked for
 * WebP for two rounds of this file's history and never once got it. First it
 * encoded JPEG under the name `cover.webp`; that was called fixed, and the
 * bytes then became PNG under the same name, because WebKit's `convertToBlob`
 * substitutes PNG for any type it cannot encode and the canvas spec permits it
 * to do so silently. Measured in Paper's own WebView:
 *
 *   convertToBlob({type: 'image/webp'})  ->  image/png
 *   convertToBlob({type: 'image/jpeg'})  ->  image/jpeg
 *   convertToBlob({type: 'image/png'})   ->  image/png
 *
 * So WebP was never available here, two different formats shipped under a name
 * that described neither, and every decoder sniffed its way past the mismatch
 * so nothing ever broke and nothing ever said so. A book's folder is meant to
 * be a directory somebody can hand to somebody else.
 *
 * JPEG is the one of the three that is both honoured and small — PNG would keep
 * text crisper and cost several times the bytes on the photographic covers that
 * dominate. The file is `cover.jpg`, and the check below asserts the bytes
 * match the name rather than trusting that they do.
 */
const COVER_TYPE = 'image/jpeg'
const COVER_QUALITY = 0.82

/**
 * The browser bits this needs, injected so the decision logic can be tested.
 *
 * `createImageBitmap` and `OffscreenCanvas` are the parts that only exist in a
 * webview. Keeping them behind a parameter is what lets everything ABOVE the
 * decode — whether to fetch a cover at all, what to do when a book has none,
 * what happens when the image is corrupt — be asserted without a DOM.
 */
export interface ImageOps {
  decode: (blob: Blob) => Promise<{ width: number; height: number; close?: () => void }>
  encode: (
    source: { width: number; height: number },
    width: number,
    height: number,
  ) => Promise<Blob | null>
}

export const browserImageOps: ImageOps = {
  decode: (blob) => createImageBitmap(blob),
  encode: async (source, width, height) => {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, width, height)
    const encoded = await canvas.convertToBlob({ type: COVER_TYPE, quality: COVER_QUALITY })
    /* REFUSES THE MISMATCH rather than filing it. The encoder is allowed to
     * ignore what it was asked for — substituting PNG is spec-compliant and
     * silent — and this file's whole history is that substitution going
     * unnoticed twice, because `cover.jpg`'s name comes from `COVER_TYPE` and
     * not from the bytes.
     *
     * A warning was tried here and is not enough: it records the defect in a
     * console nobody reads while the mislabelled file is written anyway. There
     * is a correct answer available — no jacket at all, which the shelf already
     * draws a tint for and which is honest — so this takes it. A cover is a
     * thumbnail; losing one costs a reader nothing they can name, while a
     * folder full of files that misdescribe themselves costs whoever opens it
     * an afternoon. */
    if (encoded.type !== COVER_TYPE) {
      console.error(
        `Paper: asked the canvas for ${COVER_TYPE} and it returned ${encoded.type} — `
          + 'refusing to file a cover under a name that misdescribes it',
      )
      return null
    }
    return encoded
  },
}

/** At least one whole pixel — see `scaledTo`. */
const whole = (n: number): number =>
  Number.isFinite(n) && n >= 1 ? Math.round(n) : 1

/** The size a jacket is stored at, preserving its aspect ratio. */
export function scaledTo(
  width: number,
  height: number,
  max = COVER_WIDTH,
): { width: number; height: number } {
  /* WHOLE POSITIVE PIXELS, whatever arrives. A decoded bitmap reporting 0, or a
   * `max` of NaN from a caller doing arithmetic on an absent measurement, came
   * straight back out — and `new OffscreenCanvas(NaN, NaN)` is a canvas that
   * draws nothing, so the book lost its jacket for a reason no error mentioned. */
  const w = whole(width)
  const h = whole(height)
  const cap = whole(max)
  // Never ENLARGED. A small cover blown up costs bytes and adds nothing, and a
  // book whose jacket is 60px wide should stay 60px rather than become a
  // 400px-wide blur.
  if (w <= cap) return { width: w, height: h }
  return { width: cap, height: Math.max(1, Math.round((h * cap) / w)) }
}

/**
 * Shrink a jacket to shelf size.
 *
 * Returns null rather than throwing when the image cannot be decoded. A book
 * with a corrupt cover is a book that opens fine and has no picture, and
 * failing the whole open over one would be the wrong trade by a wide margin.
 */
export async function downscaleCover(
  blob: Blob,
  ops: ImageOps = browserImageOps,
  max = COVER_WIDTH,
): Promise<Blob | null> {
  try {
    const bitmap = await ops.decode(blob)
    try {
      const size = scaledTo(bitmap.width, bitmap.height, max)
      return await ops.encode(bitmap, size.width, size.height)
    } finally {
      // `ImageBitmap` holds decoded pixels outside the JS heap and is not
      // collected on its own. Importing a folder without this is a memory leak
      // measured in the size of the whole library's artwork.
      bitmap.close?.()
    }
  } catch {
    return null
  }
}

/**
 * Read a stored jacket back as a URL an `<img>` can use.
 *
 * A blob URL rather than Tauri's asset protocol, because the asset protocol
 * needs its own capability and its own scope — a second grant, over the same
 * directory the app already has, to do something the bytes already in hand can
 * do. The caller owns the URL and must revoke it; a shelf that forgets leaks
 * one per cover per render.
 */
export async function coverUrl(fs: VaultFs, path: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(path)
    /* NO TYPE ASSERTED, and now for one reason rather than two. Nothing written
     * from here on is anything but JPEG — `browserImageOps.encode` refuses to
     * return anything else — but a library written before that holds JPEG and
     * PNG under `cover.webp`, and this reads those too. `<img>` sniffs the
     * bytes regardless, which is precisely why the old mismatch went unnoticed
     * for as long as it did. */
    return URL.createObjectURL(new Blob([bytes as BlobPart]))
  } catch {
    return null
  }
}

/**
 * A book's jacket, wherever it happens to live.
 *
 * ONE PLACE THAT KNOWS ABOUT THE OLD NAME. Covers are written as `cover.jpg`
 * now; every library written before that has `cover.webp`, holding perfectly
 * good JPEG or PNG bytes. Blanking a reader's whole shelf to correct a
 * filename would be a poor trade, so the old name is still read — here, once,
 * rather than at each of the callers that would each have to remember.
 *
 * There is no migration and deliberately so: renaming files on disk to satisfy
 * a naming rule risks a reader's library for a cosmetic gain, and a stale
 * `cover.webp` costs one extra `readFile` that misses, for books imported
 * before today, once per cell.
 */
/**
 * Where a jacket comes from, as far as a VIEW is concerned.
 *
 * A component drawing a cover needs "a URL for this book, or null" and nothing
 * else. It should not know what a `VaultFs` is, which is why this is a function
 * and not a filesystem: the desktop binds `coverIn` over the real vault, and a
 * browser — which has no vault — can bind something that fetches over its
 * channel without `BookCover` learning a second way to exist.
 *
 * `null` means "no jacket", never "not looked yet". The caller draws the tint.
 *
 * ## The signal, and the shelf it exists for
 *
 * ⚠️ **THERE WAS NO WAY TO CANCEL A COVER**, and the shelf is virtualised. A
 * cell that scrolled off screen unmounted, revoked whatever URL eventually
 * arrived, and left the read itself running: over a channel that is a whole
 * `cover.read` stream — every chunk of a jacket nobody will look at, decoded,
 * against a byte budget shared with the book being read. A flick through a
 * library of two thousand rows started hundreds of them and cancelled none.
 *
 * Optional because a source may not be able to honour it — a synchronous
 * filesystem read has nothing to interrupt — but every source must at least
 * ACCEPT it, and none may hand back a URL for a read that was abandoned. That
 * last part is what stops an abort from turning into a leak: `BookCover`
 * revokes what it is given, and a source that resolves after the abort with a
 * freshly minted URL gives it to nobody.
 */
export type CoverSource = (bookId: string, signal?: AbortSignal) => Promise<string | null>

export async function coverIn(fs: VaultFs, bookId: string): Promise<string | null> {
  return (await coverUrl(fs, coverPathIn(bookId))) ?? coverUrl(fs, legacyCoverPathIn(bookId))
}

/**
 * A jacket out of a parsed book, however the backend chooses to hand one over.
 *
 * `getCover` IS NOT ALWAYS A PROMISE. foliate's FB2 backend assigns
 * `book.getCover = () => null` for a book with no cover art, so `.catch()`
 * written straight onto the result is `undefined.catch` — a TypeError. Both
 * callers had written exactly that: the reader's own open, where it would have
 * turned a jacketless FB2 into a failed cover fetch inside a floating promise,
 * and the enrichment pass, where the throw escaped the parse and failed the
 * WHOLE book — and a failed parse still stamps `parsedAt`, so every jacketless
 * FB2 would have been marked done and left at its filename permanently.
 *
 * ONE FUNCTION because there were two copies of the mistake, and only one was
 * found by reading; the other fell out of correcting the `Book` type, which had
 * promised something the fork never delivered.
 *
 * `Promise.resolve` takes both shapes and the `try` takes the throwing ones. A
 * book without a picture is not a book that failed.
 */
export async function coverFrom(book: {
  getCover?: () => Promise<Blob | null> | Blob | null
}): Promise<Blob | null> {
  try {
    return (await Promise.resolve(book.getCover?.())) ?? null
  } catch (cause) {
    console.warn('Paper: could not read the jacket out of this book', cause)
    return null
  }
}

/**
 * Put a book's jacket in its folder, if it has not got one already.
 *
 * ONE WRITE PATH, for the two places a jacket now arrives from: the reader
 * opening a book, and the enrichment pass parsing one nobody has opened. They
 * were about to be the same eight lines twice — downscale, make the folder,
 * write the file, swallow the failure — and the second copy is where the
 * `exists` check or the downscale quietly goes missing.
 *
 * RETURNS whether a jacket is now on disk, which is not the same as whether one
 * was written: a book that already had one answers true without doing anything.
 * No caller consults it today — the comment used to claim the enrichment pass
 * reported progress with it, which it never did. It is kept because the
 * question "is this book's jacket handled" is the one a caller would ask, and
 * answering it costs nothing here while re-deriving it costs two `exists`.
 *
 * NEVER THROWS. A book without a picture is not a book that failed — the shelf
 * has drawn a derived tint for jacketless books all along, and that is a
 * legitimate answer rather than an error state.
 */
export async function keepCover(
  fs: VaultFs,
  bookId: string,
  cover: Blob | null,
): Promise<boolean> {
  try {
    /* ALREADY THERE beats everything else, and it is asked FIRST — before the
     * cover is even looked at. Asked after, a book that already had a jacket
     * but was handed a null answered "no jacket on disk", which is the opposite
     * of the truth this function claims to return.
     *
     * BOTH NAMES, because `coverUrl` reads both: a library written before the
     * name was made honest is full of `cover.webp`, and checking only the
     * current name meant the pass decided every one of those books had no
     * jacket and wrote a second one beside the perfectly good first. */
    if (await fs.exists(coverPathIn(bookId))) return true
    if (await fs.exists(legacyCoverPathIn(bookId))) return true
    if (!cover) return false
    const small = await downscaleCover(cover)
    if (!small) return false
    await fs.mkdir(folderOf(bookId))
    /* ⚠️ WRITTEN BESIDE, THEN RENAMED INTO PLACE.
     *
     * This wrote straight to the final path, and the existence check above
     * treats ANY file at that path as a finished cover. So a write interrupted
     * by a full disk, a crash or a quit left a truncated file that every later
     * call accepted — the jacket is permanently broken and the pass that exists
     * to regenerate it declines to, because something is already there.
     *
     * A rename over the same filesystem is atomic: the final path either does
     * not exist or holds a complete file. The temporary is cleaned up when the
     * write fails, so a failure leaves nothing behind either. */
    const bytes = new Uint8Array(await small.arrayBuffer())
    const finished = coverPathIn(bookId)
    const partial = `${finished}.writing`
    try {
      await fs.writeFile(partial, bytes)
      await fs.rename(partial, finished)
    } catch (cause) {
      /* Best effort: the write is what failed, and a leftover `.writing` is
         inert — nothing reads that name. */
      try {
        await fs.remove(partial)
      } catch {
        /* nothing to undo */
      }
      throw cause
    }
    return true
  } catch (cause) {
    console.error('Paper: could not keep the cover', cause)
    return false
  }
}
