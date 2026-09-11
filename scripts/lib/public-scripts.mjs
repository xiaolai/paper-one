/**
 * Every script `public-drive.mjs` sends into the webview — the pure half.
 *
 * ⚠️ **SPLIT FOR THE REASON `circle-scripts.mjs` WAS.** The driver is a PROCESS
 * ENTRY: it reads `process.argv`, writes to a real stream, and needs a live
 * WebSocket to a running app. Nothing can call it from a test, so it counts as
 * zero and says nothing about the code that matters. What matters is here,
 * where a test reaches it without an app — and what matters MOST is that these
 * PARSE. The bridge reports a script that never parsed as
 * `Script execution timeout`, and that one message produced three confident
 * wrong causes during the circle's harness. `public-scripts.test.mjs` compiles
 * every one of them.
 *
 * ⚠️ **THE NAVIGATION IS IMPORTED FROM `circle-scripts.mjs` AND NOT COPIED.**
 * `AT_SHELF`, `TO_SHELF`, `filterShelf`, `openMatch` and `shelfMatches` are
 * about the SHELF, not about the circle — they encode that it is virtualised,
 * that React tracks an input's value on the node so the native setter is the
 * only way to type into it, and that a title goes into a selector as a JSON
 * string. Every one of those was paid for once. A second copy here would not
 * stay a copy; it would become a second opinion, which is the reason
 * `gen-feature-ledger.py` holds no feature data of its own.
 *
 * The import direction is admittedly backwards-reading — a public module
 * naming a circle one. It is the smaller wrong: factoring the shelf helpers
 * into a third module means editing a file the circle harness depends on, and
 * that harness is the only evidence the circle has ever crossed two machines.
 *
 * ⚠️ **EVERY SNIPPET BELOW IS AN IIFE RETURNING A JSON STRING.** The bridge
 * hands back whatever the expression evaluates to; a bare arrow function comes
 * back as the source text of a function, which parses as neither an object nor
 * an error and reads downstream as "the app answered something odd".
 *
 * ⚠️ **AND THEY ARE BUILT BY CONCATENATION, NOT BY NESTED TEMPLATE LITERALS.**
 * Interpolation does not re-evaluate its result, so a template returned from a
 * helper and embedded with `${...}` reaches the page as those six characters
 * verbatim. That is a SyntaxError the bridge reports as a timeout.
 */

import { asJs } from './circle-scripts.mjs'

export {
  AT_SHELF,
  TO_SHELF,
  filterShelf,
  openMatch,
  shelfMatches,
  asJs,
  parse,
} from './circle-scripts.mjs'

/**
 * The pane rail's tab for the public capability's pane.
 *
 * `public:book` declares `label: 'Publish'`, and the kernel draws a
 * contributed pane's tab with its label as the `aria-label` — the same shape
 * `OPEN_MARGINALIA` matches for a kernel pane. Matched EXACTLY and trimmed,
 * because "Publish" is a prefix of "Publish notes" and of "Publish…", both of
 * which are buttons inside the pane this tab opens.
 */
export const OPEN_PUBLISH_PANE = `(() => {
  const tab = [...document.querySelectorAll('button,[role="button"]')].find((b) => (b.getAttribute('aria-label') || '').trim() === 'Publish')
  if (!tab) return JSON.stringify({ ok: false, why: 'no Publish tab — either no book is open, or this build does not compose publicSharing' })
  tab.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * The three rows of the Publish pane, by the button each one is showing.
 *
 * ⚠️ **THE STATE IS READ FROM WHICH BUTTON IS DRAWN, NOT FROM A FLAG.** The
 * pane renders `Offer to anyone` OR `Stop offering` and never both, so the
 * label IS the state — and a row that is offering nothing draws neither, which
 * is a third answer (`absentBecause`, or a fingerprint not yet computed) and
 * not a failure. Reporting that as "not offered" would make a book the app
 * refuses to offer look identical to one the reader simply has not offered
 * yet, and the scenario's first step would then wait forever on a control that
 * is never going to appear.
 *
 * ⚠️ **THE ROW LABELS CARRY A CURLY APOSTROPHE** — `Other people’s notes`,
 * U+2019, which is what the JSX contains. A straight `'` matches nothing and
 * reads exactly like a pane that has not rendered.
 */
