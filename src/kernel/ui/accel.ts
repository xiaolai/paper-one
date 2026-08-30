import type { Platform } from '../core/metrics'
import { PANE_SHORTCUTS } from './panes'
import { paneFits, type KernelPaneId, type PaneId, type Screen } from './state'

/**
 * What ⌘-and-a-key means, as a value.
 *
 * IT WAS A CHAIN OF `if`s INSIDE AN EFFECT, and so the only thing a test could
 * reach was the App source as TEXT: `commands.test.ts` searched it for a quoted
 * key literal and called that proof the key was bound. It is not. A literal in
 * a comment satisfies it; so does one in an unreachable branch, one behind the
 * wrong modifier, and one wired to the wrong action. The palette prints these
 * combos to the reader, and what backed that promise was a substring search.
 *
 * Pure, so the promise can be checked against real key inputs: a key, whether
 * it repeated, and what is possible on screen at that moment go in; the thing
 * to do — or `null`, meaning leave the key to the platform — comes out. App
 * keeps the dispatching, which is the part that needs the effect.
 *
 * `null` IS A REAL ANSWER and not a fallthrough. A combo swallowed in order to
 * do nothing is worse than one left unbound, because the platform's own meaning
 * goes with it — ⌘D with no selection stays the browser's bookmark, ⌘1 on the
 * shelf does what an unbound key does.
 */
export type AccelAction =
  /**
   * ⌘⌃⌥D — developer options on or off.
   *
   * FOUR KEYS ON PURPOSE. This is the only way in: nothing in Settings turns
   * it on, because a switch a reader can find is a switch a reader will find,
   * and what it reveals is a set of panels that do not yet answer what they
   * promise. On Windows and Linux the accelerator is already Ctrl, so the same
   * binding reads as Ctrl+Alt+D there — see `bind`.
   */
  | { readonly kind: 'toggleDeveloper' }
  | { readonly kind: 'togglePalette' }
  | { readonly kind: 'togglePane' }
  | { readonly kind: 'toggleScreen' }
  | { readonly kind: 'markSelection' }
  | { readonly kind: 'toggleBookmark' }
  | { readonly kind: 'editTags' }
  | { readonly kind: 'stepBy'; readonly delta: number }
  | { readonly kind: 'resetStep' }
  | { readonly kind: 'openPane'; readonly pane: KernelPaneId }
  | { readonly kind: 'closePane' }
  | { readonly kind: 'jumpBack' }
  | { readonly kind: 'jumpForward' }
  /** Ctrl+Q, where there is no application menu to own it — see the map. */
  | { readonly kind: 'quit' }

/** What the accelerator map needs to know about the moment the key arrived. */
export interface AccelContext {
  /**
   * Which chrome the window has. Only Ctrl+Q reads it: macOS has a menu whose
   * Quit item owns ⌘Q, and the other two have nothing.
   */
  readonly platform: Platform
  readonly screen: Screen
  /** The open panel, so a digit for it closes rather than re-opens it. */
  readonly pane: PaneId | null
  /** Whether ⌘D has something to mark. */
  readonly hasSelection: boolean
  /** Whether ⌘B has a place it can pin down — see `useBookmarking`. */
  readonly canBookmark: boolean
  /**
   * Whether the READER is the screen in front.
   *
   * Not `screen !== 'library'`: the reader stays mounted under the shelf with a
   * live position, so without this ⌘B on the library bookmarked a page nobody
   * was looking at — silently, since neither the ribbon nor the footer is on
   * screen to show it happened.
   */
  readonly onReader: boolean
  /** Whether ⌘T has a book whose tags it could edit. */
  readonly hasBook: boolean
  /**
   * Whether ⌘[ and ⌘] have anywhere to go — `jumpStack`'s `canGoBack` and
   * `canGoForward`, read here and by the two palette rows so the key and the
   * row it is printed beside cannot disagree. Same rule as `canKeepPlace`.
   */
  readonly canJumpBack: boolean
  readonly canJumpForward: boolean
  /**
   * Whether developer options are on, and which panels are hidden inside them.
   *
   * HERE BECAUSE THE DIGITS READ `paneFits`, and an unfinished panel does not
   * fit for a reader who has not asked for it — so ⌘4 must be dead while Cards
   * is hidden, exactly as it is dead on a screen the panel does not belong to.
   * A key that opens a panel the rail does not draw is the same defect as a
   * rail button that opens nothing.
   */
  readonly developer?: boolean
  readonly hiddenPanes?: readonly string[]
}

