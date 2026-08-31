/**
 * What a book's declared identifier says about the WORK (WI-21.3).
 *
 * ## Why this exists at all
 *
 * `BookRecord.identifier` is `dc:identifier` verbatim — whatever the publisher
 * put in the OPF. Two builds of one work almost never spell it the same way:
 *
 * ```
 * urn:isbn:9780142437247      a commercial EPUB
 * ISBN 0-14-243724-7          the same work, ten-digit, hyphenated
 * urn:uuid:2701-…             Standard Ebooks mints its own
 * https://www.gutenberg.org/ebooks/2701
 * ```
 *
 * Compared as strings, the first two disagree about a book they both name. So
 * the plan's acceptance criterion — *"survives sync to a second device and
 * DERIVES THE SAME WORK KEY there"* — had no callable surface and no test
 * oracle until this: `rg 'workKey|isbn13|isbn:'` returned nothing across the
 * whole tree.
 *
 * ## What it is not
 *
 * ⚠️ **NOT A CLAIM THAT TWO BOOKS ARE THE SAME BOOK.** Two editions of one work
 * share neither ISBN nor UUID, and a publisher reissuing a book mints a new
 * one. An equal key is strong evidence; an unequal key is almost no evidence at
 * all. Nothing here may be read as *"these are different works"*.
 *
 * ⚠️ **AND NOT AN ANCHOR.** Knowing two files are the same work says nothing
 * about where a passage is in either — that is the whole subject of Stage 2 and
 * this does not touch it.
 *
 * PURE, and browser-safe by construction: string work over a string, no
 * platform binding anywhere in the module, so a capability cannot drag the
 * subtree out of a browser's reach (`check-browser-safe.mjs`).
 */

/** How confident the key is — see the warnings above. */
export type WorkKeyKind =
  /** A valid ISBN, normalised to its thirteen-digit form. The strongest. */
  | 'isbn'
  /** A UUID the publisher minted. Stable per build, rarely shared between. */
  | 'uuid'
  /** Anything else the book declared, normalised but not understood. */
  | 'opaque'

export interface WorkKey {
  readonly kind: WorkKeyKind
  /** `<kind>:<value>` — one string, so two of these compare with `===`. */
  readonly key: string
}

/* The schemes a `dc:identifier` wears an ISBN under. `urn:` is the correct
 * spelling and the other two are what real books carry. */
const ISBN_PREFIX = /^(?:urn:)?isbn[:\s-]*/iu
const UUID_PREFIX = /^(?:urn:)?uuid[:\s-]*/iu
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * A book's identifier as a comparable key, or null when it declares nothing.
 *
 * NULL RATHER THAN A KEY OVER AN EMPTY STRING, because *"this book declares no
 * identifier"* and *"this book declares the empty identifier"* must not be the
 * same value: every book with no identifier would otherwise share one key and
 * be one work.
 */
export function workKey(identifier: string | undefined): WorkKey | null {
  const declared = (identifier ?? '').trim()
  if (declared === '') return null

  const asIsbn = isbn13(declared)
  if (asIsbn) return { kind: 'isbn', key: `isbn:${asIsbn}` }

  const uuid = declared.replace(UUID_PREFIX, '').trim().toLowerCase()
  if (UUID_SHAPE.test(uuid)) return { kind: 'uuid', key: `uuid:${uuid}` }

  /* Everything else, normalised only as far as is SAFE — which is whitespace
   * and nothing else.
   *
   * ⚠️ **CASE IS NOT FOLDED HERE, and it was.** The comment already said "two
   * identifiers that differ in any other character are two identifiers"; the
   * code then lowercased, which contradicts it. A `dc:identifier` is very often
   * a URI, and a URI's path is case-SENSITIVE — so folding merged identifiers
   * that name different things, in the branch that exists precisely because
   * nothing here understands what the value means. The two normalisations look
   * equally harmless and only one of them is.
   *
   * ⚠️ **AND INTERNAL WHITESPACE IS NOT SQUEEZED EITHER, which it was.** The
   * justification was that a value differing by an XML indent is the same value
   * badly serialised — but `<dc:identifier>` pretty-printing puts that
   * whitespace at the ENDS, which the `trim` above already removes. A DOUBLE
   * SPACE INSIDE an identifier is not a serialisation artefact; it is a
   * character, in a scheme this branch exists because it does not understand.
   *
   * The asymmetry at the top of this file decides it: an equal key is strong
   * evidence and an unequal one is almost none, so a false MERGE costs far more
   * than a false SPLIT. Squeezing risks the expensive error to avoid the cheap
   * one. Trimmed, and otherwise exactly as the book declared it. */
  return { kind: 'opaque', key: `id:${declared}` }
}

