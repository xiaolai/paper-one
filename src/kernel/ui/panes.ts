import { isValidElement, type ReactNode } from 'react'
import type { PaneContext, PaneContribution, PaneRenderer } from '../core/capability'
import { resolvePaneId } from '../core/registry'
import { paneFits, type KernelPaneId, type PaneAudience, type PaneId, type Screen, type Theme } from './state'
import type { Platform } from '../core/metrics'

/**
 * The side pane's panels — one registry, for everyone who names them.
 *
 * There were three: the command palette's list, the pane's own rail, and the
 * titlebar's two shortcuts, each with its own copy of the ids, the labels and
 * the accelerators. Each carried a comment explaining that it was derived from
 * something else so the two could not drift, and they had drifted anyway — the
 * prose around them said "seven panels" while all three listed eight.
 *
 * Icons are NOT here. They are components from an icon package, and a module
 * this low has no business importing one; `SidePane` maps them by id, which is
 * checked because the map is typed by `KernelPaneId`.
 *
 * The kernel's panes are the registry below. A capability's panes arrive
 * through the composition (`PaneContribution`), and the helpers at the foot of
 * this file are how the UI reads them beside the kernel's own.
 */
export interface PaneEntry {
  readonly id: KernelPaneId
  readonly label: string
  /**
   * The §11 accelerator, written the way the design system writes it.
   *
   * ⌘ is the notation, not the key: the handler binds Ctrl on Windows and
   * Linux, so anything DISPLAYING this has to translate — see `comboFor`.
   */
  readonly combo?: string
}