/**
 * Whether ⌘B has a place to keep.
 *
 * ONE RULE, TWO SURFACES. The palette decides whether to offer the row and the
 * keyboard decides whether to act on the key, and the two used to spell the
 * same condition out separately — so the palette could advertise "Bookmark this
 * place" while the key it prints beside it did nothing, or the reverse. Both
 * read this.
 */
export function canKeepPlace(context: Pick<AccelContext, 'onReader' | 'canBookmark'>): boolean {
  return context.onReader && context.canBookmark
}

/**
 * A REPEAT IS THE SAME PRESS, for everything that is not a WALK.
 *
 * Holding a combo delivers a keydown every few tens of milliseconds. For a
 * toggle that means the thing flickers for as long as the key is down and its
 * final state depends on where the reader let go — and for ⌘B it also means a
 * row and a tombstone written to the book's marks file on every cycle.
 *
 * SUPPRESSED BY THE ACTION'S KIND, not by a second list of keys. The key set
 * this replaced (`TOGGLES`) was a hand-kept classification of bindings the
 * switch below already encodes, and it drifted exactly as a second list does:
 * `l` was bound to `toggleScreen` and absent from the set, so holding ⌘L
 * flickered between reader and library, and ⌘D re-marked the selection per
 * repeat — a row and a tombstone each cycle, the ⌘B defect on another key.
 * Deriving from the RESULT cannot miss a binding, including the next one.
 *
 * THE WALKS ARE THE DELIBERATE EXCEPTIONS. Holding ⌘+ up §09's ramp and ⌘[
 * back through the jump stack are real gestures with a real result at each
 * repeat; the reducer clamps and the stack bottoms out, so neither needs a
 * guard here.
 */
const REPEATABLE: ReadonlySet<AccelAction['kind']> = new Set(['stepBy', 'jumpBack', 'jumpForward'])

/** The physical key ⌘⌃⌥D is on — see `bind`, which explains why this is a
 *  `code` and not a `key`. */
const DEVELOPER_CODE = 'KeyD'

export function resolveAccel(
  event: {
    readonly key: string
    readonly repeat: boolean
    readonly shiftKey?: boolean
    readonly ctrlKey?: boolean
    readonly altKey?: boolean
    readonly code?: string
  },
  context: AccelContext,
): AccelAction | null {
  const action = bind(event, context)
  if (action === null) return null
  return event.repeat && !REPEATABLE.has(action.kind) ? null : action
}

