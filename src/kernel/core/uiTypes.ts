/**
 * The vocabulary of the interface's SHAPE, as types — which screen, which
 * panel, which theme — held here so that code with no React in it can name
 * them: a durable setting under `kernel.theme`, a pane a capability
 * contributes, a service handler answering "which screen is the reader on".
 *
 * `ui/state.ts` re-exports every one of these, so nothing that imported them
 * from there has moved. The doc comments moved with the types, because they
 * are about the types.
 */

/**
 * The two screens there are.
 *
 * `pdf` and `cards` were here and unreachable: a PDF is opened by the reader
 * like any other book — that is the whole point of `makePdf` — and cards are a
 * panel of the side pane, not a screen. They cost more than a dead branch,
 * because a predicate that names one drifts from a predicate that does not:
 * the titlebar counted `pdf` as a reading screen while the chrome fade beside
 * it did not, so the two disagreed about what the reader was looking at.
 */
export type Screen = 'library' | 'reader'

/** The themes, in §05's order. `ui/panes.ts` gives each its label. */
export const THEME_IDS = ['paper', 'slate', 'sepia', 'sage', 'night'] as const
export type Theme = (typeof THEME_IDS)[number]

/**
 * A face id, from the registry in `typefaces.ts`.
 *
 * A STRING rather than a union, because the set is no longer fixed at compile
 * time: which faces exist depends on what the reader's machine has, and a union
 * would have to name every face on every platform in order to describe one.
 * `faceById` resolves an unknown id to the default, so nothing downstream has
 * to handle a face that is not there — a setting carried to a machine without
 * that font falls back rather than failing.
 */
export type Typeface = string

/**
 * The panels of the single side pane — see `ui/panes.ts` for their metadata.
 *
 * Contents and Companion used to live in a separate 340px leading card, which
 * meant two surfaces competing for the same job. One pane holds every tool;
 * the reader stays the only permanent full-width surface.
 *
 * `marginalia` is everything the reader put in a book — marks, the notes on
 * them, the companion's claims, and the places they kept. It was `notes`, and
 * that stopped being true when bookmarks joined it: §15 owns the words mark and
 * note precisely, so a panel holding four things could not name itself after
 * one of them. "Annotations" is the obvious replacement and is the one word §15
 * rules out here.
 *
 * `library` is the collection panel — what the pane holds when the shelf
 * is the screen; it replaced an `import` panel that was one paragraph and a
 * button the toolbar already had.
 *
 * There is no `bookmarks` panel. Places were briefly one, and they belong with
 * the rest of a reader's marginalia instead: the same list, one more filter
 * chip, and a scope chip that says whether it is this book or all of them.
 * Contents stays separate for the reason that pairing fails — it is the BOOK's
 * structure, the same for every reader and editable by none, so a panel with it
 * on top and a reader's own places below would have had a top half that cannot
 * be changed and a bottom half that can.
 *
 * A VALUE as well as a type, because the registry (`registry.ts`) has to
 * answer "is this id one of the kernel's" at runtime — for a remembered pane
 * that names a capability no longer composed — and a union alone cannot be
 * asked. The type is derived from the array so the two cannot drift.
 */
export const KERNEL_PANE_IDS = [
  'toc',
  'companion',
  'marginalia',
  'cards',
  'search',
  'library',
  'settings',
  'dev',
] as const
export type KernelPaneId = (typeof KERNEL_PANE_IDS)[number]

/**
 * The panels that are not finished, and are not shown to a reader who has not
 * asked for them.
 *
 * A LIST RATHER THAN A FLAG ON EACH, because the question "what is unfinished"
 * is asked in four places — the pane rail, the command palette, the accelerator
 * map and the Developer settings band — and four copies of it would drift the
 * way §11's three copies of the pane ids drifted before `panes.ts` existed.
 *
 * `companion` is a whole capability with a settings section and a model behind
 * it; `cards` is the kernel's own and has a study surface with no scheduler
 * under it yet. Both draw a panel a reader can open and neither answers what
 * the panel promises, which is the property this list names — not "new", not
 * "experimental", but *the reader would be right to expect more than this*.
 *
 * ⚠️ **REMOVING AN ID FROM HERE IS HOW A FEATURE SHIPS.** It is the only edit
 * required: the rail, the palette, the digit and the band all read this.
 */