export const PANE_STATE = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '')
  const buttons = [...document.querySelectorAll('button')]
  const labels = buttons.map((b) => text(b))
  const has = (label) => labels.indexOf(label) !== -1
  const rows = [...document.querySelectorAll('span')].map(text)
  if (rows.indexOf('The file itself') === -1) {
    return JSON.stringify({ ok: false, why: 'the Publish pane is not on screen — its "The file itself" row is not in the DOM' })
  }
  return JSON.stringify({
    ok: true,
    bytes: has('Stop offering') ? 'offered' : has('Offer to anyone') ? 'not-offered' : 'no-control',
    notes: has('Stop publishing') ? 'published' : has('Publish notes') ? 'not-published' : 'no-control',
    canLook: has('Look for some'),
    buttons: labels.filter((l) => l !== ''),
  })
})()`

/**
 * Click one of the pane's buttons by its exact label, in one round trip.
 *
 * ⚠️ **DECIDING AND ACTING IN THE SAME SCRIPT, for `SHARE_FIRST_UNSHARED`'s
 * reason.** The pane re-renders whenever the share state changes, which a
 * fetch round does on its own schedule, so a button located in one call can be
 * a different node by the next. Anything that reads then clicks is a race, and
 * the circle harness lost that race on its first run.
 *
 * A DISABLED button is refused by name rather than clicked. `Publish to anyone`
 * is disabled until the disclosure has loaded (`shared === undefined`), and a
 * click on a disabled button does nothing at all — which would report success
 * and leave the scenario waiting on a publication that was never made.
 */
export const clickPaneButton = (label) =>
  '(() => {\n' +
  '  const want = ' +
  asJs(label) +
  ';\n' +
  '  const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === want);\n' +
  '  if (!b) return JSON.stringify({ ok: false, why: "no button reading " + JSON.stringify(want) + " is on screen" });\n' +
  '  if (b.disabled) return JSON.stringify({ ok: false, why: JSON.stringify(want) + " is on screen but disabled — the app is not ready for it yet" });\n' +
  '  b.click();\n' +
  '  return JSON.stringify({ ok: true, clicked: want });\n' +
  '})()'

/**
 * The reader's own marks and the state of each one's PUBLIC control.
 *
 * The kernel wraps every contributed mark control in `[data-mark-control=<id>]`,
 * which is what makes this indexable — the same handle `READ_MARKS` uses for
 * `circle:share`.
 *
 * ⚠️ **MARGINALIA IS CROSS-BOOK**, and this is the trap that cost the circle
 * harness a run. It lists the reader's writing across the whole library and
 * labels every mark that is NOT from the open book with its book's title. A
 * row must therefore be attributed before it is acted on: publishing "the
 * first unpublished mark" without that check publishes a passage from whichever
 * book happened to sort first, and the far end then waits for notes under a
 * content hash it was never asked about.
 *
 * `state` is read from the control's own text, on `PANE_STATE`'s rule: the
 * control draws `Publish…` before the reader asks, `Publish to anyone` once
 * the disclosure is open, and the sentence `Published.…` once it has landed.
 */
export const READ_PUBLISH_ROWS = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '')
  const rows = [...document.querySelectorAll('[data-mark-control="public:publish"]')].map((control, index) => {
    const body = text(control)
    const holder = control.closest('li') || control.parentElement
    return {
      index,
      state: body.indexOf('Published.') === 0 ? 'published' : body.indexOf('Publish to anyone') !== -1 ? 'asked' : body.indexOf('Publish…') !== -1 ? 'offered' : 'none',
      /* THE CONTROL'S OWN WORDS TRAVEL WITH THE STATE. The first version
         returned only the state, so a publication the app REFUSED — which
         renders its reason right there in the control — was indistinguishable
         from one still in flight, and the driver reported a bare timeout.
         Measured 2026-09-11 on the first real run of public-scenario.sh: a
         harness that says "timed out" while the app is holding up a sentence
         explaining itself is the worst of both.

         NOTE THE ABSENCE OF BACKTICKS IN THIS COMMENT. It lives inside a
         template literal, so one backtick ends the string — this file's own
         header warns about exactly that class, and the first version of this
         comment did it anyway. public-scripts.test.mjs caught it in one run. */
      body: body.slice(0, 300),
      quote: text(holder).slice(0, 160),
    }
  })
  return JSON.stringify({ ok: true, rows })
})()`