function bind(
  event: {
    readonly key: string
    readonly shiftKey?: boolean
    readonly ctrlKey?: boolean
    readonly altKey?: boolean
    readonly code?: string
  },
  context: AccelContext,
): AccelAction | null {
  /* CAPS LOCK IS NOT SHIFT. With it latched, `key` for ⌘B is 'B', and every
   * letter shortcut here went dead — while ⇧⌘B stays a different (unbound)
   * combo, which is why the lowercase applies only when shift is UP. The
   * shifted spellings the size steps bind ('+', '_') are unaffected: they
   * arrive with shift down and pass through as themselves. */
  const key = event.key.length === 1 && event.shiftKey !== true ? event.key.toLowerCase() : event.key

  /* ⚠️ **BEFORE THE SWITCH, AND IT HAS TO BE.** `d` is already bound — ⌘D marks
   * the selection — and nothing below reads `ctrlKey` or `altKey`, so ⌘⌃⌥D
   * would fall through and mark instead. Matched here, exclusively, so the
   * four-key chord means one thing and the two-key one still means what it did.
   *
   * ⚠️ **`code`, NOT `key`, AND THE FIRST VERSION GUESSED AT `key`.** It
   * compared against a set spelling the character three ways — `d`, `D`, and
   * `∂` — under a comment asserting that "macOS applies Option to the CHARACTER
   * before the event is dispatched, so the `key` is `∂`". That is true of ⌥D
   * alone and FALSE of this chord: measured in the running app on 2026-08-30,
   * a real ⌘⌃⌥D arrives as `{ key: 'd', code: 'KeyD', metaKey, ctrlKey,
   * altKey }` — with Command held, the unmodified character is what is
   * reported. The guess happened to work, which is the worst way for a guess to
   * survive; the comment explaining it was wrong.
   *
   * `code` is the physical key and is unaffected by every modifier, by Caps
   * Lock, and by whatever AltGr does on a Windows layout — none of which this
   * map can otherwise reason about. It is a second idiom in a file that
   * compares `key` everywhere else, and that is the trade: the rest of the map
   * binds single keys under one modifier, where `key` is exactly right, and
   * this is the only chord that stacks three. */
  if (event.ctrlKey === true && event.altKey === true && event.code === DEVELOPER_CODE) {
    return { kind: 'toggleDeveloper' }
  }

  const digit = PANE_SHORTCUTS.find((entry) => entry.digit === key)

  switch (key) {
    case 'k':
      return { kind: 'togglePalette' }
    case '\\':
      return { kind: 'togglePane' }
    /* UP ONE LEVEL, the same toggle the titlebar button and the palette entry
       do. Bound because the button's tooltip names it, and a tooltip naming a
       key nothing binds is the app describing a feature it does not have. */
    case 'l':
      return { kind: 'toggleScreen' }
    case 'd':
      return context.hasSelection ? { kind: 'markSelection' } : null
    /* ⌘B: keep this place, or give it back. Only where a place can be pinned
       down, on exactly the reasoning ⌘D and ⌘T are guarded by. */
    case 'b':
      return canKeepPlace(context) ? { kind: 'toggleBookmark' } : null
    /* ⌘T: the tags of the book being read — the palette's "Tags for this
       book…". Only when there is such a book. */
    case 't':
      return context.hasBook ? { kind: 'editTags' } : null
    /*
     * ⌘[ and ⌘] — back to where you were, and forward again.
     *
     * NOT IN `TOGGLES`, deliberately. Holding ⌘[ to walk back several jumps is
     * a real gesture with a real result at each repeat, exactly as the size
     * steps below are, and the stack bottoms out on its own — `goBack` returns
     * null on an empty one rather than throwing or wrapping.
     *
     * Guarded, so an empty stack leaves the combo to the platform rather than
     * swallowing it to do nothing.
     */
    case '[':
      return context.canJumpBack ? { kind: 'jumpBack' } : null
    case ']':
      return context.canJumpForward ? { kind: 'jumpForward' } : null
    /*
     * Ctrl+Q, OFF macOS ONLY. macOS has an application menu whose Quit item
     * owns ⌘Q (`lib.rs` `install_quit_item`), and AppKit takes the key before
     * the webview sees it; Windows and Linux have no menu bar, so until this
     * the only quit there was the window's close button. What the action does
     * is CLOSE THE WINDOW — `useWindowClose` intercepts that and runs the
     * teardown, the same one ⌘Q's handshake runs — never a bare exit, which
     * would leave the sync journal's flag up exactly as the red button once
     * did. On macOS the key is left to the platform, which already has it.
     */
    case 'q':
      return context.platform === 'macos' ? null : { kind: 'quit' }
    /*
     * §09's reading sizes, on the combo every reader already knows.
     *
     * BOTH SPELLINGS OF EACH KEY, because the shifted and unshifted forms
     * arrive as different `key` values: ⌘+ on a US layout is ⌘⇧= and reports
     * '+', while ⌘= reports '='. Binding one of the pair gives a shortcut that
     * works or not depending on whether the reader held shift.
     *
     * The reducer clamps, so pressing on at either end of the ramp is a no-op
     * rather than something to guard here.
     */
    case '=':
    case '+':
      return { kind: 'stepBy', delta: 1 }
    case '-':
    case '_':
      return { kind: 'stepBy', delta: -1 }
    case '0':
      return { kind: 'resetStep' }
    default:
      break
  }

  /* NOT ON A SCREEN THAT HAS NO SUCH PANEL. `openPane` falls back rather than
     failing, which is right for a palette entry the reader chose by name — and
     wrong for a digit: pressing ⌘1 for Contents on the library and being given
     Marginalia is a key that does something else, silently. */
  if (
    !digit ||
    !paneFits(context.screen, digit.pane, {
      developer: context.developer ?? false,
      hiddenPanes: context.hiddenPanes ?? [],
    })
  ) {
    return null
  }
  /* A TOGGLE, exactly as the palette row behaves — the row for an open panel
     says "Close" and carries this combo, so the combo has to close it too.
     Returning `openPane` unconditionally made the shortcut re-open a panel its
     own advertised label promised to close: one command, two behaviours by
     entry point. */
  return context.pane === digit.pane ? { kind: 'closePane' } : { kind: 'openPane', pane: digit.pane }
}