export const UNFINISHED_PANE_IDS: readonly KernelPaneId[] = ['companion', 'cards']

/**
 * Whether a panel is one the reader may see right now.
 *
 * TOTAL AND PURE, so the four surfaces that ask cannot answer differently. A
 * finished panel is always visible; an unfinished one needs developer mode AND
 * not to have been hidden inside it.
 *
 * `hidden` is consulted ONLY under developer mode, which is what makes the
 * stored value harmless: a reader who never opens developer options cannot end
 * up with a list that means anything, and one who turns it off gets the plain
 * app back whatever they ticked while it was on.
 */
export function paneOffered(
  pane: PaneId,
  developer: boolean,
  hidden: readonly string[] = [],
): boolean {
  if (!(UNFINISHED_PANE_IDS as readonly string[]).includes(pane)) return pane !== 'dev' || developer
  return developer && !hidden.includes(pane)
}

/**
 * A pane a capability contributes: `<capability>:<name>`. The colon is what
 * tells the two apart at runtime — no kernel pane has one — and it is what
 * makes the id say who owns the pane.
 */
export type ContributedPaneId = `${string}:${string}`

/** Any pane the side pane can show: the kernel's own, or a contributed one. */
export type PaneId = KernelPaneId | ContributedPaneId

/** Whether an id names a contributed pane (see `ContributedPaneId`). */
export function isContributedPaneId(id: PaneId): id is ContributedPaneId {
  return id.includes(':')
}

/** Whether an id — from anywhere, typed or not — names one of the kernel's own panes. */
export function isKernelPaneId(id: unknown): id is KernelPaneId {
  return typeof id === 'string' && (KERNEL_PANE_IDS as readonly string[]).includes(id)
}

export const SIDES = ['left', 'right'] as const
export type Side = (typeof SIDES)[number]

/**
 * §06: the reading ruler is scrolled-flow only. In paginated mode there are no
 * lines to advance, so Space is next page and the ruler control is hidden —
 * hidden, not disabled.
 */
export const PAGE_LAYOUTS = ['scrolled', 'paginated'] as const
export type PageLayout = (typeof PAGE_LAYOUTS)[number]

/** Which step each spacing is on — see `SPACING` in `metrics.ts`. */
export interface SpacingIndices {
  readonly letter: number
  readonly word: number
  readonly line: number
  readonly paragraph: number
}

/** The four, named, so a caller cannot pass a key the scale does not have. */
export type SpacingKey = keyof SpacingIndices

/**
 * How a line of prose fills its measure.
 *
 * NOT "left" AND "right", which is the obvious pair and the wrong one: a line
 * set flush to the reading edge is on the LEFT in English, on the RIGHT in
 * Arabic, and at the TOP in vertical Japanese. There is one behaviour and three
 * appearances, and naming it by one of them would be wrong in the other two.
 * `ragged` names what the far edge does, which is the same in all three.
 *
 * THREE STATES, NOT AN ALIGNMENT AND A HYPHENATION SWITCH. The two axes have
 * four combinations and only three of them are worth offering, so this enum
 * lists the three rather than letting a reader assemble the fourth by accident:
 *
 *   justified            both edges flush, long words broken to fit
 *   justified-no-hyphens both edges flush, the word spaces stretched instead
 *   ragged               reading edge flush, the far edge left uneven
 *
 * Ragged carries no hyphenation, deliberately. It is the one combination of the
 * four that is a matter of taste rather than of mechanics — hyphens do measure
 * shorter in a rag, 15px mean against 29px on a real page at the 660px measure,
 * but a rag is what a reader picking this asked for and breaking words to even
 * it out is answering a question they did not put.
 *
 * The order is the cycle the Settings row walks, most-worked to least.
 */
