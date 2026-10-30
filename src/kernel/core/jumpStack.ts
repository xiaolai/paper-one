/**
 * Where the reader was before they jumped, so they can get back.
 *
 * Paper gives a reader more ways to LEAVE a place than most readers do — a
 * nested table of contents, a search panel streaming hits each navigable by
 * CFI, the ⌘K switcher, Marginalia's rows across every book, and the book's
 * own internal links — and until this module there was no way back from any of
 * them. `makePdf.ts` names the cost in passing: an unresolvable destination
 * once sent the reader to the cover "with no way back but the history".
 *
 * PURE, AND DELIBERATELY NOT foliate's. `View` already keeps a `History` —
 * `pushState` on every `goTo`, `replaceState` on every page — and binding ⌘[ to
 * `view.history.back()` would have been an afternoon. It cannot be used here
 * for four reasons, in the order they would have cost to discover:
 *
 *  - It is CLEARED ON `open` and holds no book id, so a jump from one book to
 *    another — which is most of what Marginalia offers — cannot be represented.
 *  - Its idea of "where you were" is whatever `replaceState` last wrote, which
 *    is a function of the RENDERER's relocate reasons. A back button whose
 *    behaviour depends on whether the paginator called a movement `snap` or
 *    `anchor` is not something a test can pin.
 *  - The origin is never pushed explicitly, so WHAT COUNTS AS A JUMP is not a
 *    question that API lets Paper answer — and that question is the whole of
 *    this module's job.
 *  - Upstream's API is explicitly unstable, and `history` is a member
 *    `vite-env.d.ts` does not declare. It stays undeclared: an undeclared
 *    member is one nobody binds a key to by accident.
 */

/** A place in a book, which is the pair — a CFI alone names nothing. */
export interface Place {
  readonly bookId: string
  readonly cfi: string
}

/**
 * TWO LISTS, NOT AN INDEX.
 *
 * An index into one array is the shape foliate's `History` chose, and it makes
 * "what does forward mean after a new jump" an off-by-one question — the array
 * has to be truncated, and the truncation is where an index-based history goes
 * wrong. Two lists make the same rule `forward: []`, which is a thing a reader
 * of `pushOrigin` can see rather than reason about.
 *
 * The LAST element of each is the nearest one. `back` ends with the place the
 * reader most recently left; `forward` ends with the place ⌘] returns to first.
 */
export interface JumpStack {
  readonly back: readonly Place[]
  readonly forward: readonly Place[]
}

export const EMPTY: JumpStack = { back: [], forward: [] }

/**
 * How far back ⌘[ can walk.
 *
 * DROPS FROM THE FAR END rather than refusing at the near one. A stack that
 * stops recording once it is full is a back button that silently stops working
 * — the reader keeps jumping, the key keeps doing nothing, and nothing says
 * why. Losing the fiftieth-oldest origin loses a place nobody is walking back
 * to; refusing the newest loses the one they just left.
 *
 * Exported so the test names the same number this module does. A test with its
 * own copy of a bound is a test that passes after the bound changes.
 */
export const MAX_DEPTH = 50

const same = (a: Place, b: Place): boolean => a.bookId === b.bookId && a.cfi === b.cfi

/** Keep the newest `MAX_DEPTH`, dropping from the front. */
const bounded = (places: readonly Place[]): readonly Place[] =>
  places.length > MAX_DEPTH ? places.slice(places.length - MAX_DEPTH) : places

/**
 * Record where the reader is LEAVING, before a non-linear navigation.
 *
 * Takes the origin, not the destination: the destination is where they are
 * about to be, and a stack of destinations answers a question nobody asked.
 *
 * A NEW JUMP CLEARS `forward`, because it branches. Having gone back three
 * places and then jumped somewhere new, the three places ahead are a future
 * that no longer happened, and offering ⌘] into them would return the reader
 * to a thread they abandoned.
 *
 * CONSECUTIVE IDENTICAL ORIGINS COLLAPSE. Clicking two table-of-contents
 * entries in a row from the same page is one departure from that page, and
 * recording it twice would make ⌘[ take two presses to do one thing.
 */
export function pushOrigin(stack: JumpStack, origin: Place): JumpStack {
  const top = stack.back[stack.back.length - 1]
  if (top && same(top, origin)) {
    return stack.forward.length === 0 ? stack : { back: stack.back, forward: [] }
  }
  return { back: bounded([...stack.back, origin]), forward: [] }
}

/**
 * Branch WITHOUT an origin — a jump whose departure could not be pinned down.
 *
 * `pushOrigin` does two things: it records where the reader was, and it clears
 * `forward` because the jump abandons whatever was ahead. Those are separable,
 * and skipping the call entirely when `placeHere()` returns null skipped BOTH.
 *
 * The consequence was reachable: go back once (so `forward` holds a place),
 * then jump again while a section is still rendering — the origin is null, the
 * stack is untouched, and ⌘] still walks into the branch that jump abandoned.
 * The reader is returned to a thread they left, which is exactly what
 * `pushOrigin`'s own comment says must not happen.
 *
 * So the branch always happens; only the recording is conditional.
 */
