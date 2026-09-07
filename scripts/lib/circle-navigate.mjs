/**
 * The circle driver's ORCHESTRATION: act-then-observe, and the walk from
 * wherever the app is to a book's Marginalia.
 *
 * ⚠️ **SPLIT OUT BECAUSE EXCLUDING IT WAS NOT HONEST.** `circle-drive.mjs` was
 * added to `COVERAGE_EXCLUDE` on the rule that a process entry cannot be called
 * by a test — which is true of argv, a real stream and an exit code, and was
 * NOT true of these two functions. The audit said so plainly: the excluded file
 * still held polling, navigation and branching, so the exclusion was hiding
 * logic rather than describing a shim. It is a shim now, and this is measured.
 *
 * Both take their dependencies as arguments — `evaluate` and `wait` — so a test
 * needs no socket, no app and no clock.
 */

/**
 * Run a script that CHANGES something, then prove it changed by looking.
 *
 * ⚠️ **THE ASSERTION IS THE OBSERVATION, NOT THE CALL RETURNING.** A click
 * resolves the moment it is dispatched; what matters is whether the app moved.
 * So every mutating step is followed by a separate read that must come back the
 * way it should, or the step fails by name.
 *
 * ⚠️ **AND IT DOES NOT SWALLOW ERRORS.** An earlier version treated a bridge
 * timeout as "probably ran, check anyway", on the strength of having seen a
 * filter land despite one. That evidence was contaminated — the filter had been
 * applied by hand from a separate session minutes earlier — and the real cause
 * was a SyntaxError in a generated script. Swallowing the message would have
 * hidden it permanently. Errors propagate.
 */
export async function act({ evaluate, wait }, socket, script, label, verify, tries = 12) {
  const answer = await evaluate(socket, script, label)
  if (answer && answer.ok === false) return answer
  for (let i = 0; i < tries; i++) {
    await wait(500)
    if (await verify()) return { ok: true, confirmedAfterMs: (i + 1) * 500 }
  }
  return { ok: false, why: label + ': the script ran and the app never reached the expected state' }
}

/**
 * Navigate to a book and open Marginalia. Every step names its own failure.
 *
 * ⚠️ **A DEBUG BUILD IS NOT A RELEASE BUILD, AND THE WAITS WERE TUNED AGAINST
 * ONE.** The 6 s defaults were measured against the release app on the machine
 * running the script. Driving a DEBUG bundle over an ssh tunnel — which is how
 * the far end is reached, because the bridge is debug-only — opening a book
 * means parsing an EPUB with 1 962 rows on the shelf behind it, and 6 s is not
 * close. Both failures read as "the app never reached the expected state",
 * which is indistinguishable from a broken selector. Patience costs nothing on
 * success and only delays an honest failure.
 */
export async function reachMarginalia(deps, socket, title, scripts) {
  const { evaluate } = deps
  const { AT_SHELF, TO_SHELF, filterShelf, shelfMatches, openMatch, OPEN_MARGINALIA, READ_MARKS } = scripts
  const read = (script, label) => evaluate(socket, script, label)
  const atShelf = async () => (await read(AT_SHELF, 'where are we')).shelf === true

  if (!(await atShelf())) {
    const back = await act(deps, socket, TO_SHELF, 'go to the shelf', atShelf, 40)
    if (!back.ok) return back
  }
  const narrowed = await act(deps, socket, filterShelf(title), 'narrow the shelf', async () =>
    (await read(shelfMatches(title), 'count the matches')).cells > 0, 40)
  if (!narrowed.ok) return narrowed

  /* Leaving the shelf IS the confirmation that the book opened: the search
     field belongs to the library screen and the reader has none. */
  const opened = await act(deps, socket, openMatch(title), 'open the book', async () => !(await atShelf()), 120)
  if (!opened.ok) return opened

  const pane = await act(deps, socket, OPEN_MARGINALIA, 'open Marginalia', async () =>
    (await read(READ_MARKS, 'look for share controls')).rows.length > 0, 60)
  if (!pane.ok) return pane
  return { ok: true }
}