export const PANES: readonly PaneEntry[] = [
  { id: 'toc', label: 'Contents', combo: '⌘1' },
  { id: 'marginalia', label: 'Marginalia', combo: '⌘2' },
  { id: 'search', label: 'Search', combo: '⌘3' },
  { id: 'cards', label: 'Cards', combo: '⌘4' },
  { id: 'companion', label: 'Companion' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  /* NO COMBO. ⌘5 is free, and leaving it that way is deliberate: a reader who
     has never turned developer options on would find a digit in the middle of
     the ramp that does nothing, and one who has does not need a shortcut to a
     panel they opened on purpose. */
  { id: 'dev', label: 'Developer' },
]

/**
 * The panels that mean something on a given screen, in registry order.
 *
 * ONE SIDE PANE, FITTED — rather than a second one for the library. The rail is
 * the same rail and the panels are the same panels; the library simply does not
 * offer the three that would open onto an apology. Which three is `state`'s to
 * say, because that is where the ids are declared and the reducer needs the
 * same answer; asking here as well is how two lists of one thing begin.
 */
export function panesFor(screen: Screen, audience: PaneAudience = {}): readonly PaneEntry[] {
  return PANES.filter((pane) => paneFits(screen, pane.id, audience))
}

/**
 * §11 bound ⌘1…5 to "Contents, marginalia, search, cards, stats"; it is ⌘1…4
 * now that the Reading pane is gone — kernel panes only, and a contributed
 * pane gets no digit.
 *
 * The digits are NOT the rail's order and never were: they are the order the
 * panels were published in, and the rail groups them by what they are for. A
 * digit belongs to a panel, not to a position, so renumbering the map to match
 * the rail would move ⌘3 off Search for readers who have it in their fingers.
 * ⌘2 stayed with this panel through its rename for the same reason.
 */
export const PANE_SHORTCUTS: readonly { combo: string; digit: string; pane: KernelPaneId }[] =
  /* ONE TEST FOR "HAS A COMBO", absent and empty alike. It was two — a `typeof`
     and a separate `!== ''` — and no entry in `PANES` has an empty combo, so the
     second could never be false and nothing could tell it was there.

     ⚠️ **THE COMBO IS DEFAULTED TO A STRING BEFORE IT IS TESTED, rather than
     narrowed by a filter the map then trusted.** Every mutant that widened that
     filter — dropping it, forcing it true, flipping its comparison, replacing
     either `''` — admitted a combo-less pane, and `pane.combo.slice` then threw
     WHILE THIS MODULE WAS BEING IMPORTED. Every covering suite failed to LOAD,
     so no test failed, so Stryker's vitest runner reported six mutants here
     `Survived` that no test could ever have killed (measured 2026-09-14).
     Defaulting first makes each of them an ordinary mutant: the list simply
     comes out wrong, and this file's tests say so. */
  PANES.flatMap(({ combo = '', id }) =>
    combo === ''
      ? []
      : [
          {
            combo,
            // Stryker disable next-line UnaryOperator: every combo in `PANES` is one modifier sign and one digit, so slice(1) and slice(-1) are the same character — a two-modifier combo would tell them apart
            digit: combo.slice(-1),
            pane: id,
          },
        ],
  )

/**
 * The themes, in §05's order — the other registry that was written twice.
 *
 * The palette had one copy and the Settings panel another, with the same ids
 * and the same labels. Here for the same reason the panes are: two lists of the
 * same thing drift the moment one is edited alone.
 */
export const THEMES: readonly { id: Theme; label: string }[] = [
  { id: 'paper', label: 'Paper' },
  { id: 'slate', label: 'Slate' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'sage', label: 'Sage' },
  { id: 'night', label: 'Night' },
]

/* THE TYPEFACE TABLE MOVED to `typefaces.ts`, which is where the faces, their
 * stacks and their optical sizes now live together. It was three tables in
 * three files — this one, a preview table in the settings panel and a reading
 * table in `bookCss` — so a face could be listed here, previewed in a second
 * stack and read in a third, and nothing compared them. */

/** Labels by id, for the pane header and anywhere else that names one. */
export const PANE_TITLES = Object.fromEntries(
  PANES.map(({ id, label }) => [id, label]),
) as Record<KernelPaneId, string>

/**
 * The panel the side pane shows for what the state asks, and its title —
 * against THIS composition. The kernel's panes are always there; a
 * contributed id is looked up in `contributed`; anything else (a pane from a
 * capability no longer composed) resolves to the screen's default, so the
 * pane never opens onto nothing under a title nobody can place.
 */
export function shownPane(
  wanted: PaneId,
  contributed: readonly PaneContribution[],
  fallback: PaneId,
): { id: PaneId; title: string; contribution: PaneContribution | null } {
  const known = contributed.map((pane) => pane.id)
  /* THE FALLBACK IS RESOLVED TOO, against the same composition. Handed a
     contributed id nobody composed, it came back as it went in, with
     `title: undefined` under a declared `string` (#151); resolved, it lands on
     the kernel's default, which is always there. */
  const id = resolvePaneId(wanted, known, resolvePaneId(fallback, known))
  const contribution = contributed.find((pane) => pane.id === id) ?? null
  if (contribution) return { id, title: contribution.label, contribution }
  return { id, title: PANE_TITLES[id as KernelPaneId], contribution: null }
}

/**
 * The value a contributed pane's `render` returned, as something React can
 * draw — the narrowing the opaque `PaneRenderer` defers to here. Refuses, by
 * pane id, a value that is plainly not a node: React would refuse it too, but
 * with "Objects are not valid as a React child" and no word about which
 * capability sent it. What "plainly" can and cannot see is `isReactNode`'s.
 */
export function renderContribution(id: string, render: PaneRenderer, context: PaneContext): ReactNode {
  const value = render(context)
  if (isReactNode(value)) return value
  throw new Error(`pane "${id}" rendered ${describe(value)}, which React cannot show`)
}

/**
 * Whether React might show this — a screen for what plainly cannot be a node,
 * not a proof that the rest can.
 *
 * ⚠️ **IT ACCEPTED ARRAYS AND ELEMENTS AND CALLED THAT `ReactNode`.** React 19
 * also renders any ITERABLE, a portal, and a promise (`use`), and a capability
 * returning one of those from `render` was refused by the check and its pane
 * thrown out — rejected by a predicate claiming to recognise what React accepts.
 *
 * ⚠️ **AND IT CANNOT CLAIM THE REVERSE EITHER** (#153). A portal and a promise
 * are objects with a known marker rather than a shape this can walk, so they
 * are recognised by that. An iterable is recognised by being one and is NOT
 * read, because reading CONSUMES a generator and would leave React nothing to
 * render. So `new Set([{}])` passes here and React refuses it — inside
 * `ContributionBoundary`, which logs the contribution's id. What is refused
 * here, by pane id, is an object, a function, a symbol, or an ARRAY holding
 * one; an array is walked, and one that CONTAINS ITSELF is refused by name
 * (#153) rather than followed until the stack runs out. "Maximum call stack
 * size exceeded" names neither the pane nor the shape, and reads as a fault in
 * Paper.
 *
 * ⚠️ **THE FIRST FIX CARRIED THE ARRAYS BEING WALKED DOWN A RECURSIVE WALK**
 * (2026-09-14, #153), which refused a cycle by name and left arrays that were
 * merely DEEP — no cycle, one inside the next a hundred thousand times —
 * overflowing the stack exactly as the cycle had. The walk is a loop over an
 * explicit path now, and refuses past `MAX_NESTING`; a cycle is simply nesting
 * that never ends, so the bound refuses it too and the list is gone. Arrays already found good are not walked again, so one array reached
 * twice — or sixty-four levels of `[n, n]` — costs one walk rather than two to
 * the sixty-fourth.
 *
 * ⚠️ **A PROMISE SUSPENDS, AND NOTHING ABOVE A CONTRIBUTION CAUGHT THAT.** There
 * was no Suspense boundary in the tree, so a pending one took the root as its
 * boundary and held the whole window blank until it settled (#150). The
 * boundary is in `ContributionBody` now, which is where it belongs — the
 * promise is still let through here, deliberately, because React draws one.
 */
function isReactNode(value: unknown): value is ReactNode {
  if (!Array.isArray(value)) return isLeafNode(value)
  /* THE PATH FROM THE OUTERMOST ARRAY TO THE ONE BEING READ, each with the
     index it has reached — the call stack the recursive walk used, held where
     its depth can be counted. */
  const path: { readonly items: readonly unknown[]; next: number }[] = [{ items: value, next: 0 }]
  const good = new Set<readonly unknown[]>()
  while (path.length > 0) {
    const top = path[path.length - 1]!
    if (top.next === top.items.length) {
      good.add(top.items)
      path.pop()
      continue
    }
    const item = top.items[top.next]
    top.next += 1
    if (!Array.isArray(item)) {
      if (!isLeafNode(item)) return false
    } else if (!good.has(item)) {
      if (path.length === MAX_NESTING) return false
      path.push({ items: item, next: 0 })
    }
  }
  return true
}

/**
 * How many arrays deep a pane may nest them before it is refused.
 *
 * NOT A GUESS AT TASTE: React's own commit walk recurses once per level, so
 * past some depth React overflows the stack itself — anonymously, and leaving
 * the root refusing all further work ("Should not already be working").
 * Measured under jsdom on 2026-09-14: 2,500 levels rendered and unmounted,
 * 3,000 overflowed. A webview's stack is not Node's, so this sits a fifth of
 * the way there; no pane nests arrays anywhere near it.
 */
const MAX_NESTING = 500

/** `isReactNode` for anything that is not an array — the part with no walk. */
function isLeafNode(value: unknown): boolean {
  if (value == null) return true
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return true
    case 'object': {
      if (isValidElement(value)) return true
      /* A PORTAL is an element-like object React marks with its own symbol;
         a PROMISE is what `use` unwraps. Neither can be inspected further
         without doing the rendering this only means to permit. */
      const tagged = value as { $$typeof?: symbol; then?: unknown }
      if (tagged.$$typeof === Symbol.for('react.portal')) return true
      if (typeof tagged.then === 'function') return true
      /* AN ITERABLE IS NOT READ. Consuming a generator here would leave React
         nothing to render — the guard would eat the pane it approved. */
      return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
    }
  }
  /* A function or a symbol. After the switch rather than as its `default`: with
     `default: return false`, removing that return fell out of the switch and
     answered `undefined`, which every caller reads as the same refusal — so the
     mutant could not be told apart from the code. */
  return false
}

