/**
 * What a parse says about a book, and where a reader is in it — the two
 * shapes the reader session publishes and the rest of the app reads.
 *
 * Here, in core, because they are DATA and not React: `useBook` publishes
 * them, `reader/session.ts` produces them, intake writes one onto the shelf.
 * When they lived in `useBook.ts` the session had to import its own consumer
 * for a type, which was the one cycle in the tree — type-only, so it ran, and
 * still the wrong direction.
 */

export interface ReaderPosition {
  readonly fraction: number
  readonly chapterLabel: string
  /** Stable identity of the current TOC entry — labels repeat, hrefs do not. */
  readonly chapterHref: string
  /**
   * A CFI naming exactly where the reader is, or null.
   *
   * The precise one of the four: `fraction` is a proportion of the whole book
   * and `chapterHref` names a section, and neither can bring a reader back to
   * the paragraph they stopped at. foliate has been reporting this on every
   * relocate all along; it was discarded in the handler that built this object,
   * three lines from where it was needed.
   *
   * Null for a renderer that does not produce one, so a consumer must treat
   * "no position" and "the start of the book" as different things.
   */
  readonly cfi: string | null
}

export interface BookMeta {
  /**
   * How many pages the book has, or 0 when it has none.
   *
   * A PDF has pages; reflowable text does not, because there the page is a
   * property of the window rather than of the work — two readers at different
   * font sizes are on different pages of the same book, so a page number
   * derived from one of them is a citation the other cannot follow.
   *
   * So this is both a count and a QUESTION ANSWERED: non-zero means "this book
   * can be cited by page", which is what `citation` asks it. Set by `makePdf`;
   * every other backend leaves it 0 without knowing the field exists.
   */
  readonly pageCount: number
  readonly title: string
  readonly author: string
  /**
   * The WORK's own identifier, as the book declares it — `dc:identifier` in an
   * EPUB's OPF, usually a UUID or an ISBN. Empty when the book declares none.
   *
   * Distinct from `bookId`, and both are needed. `bookId` is derived from the
   * bytes and says "this exact file"; this says "this book, whoever's copy".
   * Anything shared between two people has to key on the second, because two
   * readers almost never hold byte-identical files — and foliate has been
   * parsing it all along while `readMeta` discarded it.
   */
  readonly identifier: string
  /**
   * The title to ALPHABETISE by — `dc:title`'s `file-as`, or Calibre's
   * `title_sort`. Empty when the book declares none.
   *
   * It exists because sorting on the displayed title is wrong in every
   * language that has articles: `The Hobbit` belongs under H. foliate has been
   * parsing this all along and Paper sorted on `title` anyway.
   */
  readonly sortAs: string
  /** The series this book belongs to, and where in it. */
  readonly series: string
  readonly seriesIndex: number | null
  /**
   * The publisher's own subject tags — `dc:subject`.
   *
   * Free tags, already in the file, on most commercially produced books. They
   * are what seeds the tag vocabulary rather than asking a reader to invent one
   * from nothing.
   */
  readonly subjects: readonly string[]
  readonly publisher: string
  /** As the book declares it. NOT parsed into a date — see `readMeta`. */
  readonly published: string
  readonly languages: readonly string[]
  readonly description: string
  readonly subtitle: string
}