/** True when two books declare identifiers naming the same work. */
export function sameWork(a: string | undefined, b: string | undefined): boolean {
  const left = workKey(a)
  const right = workKey(b)
  /* TWO ABSENT IDENTIFIERS ARE NOT A MATCH. Most books on a shelf declare
   * nothing; treating `null === null` as agreement would make the whole
   * library one work, which is the single worst answer this can give. */
  return left !== null && right !== null && left.key === right.key
}

/**
 * A valid ISBN as its thirteen-digit form, or null.
 *
 * ⚠️ **THE CHECK DIGIT IS VERIFIED, not merely the shape.** A ten-digit run in
 * a Gutenberg URL is not an ISBN, and calling it one would merge two unrelated
 * works under one key — the failure mode this module can least afford, since an
 * equal key is the strong signal. An invalid ISBN falls through to `opaque`,
 * where it is still compared, just not believed.
 */
function isbn13(declared: string): string | null {
  /* Only from a value that ANNOUNCES itself as an ISBN, or is nothing but
   * digits. Hunting for a digit run inside arbitrary text would find the `2701`
   * in a Gutenberg URL and the year in a title. */
  const announced = ISBN_PREFIX.test(declared)
  const body = declared.replace(ISBN_PREFIX, '')
  const digits = body.replace(/[\s-]/gu, '').toUpperCase()
  /* ⚠️ NINE DIGITS THEN `[0-9X]`, not ten-then-optional-X. An ISBN-10's check
     digit can be `X` for ten, and it REPLACES the tenth digit rather than
     following it — a `{10,13}X?` shape refuses every such book, which is
     roughly one in eleven of them, while looking entirely reasonable. */
  if (!announced && !/^(?:[0-9]{9}[0-9X]|[0-9]{13})$/u.test(digits)) return null

  if (/^[0-9]{9}[0-9X]$/u.test(digits)) {
    let sum = 0
    for (let i = 0; i < 10; i++) {
      const digit = digits[i] === 'X' ? 10 : Number(digits[i])
      sum += digit * (10 - i)
    }
    if (sum % 11 !== 0) return null
    /* ISBN-10 → ISBN-13 is the whole reason this returns a normal form: one
     * build declares the ten-digit number and another the thirteen, and they
     * name the same work. `978` plus the first nine digits, with the check
     * digit recomputed — the ten-digit check digit does not carry over. */
    const core = `978${digits.slice(0, 9)}`
    return `${core}${ean13Check(core)}`
  }

  /* ⚠️ `978` OR `979`, NOT ANY VALID EAN-13. Every ISBN-13 lives in one of
     those two GS1 prefixes; a thirteen-digit barcode outside them is a tin of
     beans, and its check digit is just as valid. Accepting one would mint an
     `isbn:` key — the STRONGEST signal this module gives — for two unrelated
     things, which is the one failure it can least afford. */
  if (/^97[89][0-9]{10}$/u.test(digits)) {
    const core = digits.slice(0, 12)
    return digits[12] === ean13Check(core) ? digits : null
  }

  return null
}

/** The thirteenth digit of an EAN-13, from the first twelve. */
function ean13Check(core: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}