/**
 * What a refused value is, for the refusal's message.
 *
 * ONLY WHAT `isReactNode` REFUSES ARRIVES HERE — a function, a symbol, or an
 * object that is not null (an array is one) — so there is no fourth answer.
 * There was one, `typeof value`, behind a test for "an object that is not
 * null" that nothing reaching this could fail.
 */
function describe(value: unknown): string {
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'symbol') return 'a symbol'
  return `an object of ${(value as object).constructor?.name ?? 'unknown'}`
}

/**
 * A combo as this platform writes it.
 *
 * The registry stores ⌘ because the design system is written for macOS.
 * Printed verbatim on Windows and Linux it names a key those keyboards do not
 * have, for a shortcut the app binds to Ctrl — so the palette and every
 * tooltip were telling some readers to press something that does not exist.
 */
/* `Platform`, not the three desktop members it used to name. Widening the type
 * for the browser client (phase 18) made this the boundary where the two jobs
 * `Platform` does came apart: it says which OS CHROME to draw, and it said
 * which KEYBOARD IDIOM to print — and `web` answers the first and not the
 * second. A browser on a Mac still has a ⌘ key.
 *
 * ⚠️ **THAT DAY ARRIVED AND THIS LINE DID NOT NOTICE.** The note used to end
 * "`web` takes the Ctrl branch because the client draws no shortcut anywhere
 * today"; the browser client mounts `Marginalia`, which calls this for its
 * empty state, so every reader on a Mac in a browser was shown `Ctrl+B` for a
 * key their machine does not have.
 *
 * So `web` asks the MACHINE. That is the distinction the note already drew —
 * which OS chrome to draw is a build fact, which keyboard is in front of the
 * reader is not — and it is the only platform where the two can disagree. A
 * native build IS its platform, so every other one answers from it directly.
 *
 * ⚠️ **AND iOS IS AN APPLE KEYBOARD.** The native branch printed Ctrl there,
 * while the web branch already read an iPhone or an iPad as a Mac — two answers
 * for one device (#152). An iPad's keyboard has ⌘, and ⌘ is what iPadOS's own
 * shortcuts use.
 *
 * `navigator.platform` is deprecated and still the only thing every engine
 * agrees on; `userAgentData.platform` is preferred where it exists. Both are
 * hints rather than facts, and the cost of a wrong one is a hint that names the
 * wrong modifier — the same cost as today's, minus the certainty of being
 * wrong on a Mac. */
export function comboFor(combo: string, platform: Platform): string {
  const mac = platform === 'macos' || platform === 'ios' || (platform === 'web' && machineIsMac())
  if (mac) return combo
  /* ⌃⌘ IS SHIFT OFF A MAC — the one chord here that uses Control on macOS
     (Look up, the system's own ⌃⌘D). Elsewhere Control IS the accelerator, so
     "Control and ⌘" would print as Ctrl+Ctrl; `accel.ts` binds Shift there,
     and this prints what it binds. */
  if (combo.startsWith('⌃⌘')) return `Ctrl+Shift+${combo.slice(2)}`
  return combo.replace('⌘', 'Ctrl+')
}

/** Whether the keyboard in front of the reader is a Mac's. Browser only. */
function machineIsMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  // Stryker disable next-line StringLiteral: the last fallback only has to be a string the pattern below refuses, and it refuses the mutant's "Stryker was here!" exactly as it refuses ''
  const named = data?.platform ?? navigator.platform ?? navigator.userAgent ?? ''
  return /mac|iphone|ipad|ipod/i.test(named)
}