export function branchWithoutOrigin(stack: JumpStack): JumpStack {
  return stack.forward.length === 0 ? stack : { back: stack.back, forward: [] }
}

/**
 * ⌘[ — the place the reader left, and the stack that remembers they came back.
 *
 * `null` WHEN THERE IS NOTHING BEHIND, not a throw. ⌘[ with an empty stack is
 * an unbound key, which is what `resolveAccel` returns `null` to mean and what
 * `accel.ts` argues at length is better than a combo swallowed to do nothing.
 *
 * TAKES WHERE THE READER IS. The stack holds origins, so going back has to put
 * the place being left onto `forward` or ⌘] has nothing to return to. Passing
 * it in keeps this module pure, and it means the CALLER's answer to "where am
 * I" is the one used — which matters, because the host's copy of the CFI is a
 * React commit behind the session's. That mismatch already produced a bookmark
 * describing two different pages; see `ReaderSession.placeHere`.
 *
 * `here` MAY BE NULL, and going back still works. `placeHere()` returns null
 * for a place that cannot be pinned down — a section still rendering, a book
 * mid-open — and the reader pressing ⌘[ in that moment wants to leave, which is
 * a thing this can do. What it cannot do is offer them a way back to a place it
 * was never told, so `forward` is left alone rather than fed a guess. Refusing
 * the whole press instead would be a key that works except when it doesn't,
 * with nothing on screen to say which.
 */
export function goBack(stack: JumpStack, here: Place | null): { stack: JumpStack; to: Place } | null {
  const to = stack.back[stack.back.length - 1]
  if (!to) return null
  return {
    to,
    stack: {
      back: stack.back.slice(0, -1),
      forward: here ? bounded([...stack.forward, here]) : stack.forward,
    },
  }
}

/** ⌘] — undo a ⌘[. Same shape, same `null`s, same reasons. */
export function goForward(stack: JumpStack, here: Place | null): { stack: JumpStack; to: Place } | null {
  const to = stack.forward[stack.forward.length - 1]
  if (!to) return null
  return {
    to,
    stack: {
      back: here ? bounded([...stack.back, here]) : stack.back,
      forward: stack.forward.slice(0, -1),
    },
  }
}

/** Whether ⌘[ has somewhere to go — the palette and the key read this one. */
export const canGoBack = (stack: JumpStack): boolean => stack.back.length > 0

/** Whether ⌘] has somewhere to go. */
export const canGoForward = (stack: JumpStack): boolean => stack.forward.length > 0

/**
 * Where a book should OPEN — the three-way choice the host makes once per open.
 *
 * Extracted from `App` because it is a decision, not plumbing, and because the
 * thing most worth pinning about it cannot be seen from the outside: that the
 * override is spent. A jump into another book sets `openAt`; if that survived
 * the open, the reader would be sent to the same footnote every time they
 * reopened that book, silently and forever.
 *
 * The order is the priority. A jump beats a resume, a resume beats the shelf's
 * record, and every one of them is checked against the book actually being
 * opened — an override or a resume belonging to a different book is not a
 * weaker answer, it is the wrong one.
 */
export function locationToOpen(
  bookId: string | null,
  openAt: Place | null,
  resumeAt: { readonly bookId: string; readonly position: string | null } | null,
  saved: string | null,
): string | null {
  if (bookId === null) return null
  if (openAt && openAt.bookId === bookId) return openAt.cfi
  if (resumeAt && resumeAt.bookId === bookId) return resumeAt.position
  return saved
}

/**
 * Whether the override has been spent — the reader has LANDED.
 *
 * ON A PUBLISHED POSITION, not on the id. `bookId` is content-derived and
 * resolves within milliseconds of the open, long before any section renders —
 * so clearing on it would drop the override before `locationToOpen` was ever
 * consulted, and the jump would open the right book at the wrong place. A
 * published CFI means a section has rendered, which means the read happened.
 *
 * THIS ONCE ALSO SPENT THE OVERRIDE WHEN A DIFFERENT BOOK WAS OPEN, and that
 * was wrong in the worst available way: it broke every cross-book jump while
 * looking like a fix.
 *
 * The reasoning was that a failed open leaves an override with no owner. True,
 * but "a different book is open" does not identify that case — during a
 * cross-book jump the SOURCE book is still open, legitimately, for the whole
 * time the target is being read off disk. The effect re-ran the moment
 * `setOpenAt` changed, saw the source book's id, spent the override, and the
 * target then opened at its saved position instead of at the mark. Both tests
 * written for that branch asserted the wrong rule, so they passed.
 *
 * The leak it was meant to close is left open ON PURPOSE, because it is
 * benign: after a failed open the override survives until the reader opens
 * that book again — which is the book they were trying to reach, at the place
 * they were trying to reach. Distinguishing "still loading" from "failed"
 * needs an open-attempt generation, and that is worth building only if the
 * distinction ever earns its keep.
 */
export function overrideSpent(
  bookId: string | null,
  openAt: Place | null,
  currentCfi: string | null,
): boolean {
  return openAt !== null && openAt.bookId === bookId && currentCfi !== null
}

