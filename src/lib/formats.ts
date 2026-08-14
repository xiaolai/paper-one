/**
 * What the reader accepts.
 *
 * `.pdf` is here again. It was withdrawn once because foliate-js has no PDF
 * loader and rejected every PDF as an unsupported type — a picker offering a
 * format the app then refused. It comes back in the same change that gives PDFs
 * a reader of their own, which is the condition it was withdrawn under.
 *
 * It lives here rather than beside the file input because the input belongs to
 * the window — the palette, the switcher and the reader's empty state can all
 * ask for books, so there is one picker rather than one per surface.
 */
export const ACCEPT_FORMATS = '.epub,.pdf,.mobi,.azw3,.cbz,.fb2,.fbz'

/**
 * Which of the two readers a source belongs to.
 *
 * Here rather than in `reader/pdf.ts` because that module imports pdf.js, which
 * touches browser globals the moment it loads — so anything importing it needs
 * a DOM, including a test that only wants to know whether a filename ends in
 * `.pdf`. Routing is a question about the source, not about the renderer.
 *
 * Getting it wrong is silent in the worst way: a PDF handed to foliate is
 * rejected as an unsupported type, an EPUB handed to pdf.js fails to parse, and
 * neither says which reader made the mistake.
 */
export function isPdf(source: File | string): boolean {
  if (typeof source === 'string') return /\.pdf(\?|#|$)/i.test(source)
  return source.type === 'application/pdf' || /\.pdf$/i.test(source.name)
}

/**
 * A file name without its extension, for a PDF that carries no title.
 *
 * The query and the fragment come off first. `isPdf` accepts them — a URL
 * ending `.pdf?download=1` is a PDF — so a title taken straight from the last
 * path segment kept them, and the library showed the book as
 * `attention-is-all-you-need.pdf?download=1`: the extension still on it,
 * because the pattern that strips it anchors at the end of the string.
 */
export function titleFromSource(source: File | string): string {
  const name =
    typeof source === 'string'
      ? (source.split(/[?#]/)[0] ?? source).split('/').pop() || source
      : source.name
  return name.replace(/\.pdf$/i, '')
}
