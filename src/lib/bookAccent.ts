/**
 * A colour that belongs to one book.
 *
 * "Random" in the sense that matters — you cannot predict which hue a book will
 * get, and two books on a shelf look unrelated — but DERIVED, not drawn. The
 * same book is the same colour on every launch, on every machine, forever.
 *
 * That distinction is the whole design. A hue drawn at random each session is
 * noise: it tells the reader nothing, it cannot be recognised, and it makes
 * every screenshot and every test irreproducible. A hue derived from the book's
 * identity is a quiet signature — after a week you know your book by the colour
 * of its edge without reading anything.
 *
 * It is keyed on `bookId`, which is the same content-derived identity marks and
 * positions use, so the colour survives a rename and follows the file rather
 * than its path.
 */

/**
 * FNV-1a, 32-bit.
 *
 * Chosen for spread over SHORT, highly similar strings, which is exactly what
 * these are: `file:` followed by 64 hex characters, or `url:` followed by a
 * path. Summing char codes — the obvious cheap hash — maps such strings onto a
 * narrow band of hues, so a shelf of books would come out in almost the same
 * colour. FNV-1a's multiply-and-mix avalanches a single differing character
 * across the whole word.
 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // `Math.imul` because `*` on a 32-bit-sized value silently goes through a
    // double and loses the low bits that carry the mixing.
    hash = Math.imul(hash, 0x01000193)
  }
  // Unsigned, rather than `Math.abs`: negating is not a bijection on int32 —
  // it folds two hashes onto one value and halves the space for no reason.
  return hash >>> 0
}

/** The hue this book owns, 0–359. */
export function bookHue(bookId: string): number {
  return fnv1a(bookId) % 360
}

/**
 * The book's accent as a CSS colour, or null when no book is open.
 *
 * Saturation and lightness are FIXED and the hue is the only free variable.
 * That is what keeps an arbitrary hue from clashing with §05's five themes:
 * every book lands at the same weight and the same distance from the page, so
 * the mark reads as the same element in a different colour rather than as a
 * different element. Letting the hash pick all three would eventually produce a
 * near-white line on Paper and a near-black one on Night.
 *
 * Night gets a lighter, less saturated value for the ordinary reason — the same
 * colour that sits quietly on white glares on a dark page.
 */
export function bookAccent(bookId: string | null, night: boolean): string | null {
  if (!bookId) return null
  const hue = bookHue(bookId)
  return night ? `hsl(${hue} 42% 62%)` : `hsl(${hue} 46% 52%)`
}