export const ALIGNS = ['justified', 'justified-no-hyphens', 'ragged'] as const
export type Align = (typeof ALIGNS)[number]

/**
 * Whose typography wins where Paper's and the publisher's disagree.
 *
 * THE ANSWER TO AN OBJECTION, NOT A PREFERENCE INVENTED FOR ITS OWN SAKE.
 * Paper injects one house stylesheet into the slot foliate appends AFTER the
 * book's own, so every unmarked rule in it beats the book's equal-specificity
 * declaration on source order alone. Measured over 1,957 books, that reaches
 * 649 of them on `a { text-decoration }` and 181 on `h1-h6 { font-weight }` —
 * see WI-14.0. Nobody chose that; it is a consequence of having one slot, and
 * the reader has never been able to decline it.
 *
 * Both reference systems that solve this solve it the same way and Paper copies
 * them: the READER WINS BY DEFAULT, and stepping back from that is a named,
 * documented control rather than a heuristic. Apple Books uses white text on a
 * dark theme unless the publisher writes
 * `class="ibooks-dark-theme-use-custom-text-color"`; Kindle enforces its own
 * typesetting unless Enhanced Typesetting is turned off for the title.
 *
 *   paper      Paper's house typography wins — links, headings, blockquotes.
 *   publisher  The book's own wins wherever it states one; Paper's remains as
 *              a default for the books that state nothing.
 *
 * WHAT IT IS NOT. It does not touch the reader's own controls — size, measure,
 * leading, alignment, theme. Those are the reader's under both, because a
 * control that can be overruled is not a control. It governs only the house
 * DEFAULTS, which is the part that was never anybody's decision.
 *
 * `paper` is first because it is the default and the behaviour Paper shipped
 * before the dial existed.
 */
export const FIDELITIES = ['paper', 'publisher'] as const
export type Fidelity = (typeof FIDELITIES)[number]

/**
 * HOW A PARAGRAPH IS TOLD FROM THE ONE BEFORE IT.
 *
 * Print has two answers and they are alternatives: a blank line, or a first-line
 * indent. `both` is offered because plenty of real books set an indent AND a
 * small space and a reader may want to match one, but it is the state to be
 * careful about rather than the state to forbid — a reader who chooses it has
 * asked for it.
 *
 * THERE IS NO "NEITHER", and that is the one combination genuinely worth
 * refusing: no space and no indent runs the prose together with nothing to
 * separate it. `SPACING.paragraph` records that it once offered a zero step and
 * withdrew it for exactly that reason — "nothing here indents a paragraph, so
 * no space between them runs the prose together". Something does now, which is
 * why `indent` can take the space away and `neither` still cannot.
 */
export const SEPARATIONS = ['space', 'indent', 'both'] as const
export type Separation = (typeof SEPARATIONS)[number]

/**
 * How the first paragraph of a section opens.
 *
 * Both are `::first-letter` and `::first-line` — pseudo-elements, which draw
 * nothing into the document. That is not a convenience: every mark in this app
 * is CFI-anchored with 32 characters of context either side, and inserting so
 * much as a `<span>` would invalidate them all.
 */
export const FLOURISHES = ['none', 'drop-cap', 'small-caps'] as const
export type Flourish = (typeof FLOURISHES)[number]

/**
 * Whether headings take the book's own sizes or one scale across the library.
 *
 * `publisher` is the default and it is what Paper has always done: it sets a
 * heading's weight, leading and space and has never touched its SIZE, so
 * `h1 { font-size: 2.25em }` resolves against the reader's base and the
 * author's proportions survive whole. `paper` imposes one scale, which is what
 * makes a shelf of converted books read alike.
 */
export const HEADING_SCALES = ['publisher', 'paper'] as const
export type HeadingScale = (typeof HEADING_SCALES)[number]

/** How a quotation is set apart: indented, ruled, or ruled and tinted. */
export const QUOTE_STYLES = ['indent', 'rule', 'tint'] as const
export type QuoteStyle = (typeof QUOTE_STYLES)[number]

