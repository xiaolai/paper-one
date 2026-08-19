/**
 * The colour the window opens in, before any module has loaded.
 *
 * The theme lives on the shell element, so nothing carries a colour until React
 * mounts and the window is raw white until then — a white flash into a dark app
 * for a Night reader, which reads as "something went wrong" rather than as a
 * launch. The hint is the last background the theme resolved to, kept somewhere
 * SYNCHRONOUS: the app's own store is read asynchronously and is therefore too
 * late to paint the first frame with.
 *
 * NOT A SOURCE OF TRUTH, and deliberately not one. The theme is in the settings;
 * this is a cache of one colour, written by `WindowShell` after each render and
 * read by an inline script in `index.html`. Wrong or missing costs a single
 * frame of white and corrects itself on mount, which is what lets it be this
 * cheap and this un-guarded.
 *
 * THE KEY IS WRITTEN TWICE — here, and as a literal in that inline script,
 * which cannot import TypeScript. `paintHint.test.ts` reads the HTML and
 * refuses the day they stop matching, because a renamed key would not fail a
 * build, would not fail a type check, and would show up only as a flash nobody
 * connects to the rename.
 */
export const PAINT_HINT_KEY = 'paper.paint.v1'
