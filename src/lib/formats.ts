/**
 * What the reader accepts.
 *
 * PDF is deliberately ABSENT. foliate-js has no PDF loader and rejects every
 * PDF as an unsupported type, so accepting `.pdf` produced a file picker that
 * offered a format the app then refused. §13's empty state names PDF because
 * the design ships pdf.js; add `.pdf` back in the same change that wires it.
 *
 * It lives here rather than beside the file input because the input moved to
 * the window — the palette and the switcher can both ask for books now, so
 * there is one picker rather than one per surface that wants one.
 */
export const ACCEPT_FORMATS = '.epub,.mobi,.azw3,.cbz,.fb2,.fbz'