/**
 * Open the publish disclosure on the first mark that has not been published.
 *
 * Returns the row's QUOTE, not its index — a stable handle where an index is
 * not, for the same reason `SHARE_FIRST_UNSHARED` returns one. The caller
 * polls on the quote.
 */
export const ASK_FIRST_UNPUBLISHED = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '')
  const controls = [...document.querySelectorAll('[data-mark-control="public:publish"]')]
  if (controls.length === 0) return JSON.stringify({ ok: false, why: 'no public publish control is drawn — either Marginalia is not open, or this build does not compose publicSharing' })
  /* ⚠️ **THE OPEN BOOK'S ROWS ONLY — THE DOCSTRING ABOVE SAID SO AND THE CODE
     DID NOT.** Marginalia lists the reader's writing across the WHOLE library
     and labels every row that is not from the open book with its book's title;
     this walked all of them and published whichever sorted first. An
     independent audit reproduced the cross-book selection on 2026-09-11. The
     kernel marks a foreign row by drawing that title, so a row carrying a
     book-title element is one to skip. */
  /* The row, by walking up until the element carries materially more text than
     the control does — READ_MARKS' method, not a tag name, because the pane's
     markup is not a list. */
  /* The row that OWNS this control.
     ⚠️ **A TEXT-LENGTH CLIMB OVERSHOOTS, AND THE FIRST VERSION USED ONE.** It
     stopped at the first ancestor carrying 20 characters more than the
     control, which for a SHORT highlight is an ancestor holding several rows —
     so a current-book mark inherited a neighbour's placeBook and was skipped
     as foreign. Reproduced by the verification pass on this very fix.
     The boundary is structural, not textual: climb while the ancestor still
     holds exactly one publish control, and stop before the one that holds
     two. */
  const rowOf = (control) => {
    let row = control
    while (row.parentElement) {
      const up = row.parentElement
      if (up.querySelectorAll('[data-mark-control="public:publish"]').length !== 1) break
      row = up
    }
    return row
  }
  /* ⚠️ **THE ATTRIBUTION IS A CLASS, NOT A TEXT PREFIX.** Marginalia gives a
     row from ANOTHER book a placeBook element carrying that book's title, and
     gives the open book's rows none. This is READ_MARKS' selector, unchanged. */
  let sawForeign = 0
  for (const control of controls) {
    const body = text(control)
    if (body.indexOf('Published.') === 0) continue
    const holder = rowOf(control)
    if (holder.querySelector('[class*="placeBook"]') !== null) { sawForeign += 1; continue }
    const button = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Publish…')
    if (!button) continue
    const quote = text(holder).slice(0, 160)
    button.click()
    return JSON.stringify({ ok: true, quote })
  }
  return JSON.stringify({ ok: false, why: 'no unpublished mark of the OPEN book is on screen', skippedOtherBooks: sawForeign })
})()`

/**
 * Type a device id into the pane's "ask who" field.
 *
 * ⚠️ **THROUGH THE NATIVE SETTER, for `filterShelf`'s reason.** React tracks an
 * input's value on the DOM node, so assigning `input.value` directly leaves
 * React's copy stale: the `input` event fires, the component re-renders with
 * the OLD value, and the field looks right on screen while the ask goes out
 * with nothing in it. That is a silent wrong answer, not a visible failure.
 */
export const askWho = (id) =>
  '(() => {\n' +
  '  const want = ' +
  asJs(id) +
  ';\n' +
  '  const el = document.querySelector(\'input[aria-label="A device id to ask"]\');\n' +
  '  if (!el) return JSON.stringify({ ok: false, why: "this build has no field to name a device — it predates the out-of-band ask" });\n' +
  '  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;\n' +
  '  setter.call(el, want);\n' +
  '  el.dispatchEvent(new Event("input", { bubbles: true }));\n' +
  '  return JSON.stringify({ ok: true, asked: want });\n' +
  '})()'

/**
 * Confirm the ONE disclosure that is open, and report that control's own state.
 *
 * ⚠️ **THE DRIVER USED TO CLICK THE FIRST "Publish to anyone" IN THE
 * DOCUMENT AND THEN ACCEPT ANY ROW READING "Published."** Both are wrong for
 * the same reason: neither is tied to the control the run opened. With one
 * disclosure open they happen to agree; with a second row already published —
 * which is every run after the first — the success check passed without the
 * selected passage ever landing. Found by an independent audit, 2026-09-11.
 *
 * Deciding and acting in one script, for SHARE_FIRST_UNSHARED's reason: the
 * pane re-renders on its own schedule, so anything that reads then clicks is
 * a race.
 */
export const CONFIRM_OPEN_DISCLOSURE = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '')
  const controls = [...document.querySelectorAll('[data-mark-control="public:publish"]')]
  const open = controls.filter((c) => text(c).indexOf('Publish to anyone') !== -1)
  if (open.length === 0) return JSON.stringify({ ok: false, why: 'no publish disclosure is open — the ask step did not take, or it was cancelled' })
  if (open.length > 1) return JSON.stringify({ ok: false, why: open.length + ' disclosures are open at once; refusing to guess which one this run opened' })
  const control = open[0]
  const button = [...control.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Publish to anyone')
  if (!button) return JSON.stringify({ ok: false, why: 'the open disclosure draws no confirm button' })
  if (button.disabled) return JSON.stringify({ ok: false, why: 'the confirm button is disabled — the disclosure has not finished loading' })
  /* ⚠️ **THE SELECTED CONTROL IS MARKED, NOT COUNTED.** Success was a
     document-wide "some row says Published.", which any OTHER row landing
     satisfies — the same defect as the count check it replaced, one level in.
     A data attribute set here survives React re-renders of the subtree and
     names exactly the control this run confirmed. */
  control.setAttribute('data-paper-harness', 'selected')
  button.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * Whether exactly one control now reads "Published.", and what it says.
 *
 * Returns the count rather than a boolean so the caller can tell "the one I
 * opened landed" from "some other row was already published".
 */
export const OPEN_DISCLOSURE_STATE = `(() => {
  const text = (el) => (el ? (el.textContent || '').trim() : '')
  const controls = [...document.querySelectorAll('[data-mark-control="public:publish"]')]
  const selected = document.querySelector('[data-mark-control="public:publish"][data-paper-harness="selected"]')
  return JSON.stringify({
    ok: true,
    open: controls.filter((c) => text(c).indexOf('Publish to anyone') !== -1).length,
    published: controls.filter((c) => text(c).indexOf('Published.') === 0).length,
    /* The answer that matters: did the control this run confirmed land? */
    selectedPublished: selected === null ? null : text(selected).indexOf('Published.') === 0,
    selectedSays: selected === null ? null : text(selected).slice(0, 200),
    bodies: controls.map((c) => text(c).slice(0, 200)).filter((b) => b.indexOf('Say this publicly') !== 0),
  })
})()`

/** This device's own share id, as the pane prints it. */
export const MY_SHARE_ID = `(() => {
  const code = [...document.querySelectorAll('code')].map((c) => (c.textContent || '').trim()).filter((t) => t !== '')
  if (code.length === 0) return JSON.stringify({ ok: false, why: 'the pane is not showing a share id — this build predates it, or the peer capability is not running' })
  return JSON.stringify({ ok: true, id: code[0] })
})()`

/** Argument parsing for the driver, here so a test can reach it. */
export function parseArgs(argv) {
  const out = { command: argv[0], port: undefined, title: undefined, label: undefined, at: undefined }
  if (out.command === undefined) return { error: 'a subcommand is required' }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--port') {
      if (value === undefined || !/^\d+$/.test(value)) return { error: '--port needs a number' }
      out.port = Number(value)
      i++
      continue
    }
    if (flag === '--title' || flag === '--label' || flag === '--at') {
      if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
      out[flag.slice(2)] = value
      i++
      continue
    }
    return { error: `unknown argument ${JSON.stringify(flag)}` }
  }
  return out
}
