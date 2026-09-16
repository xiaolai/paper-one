import type { Platform } from '../core/metrics'
import { PANE_SHORTCUTS } from './panes'
import { paneAvailable, paneFits, type KernelPaneId, type PaneId, type Screen } from './state'

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
  /**
   * Look up the selection — ⌃⌘D on macOS, Ctrl+Shift+D elsewhere (phase 17,
   * L4). See `bind` for why the two platforms need two chords.
   */
  | { readonly kind: 'lookUp' }
  /** Ctrl+Q, where there is no application menu to own it — see the map. */
  | { readonly kind: 'quit' }
  /**
   * A HELD KEY'S REPEAT: TAKEN, AND NOTHING DONE — see `REPEATABLE`.
   *
   * ⚠️ **NOT `null`, AND IT WAS.** `null` hands the key to the platform, so a
   * suppressed repeat came back indistinguishable from an unbound key: the
   * first press was Paper's and was consumed, and every repeat after it went
   * to whatever the webview does with that combo. A key belongs to one owner
   * for as long as it is held. Found by the 2026-09-13 audit.
   *
   * ⚠️ **AND THAT FIX STOPPED AT THE FIRST REPEAT** (round 3, #86): whether a
   * repeat was taken was still asked of the binding as it stood at the repeat,
   * and a press can change that answer itself — see `pressTaken`.
   */
  | { readonly kind: 'held' }

