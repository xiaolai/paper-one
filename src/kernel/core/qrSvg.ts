/**
 * A QR the peer plugin rendered, made safe to inline.
 *
 * ⚠️ **HERE BECAUSE TWO SURFACES NEED IT, which is the journey `messageOf` made
 * on 2026-09-06 and for the same reason.** It lived beside one of them, and the
 * other could not import it — so that second screen showed a raw
 * `paper://pair?…` URL instead: a hundred percent-encoded characters carrying a
 * key and a list of the reader's LAN addresses, presented to a human as if it
 * were something to read. One copy, reachable by both, is the fix that was
 * already learned once.
 *
 * The SVG is this process's own Rust rendering a URI it just minted — trusted
 * markup, not remote content — and it is inlined rather than put in an `<img>`
 * so the theme's colours reach it.
 */
export function inlineQrSvg(svg: string): string {
  /* The XML declaration is legal in a standalone file and illegal inside an
     HTML document, where it is parsed as a bogus comment and shows up as text
     above the picture. */
  return svg.replace(/^\s*<\?xml[^?]*\?>\s*/i, '')
}