/** Whether code is set in the book's face or in Paper's bundled mono. */
export const CODE_FACES = ['publisher', 'paper'] as const
export type CodeFace = (typeof CODE_FACES)[number]

/**
 * What a line of code too long for the measure does.
 *
 * `scroll` is the default because it is the only one of the two that alters
 * nothing about the code: the lines stay where the author broke them, and the
 * block gets a scroll port instead of spilling out of the column, which is what
 * an unstyled `pre` does today.
 */
export const CODE_WRAPS = ['scroll', 'wrap'] as const
export type CodeWrap = (typeof CODE_WRAPS)[number]

/** What a figure is set in, if anything. */
export const FIGURE_FRAMES = ['none', 'hairline', 'shadow'] as const
export type FigureFrame = (typeof FIGURE_FRAMES)[number]

/** What a table wider than the measure does — the same choice as `CODE_WRAPS`. */
export const TABLE_FITS = ['scroll', 'shrink'] as const
export type TableFit = (typeof TABLE_FITS)[number]

/**
 * How big the text of a note is in the popover.
 *
 * Books set notes smaller than the prose — measured, `.footnote` is 70% and
 * `.footnote2` is 75% on one real book — and on the PAGE that is right: a note
 * at the foot of a page is subordinate to the text it annotates, and the
 * reduction is how print says so.
 *
 * `paper` IS 80% OF THE READER'S BASE, not 100%. It was 100% on the argument
 * that a popover has no prose beside it, so the reason for the reduction is
 * absent there and all it costs is legibility. That argument is overruled
 * deliberately: a footnote reads as a footnote, and the house ratio for one is
 * four fifths — the same ratio the superscript marker takes. What the setting
 * still buys is the choice, because 70% of a base the reader has since enlarged
 * is a different thing from 80% of it.
 *
 * NAMED FOR WHOSE IT IS, not for what it matches. The state was labelled "Match
 * the prose" while it meant 100%, and at 80% that label would simply be false —
 * a control that misdescribes its own state is worse than one with a dull name.
 */
export const NOTE_SIZES = ['prose', 'publisher'] as const
export type NoteSize = (typeof NOTE_SIZES)[number]

/**
 * Everything about how a book is SET that is not a size, a colour or a spacing.
 *
 * ONE FIELD RATHER THAN FIFTEEN, exactly as `SpacingIndices` is one field
 * rather than four, and for the same two reasons: a reader adjusts them
 * together, and the reducer can take one action for all of them instead of
 * fifteen near-identical branches.
 *
 * EVERY DEFAULT IS WHAT PAPER RENDERED BEFORE THE SETTING EXISTED. That is the
 * property to hold on to — a reader who never opens these gets the book they
 * had. Two of them are not quite that and say so where they are declared:
 * `codeWrap` and `wideTables` both default to containing an overflow that today
 * simply spills out of the column, and both sit in the `before` tier, so a book
 * that styles `pre` or `table` still wins.
 */
export interface ReadingStyle {
  readonly separation: Separation
  readonly flourish: Flourish
  readonly headingScale: HeadingScale
  readonly blockquote: QuoteStyle
  readonly codeFace: CodeFace
  readonly codeWrap: CodeWrap
  /** Index into `FIGURE_WIDTHS`. */
  readonly figureWidth: number
  readonly figureFrame: FigureFrame
  /** Whether a figure's cap is read in `em`, so it grows with the type. */
  readonly figureScalesWithText: boolean
  /** Index into `FIGURE_HEIGHTS`. */
  readonly figureHeight: number
  readonly wideTables: TableFit
  readonly noteSize: NoteSize
  /** `text-autospace` between CJK and Latin runs. */
  readonly cjkSpacing: boolean
  /** Index into `MINIMUM_SIZES`; step 0 is off. */
  readonly minimumSize: number
  readonly fidelity: Fidelity
}

/** The keys, so a caller cannot name one the type does not have. */
export type ReadingStyleKey = keyof ReadingStyle