/**
 * §11's reading keys — what a plain key means to an open book, as a value.
 *
 * ⚠️ **→ AND THE RIGHT CHEVRON MOVED OPPOSITE WAYS IN A RIGHT-TO-LEFT BOOK.**
 * The arrows were bound in `App` to `next`/`prev` — an ORDER — while the
 * chevrons and the trackpad go through `goLeft`/`goRight` — a SIDE — which the
 * fork resolves from the book's own `dir` (`view.js`: `goRight` is `prev` when
 * `book.dir === 'rtl'`). So in an RTL book the → key turned to the next page,
 * which is on the left, and the → chevron beside it turned to the previous one.
 * An arrow key is a side, exactly as a chevron is. PageUp, PageDown and Space
 * are an order and stay one: "on by a screen" has no side.
 *
 * Pure, for the reason `resolveAccel` is: the map was a chain of `if`s inside
 * `App`'s effect, and the only test that could reach it was a search of the
 * source for a key literal. What is returned is the NAVIGATOR'S verb, so the
 * side-to-direction question is asked of the book rather than answered here.
 *
 * `null` leaves the key to the platform. ⇧arrow is a SELECTION in every text
 * surface there is — without that guard the page turned instead, which also
 * made the paginator's keyboard-selection branch unreachable — and ⇧Space is
 * the published binding for the previous page, the one shifted key this map
 * owns. The caller keeps the guards that are about the MOMENT: a control under
 * focus, a field being typed in, a key something else already handled.
 */
export type PageVerb = 'next' | 'prev' | 'goLeft' | 'goRight'

export function resolvePageKey(event: {
  readonly key: string
  readonly code: string
  readonly shiftKey: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}): PageVerb | null {
  /* A SYSTEM-MODIFIED KEY IS NOT A READING KEY. The caller strips only the
   * platform's primary accelerator before asking here, so Ctrl-, Meta- and
   * Alt-arrows — window management, word movement, history — arrived looking
   * plain and turned the page out from under the gesture they belong to.
   * Shift stays: it is handled below, where ⇧Space is the one shifted key
   * this map owns. */
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null
  /* BY KEY OR BY CODE: `key` is ' ' on every current engine and 'Spacebar' on
     an older one, and `code` is the physical key either way. */
  const space = event.key === ' ' || event.code === 'Space'
  if (event.shiftKey) return space ? 'prev' : null
  switch (event.key) {
    case 'ArrowRight':
      return 'goRight'
    case 'ArrowLeft':
      return 'goLeft'
    case 'PageDown':
      return 'next'
    case 'PageUp':
      return 'prev'
    default:
      return space ? 'next' : null
  }
}