/** What the accelerator map needs to know about the moment the key arrived. */
export interface AccelContext {
  /**
   * Which chrome the window has — and so what Control is. Three things read
   * it: Ctrl+Q (macOS has a menu whose Quit item owns ⌘Q, and the other two
   * have nothing), Look up (⌃⌘D on a Mac, Ctrl+Shift+D elsewhere), and the
   * letters' modifier guard (Control is an extra modifier on a Mac and the
   * accelerator everywhere else). This said "only Ctrl+Q reads it" until the
   * 2026-09-13 audit — true until Look up arrived.
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
  /**
   * Whether Look up has a selection and something to act with — `LookUp.press`
   * being non-null, which is also what decides whether the palette offers the
   * row. Absent is false: the key is left to the platform, which on macOS is
   * the system's own Look Up.
   */
  readonly canLookUp?: boolean
  /**
   * Whether the press a REPEAT belongs to was taken — resolved to an action
   * rather than left to the platform. Read only on a repeat; absent is false.
   * `App` remembers it per physical key, from the first keydown to its keyup.
   *
   * ⚠️ **ASKED OF THE PRESS, BECAUSE THE PRESS CHANGES THE ANSWER** (2026-09-13
   * audit, #86, round 3). A repeat used to be resolved like a first press and
   * then suppressed, so its owner was whatever the binding said at THAT moment
   * — and ⌘D marks the selection, marking clears it, and from the next repeat
   * on `hasSelection` was false: `null`, and the rest of the hold went to the
   * platform. ⌘[ on the press that empties the stack did the same. The first
   * press decides who owns the key; nothing it does can hand the key on.
   */
  readonly pressTaken?: boolean
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
 *
 * A SUPPRESSED REPEAT IS STILL TAKEN — it resolves to `held`, never to `null`.
 * See `held`. And a walk that has run out mid-hold — the stack bottomed out
 * under ⌘[ — is `held` too, rather than handed on: see `pressTaken`.
 */
const REPEATABLE: ReadonlySet<AccelAction['kind']> = new Set(['stepBy', 'jumpBack', 'jumpForward'])

/** The physical key ⌘⌃⌥D is on — see `bind`, which explains why this is a
 *  `code` and not a `key`. */
const DEVELOPER_CODE = 'KeyD'

/**
 * One keydown, as much of it as the map reads.
 *
 * ONE SHAPE FOR BOTH FUNCTIONS. `bind` spelled it out a second time, without
 * `repeat`, so a modifier the map started reading had two places to be added.
 */
interface AccelEvent {
  readonly key: string
  readonly repeat: boolean
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly metaKey?: boolean
  readonly code?: string
}

export function resolveAccel(event: AccelEvent, context: AccelContext): AccelAction | null {
  const action = bind(event, context)
  if (!event.repeat) return action
  /* A REPEAT BELONGS TO WHOEVER TOOK THE PRESS — see `pressTaken`. Paper's:
     a walk walks on, and everything else, including a binding the press itself
     has since switched off, is `held`. The platform's: it stays the
     platform's, whatever became bindable while the key was down. */
  if (context.pressTaken !== true) return null
  return action !== null && REPEATABLE.has(action.kind) ? action : { kind: 'held' }
}

/* Without `repeat`: whether a press repeated is `resolveAccel`'s question,
   asked of the binding this returns. */
function bind(event: Omit<AccelEvent, 'repeat'>, context: AccelContext): AccelAction | null {
  /* CAPS LOCK IS NOT SHIFT. With it latched, `key` for ⌘B is 'B', and every
   * letter shortcut here went dead. So a key is read in lower case, whatever
   * case it arrived in; the shifted spellings the size steps bind ('+', '_')
   * have no case to lose.
   *
   * ⚠️ **WHATEVER CASE, AND IT WAS ONLY A SINGLE CHARACTER WITH SHIFT UP**
   * (2026-09-14). Neither condition could change an answer, and the mutation
   * sweep said so. ⇧⌘B stays a different combo because `plain` below refuses
   * Shift for every letter — the case never stood for Shift, since an engine
   * may report `b` with Shift down — and no case below names a key longer than
   * one character. One that does (`Escape`) must spell it in lower case, which
   * its own test says the first time it runs. */
  const key = event.key.toLowerCase()

  /* ⚠️ **FOUR MODIFIERS, AND EVERY ONE IS READ — META WAS NOT** (2026-09-13
   * audit, #85, round 3). The accelerator is `App`'s to check before asking: ⌘
   * on a Mac, Control elsewhere. Shift and Option are what a layout types a
   * character with. The fourth is neither — Control on a Mac, Meta (⊞, Super)
   * everywhere else — and no layout on any platform types with it, so a combo
   * carrying it is somebody else's: ⌃⌘Q locks a Mac, ⊞ belongs to the Windows
   * shell. Round 1 closed Control on a Mac for the letters and left Meta off a
   * Mac unread, so Ctrl+⊞+Q closed the window on Windows and Ctrl+Alt+⊞+D
   * toggled developer options. The two chords below are the only bindings that
   * mention it, and each names it exactly; nothing after them takes it. */
  const mac = context.platform === 'macos'
  const shift = event.shiftKey === true
  const alt = event.altKey === true
  const control = event.ctrlKey === true
  const stray = mac ? control : event.metaKey === true

  /* ⚠️ **BEFORE THE SWITCH, AND IT HAS TO BE.** `d` is already bound — ⌘D marks
   * the selection — and nothing below read `ctrlKey` or `altKey`, so ⌘⌃⌥D
   * fell through and marked instead. Matched here, exclusively, so the
   * four-key chord means one thing and the two-key one still means what it did.
   * Since the 2026-09-13 audit what follows does read them, and a ⌘⌃⌥D that
   * reached it would be refused rather than marked — so the order is now what
   * lets the chord bind at all, rather than what stops it marking.
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
  /* EXACTLY THESE MODIFIERS. Shift was never read, so ⇧ added to the chord
     was still the chord (2026-09-13 audit). Control and Option beside the
     accelerator — which off a Mac IS Control — so on a Mac the stray modifier
     is part of the chord, and off one it is refused (round 3, #85). */
  /* AND OFF A MAC THE KEY MUST BE THE PLAIN LETTER: AltGr types with Control and
     Alt there, and on a layout where AltGr+D types a character (Hungarian: đ),
     `key` is that character — which is typing, not this chord (2026-09-14). */
  if (event.code === DEVELOPER_CODE && control && alt && !shift && (mac || (!stray && key === 'd'))) {
    return { kind: 'toggleDeveloper' }
  }

  /* ⌃⌘D — LOOK UP — AND THE SAME TRAP AS THE CHORD ABOVE: `d` is ⌘D below, so
   * this is matched first and exclusively, on the physical key.
   *
   * TWO SPELLINGS, BECAUSE THE PLATFORMS DISAGREE ABOUT WHAT CONTROL IS. On
   * macOS ⌃⌘D is the system's own Look Up chord, which a Mac reader already
   * knows — binding the same meaning to it is the point. Elsewhere the
   * accelerator IS Control, so "Control and the accelerator" is one key and the
   * chord would collapse into ⌘D; Ctrl+Alt+D is already the developer chord
   * there. Shift is the free modifier, and `comboFor` prints it as such.
   *
   * WITH NOTHING TO LOOK UP THE KEY IS LEFT ALONE, which on macOS hands it back
   * to the platform's Look Up rather than swallowing it to do nothing.
   *
   * AND NO THIRD MODIFIER: ⇧⌃⌘D on a Mac looked up too, until the 2026-09-13
   * audit. Off a Mac Control is the accelerator, which `App` has checked — and
   * Meta is the stray, which Ctrl+Shift+⊞+D carried unread until round 3. */
  if (event.code === DEVELOPER_CODE && !alt && (mac ? control && !shift : shift && !stray)) {
    return context.canLookUp === true ? { kind: 'lookUp' } : null
  }

  /* ⚠️ **ALTGR IS CONTROL AND ALT OFF A MAC** (2026-09-14). Chromium on Windows —
   * and so WebView2 — reports AltGr as `ctrlKey` and `altKey` together, with
   * `key` the character it types. Control is the accelerator there and Alt was
   * left free for a layout, so on a German layout AltGr+8, which types `[`,
   * arrived as Ctrl+Alt+[ and jumped back instead of typing the bracket. Off a
   * Mac, Control with Alt is a character being typed, and binds nothing: the
   * developer chord above is the one binding that names Alt there, and it takes
   * only the plain letter.
   *
   * GROUPED AS THE ONE KEY THEY ARE. Ungrouped, the platform test paired with
   * Control, and `(!mac || control) && alt` — the halves regrouped — differed
   * only for an event with no accelerator, which `App` never asks about. */
  if (!mac && (control && alt)) return null

  /* NOTHING BELOW TAKES THE STRAY MODIFIER — letter, character or digit. The
     characters are free of Shift and Option on purpose (see `plain`), and that
     reason does not reach this one: it types nothing on any layout. */
  if (stray) return null

  const digit = PANE_SHORTCUTS.find((entry) => entry.digit === key)

  /* ⚠️ **A LETTER IS BOUND UNDER THE ACCELERATOR ALONE**, and nothing in the
   * switch below read a modifier — so ⌥⌘B, ⌃⌘L and Ctrl+Alt+Q, which closes the
   * window, all took a letter's binding. Shift had only the case-keeping that
   * sat above standing for it, which holds only on an engine that reports a shifted
   * letter in upper case; one reporting `b` for ⇧⌘B bookmarked. Found by the
   * 2026-09-13 audit.
   *
   * THE LETTERS ONLY, and that is the rule rather than a first step. Every
   * other key here is a CHARACTER, and which modifiers produce one is the
   * layout's business: ⌘+ is ⇧= on a US board, a digit is shifted on AZERTY,
   * `[` is ⌥5 on a German Mac. `key` already names the character, so refusing
   * a modifier there would unbind the combo on exactly the layouts that need
   * one. A Latin letter needs none on any of them. The fourth modifier was
   * refused above for every key, which is why it is not named here. */
  const plain = !shift && !alt

  switch (key) {
    case 'k':
      return plain ? { kind: 'togglePalette' } : null
    /* NOT WHERE THERE IS NO PANE — see `paneAvailable`. Resolved on a
       contributed screen, the key was taken in order to do nothing, which is
       what `null` exists to prevent (2026-09-13 audit). */
    case '\\':
      return paneAvailable(context.screen) ? { kind: 'togglePane' } : null
    /* UP ONE LEVEL, the same toggle the titlebar button and the palette entry
       do. Bound because the button's tooltip names it, and a tooltip naming a
       key nothing binds is the app describing a feature it does not have. */
    case 'l':
      return plain ? { kind: 'toggleScreen' } : null
    case 'd':
      return plain && context.hasSelection ? { kind: 'markSelection' } : null
    /* ⌘B: keep this place, or give it back. Only where a place can be pinned
       down, on exactly the reasoning ⌘D and ⌘T are guarded by. */
    case 'b':
      return plain && canKeepPlace(context) ? { kind: 'toggleBookmark' } : null
    /* ⌘T: the tags of the book being read — the palette's "Tags for this
       book…". Only when there is such a book. */
    case 't':
      return plain && context.hasBook ? { kind: 'editTags' } : null
    /*
     * ⌘[ and ⌘] — back to where you were, and forward again.
     *
     * IN `REPEATABLE`, deliberately — this said "not in `TOGGLES`", naming the
     * list `REPEATABLE` replaced, until the 2026-09-13 audit. Holding ⌘[ to walk
     * back several jumps is a real gesture with a real result at each repeat,
     * exactly as the size steps below are, and the stack bottoms out on its own
     * — `goBack` returns null on an empty one rather than throwing or wrapping.
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
      return context.platform === 'macos' || !plain ? null : { kind: 'quit' }
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
  }

  /* NOT ON A SCREEN THAT HAS NO SUCH PANEL. `openPane` falls back rather than
     failing, which is right for a palette entry the reader chose by name — and
     wrong for a digit: pressing ⌘1 for Contents on the library and being given
     Marginalia is a key that does something else, silently. */
  if (
    !digit ||
    !paneFits(context.screen, digit.pane, {
      developer: context.developer ?? false,
      // Stryker disable next-line ArrayDeclaration: a default naming no panel hides nothing, exactly as the empty one does.
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
