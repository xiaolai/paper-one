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
 * IT SAYS WEBP BECAUSE THE FILE IS CALLED `cover.webp`. It encoded JPEG under
 * that name — which every decoder sniffs its way past, so nothing broke and
 * nothing said so, and a book's folder is meant to be a directory somebody can
 * hand to somebody else. A file whose name is a lie about its contents is a
 * poor thing to hand over. WebP is also smaller at the same quality, which is
 * the reason the name was chosen in the first place.
 */
const COVER_TYPE = 'image/webp'
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
    return canvas.convertToBlob({ type: COVER_TYPE, quality: COVER_QUALITY })
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
    /* NO TYPE ASSERTED, because the folder can hold either. Covers written
     * before this were encoded JPEG under the name `cover.webp`; ones written
     * since are actually WebP. Declaring a type would be a guess that is wrong
     * for half of them, and `<img>` sniffs the bytes regardless — which is
     * precisely why the mismatch went unnoticed for as long as it did. */
    return URL.createObjectURL(new Blob([bytes as BlobPart]))
  } catch {
    return null
  }
}
