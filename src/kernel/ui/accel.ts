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

/** What the accelerator map needs to know about the moment the key arrived. */
export interface AccelContext {
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
 * A REPEAT IS THE SAME PRESS, for every combo that TOGGLES.
 *
 * Holding a combo delivers a keydown every few tens of milliseconds. For a
 * toggle that means the thing flickers for as long as the key is down and its
 * final state depends on where the reader let go — and for ⌘B it also means a
 * row and a tombstone written to the book's marks file on every cycle. Found on
 * ⌘B; the same shape was already on the palette, the pane, the tag sheet and
 * every panel digit, so it is refused as a class rather than one key at a time.
 *
 * THE SIZE STEPS ARE DELIBERATELY ABSENT. Holding ⌘+ to walk up §09's ramp is a
 * real gesture with a real result at each repeat, and the reducer clamps at the
 * end; a guard there would break something that works.
 */
const TOGGLES = new Set(['k', '\\', 't', 'b'])

export function resolveAccel(
  event: { readonly key: string; readonly repeat: boolean },
  context: AccelContext,
): AccelAction | null {
  const digit = PANE_SHORTCUTS.find((entry) => entry.digit === event.key)
  if (event.repeat && (TOGGLES.has(event.key) || digit)) return null

  switch (event.key) {
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
  if (!digit || !paneFits(context.screen, digit.pane)) return null
  /* A TOGGLE, exactly as the palette row behaves — the row for an open panel
     says "Close" and carries this combo, so the combo has to close it too.
     Returning `openPane` unconditionally made the shortcut re-open a panel its
     own advertised label promised to close: one command, two behaviours by
     entry point. */
  return context.pane === digit.pane ? { kind: 'closePane' } : { kind: 'openPane', pane: digit.pane }
}
