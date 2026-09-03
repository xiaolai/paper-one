import { useEffect, useRef, useState } from 'react'
import { overlayKey, type ForeignAnnotation } from '../../core/circle/foreign'
import type { OverlayContribution, ResolvePort } from '../../core/circle/overlay'
import type { ForeignAnchor } from '../reader/session'

/**
 * Ask every overlay contribution what to draw in this book — WI-22.D1.
 *
 * The host's half of the seam. The capability supplies data; this collects it
 * and hands it to the reader, which draws.
 *
 * ## Why it re-asks rather than being pushed to
 *
 * ⚠️ `subscribe` is a SIGNAL, not a payload. A page landing, a withdrawal, or a
 * re-anchoring pass placing something all mean the same thing — *ask again* —
 * and taking a payload instead would give "what should be drawn" two sources
 * that can disagree. `review.md`'s overlay blocker 4 is the reason there is a
 * signal at all: *"the reader redraws only when its `marks` input changes, so a
 * share arriving mid-session can neither appear nor disappear."*
 *
 * ## The resolver is handed over, not found
 *
 * `resolve` walks the OPEN book through `section.createDocument()` — the object
 * `refuseBookScripts` wrapped at open. A capability that parsed the file itself
 * would get an unstripped document and a path that can disagree by a child
 * index. Handing the port over is what keeps that impossible rather than
 * merely discouraged.
 */

export interface OverlayDeps {
  readonly contributions: readonly OverlayContribution[]
  readonly bookId: string | null
  /** Which OPEN this is — see `useReanchor`, which keys on the same thing. */
  readonly openGeneration: number
  /** Whether the book is parsed and its navigator published. */
  readonly parsed: boolean
  readonly resolve: ResolvePort
}

const NONE: readonly ForeignAnchor[] = []
const NO_ANNOTATIONS: readonly ForeignAnnotation[] = []

/** Which book and which open a set of anchors belongs to. */
interface Held {
  readonly stamp: string
  readonly anchors: readonly ForeignAnchor[]
}

const NOTHING_HELD: Held = { stamp: '', anchors: NONE }

export function useOverlays(deps: OverlayDeps): readonly ForeignAnchor[] {
  const { contributions, bookId, openGeneration, parsed, resolve } = deps
  /**
   * ⚠️ **THE ANCHORS ARE STORED WITH THE OPEN THEY BELONG TO, and they were
   * stored bare.** An effect is asynchronous: switching from one book straight
   * to another left the PREVIOUS book's anchors on screen until the new query
   * settled, and those are foreign marks drawn against a book they have
   * nothing to do with — the defect this hook already guarded for a book
   * CLOSING and not for a book being replaced.
   *
   * Comparing the stamp during render rather than clearing in an effect is
   * what makes the gap zero frames wide: an effect runs after paint, so a
   * cleared-in-effect version still shows one frame of the wrong book's marks.
   * The same reasoning `useMarking` gives for resetting its ranges during
   * render rather than in an effect.
   */
  const [held, setHeld] = useState<Held>(NOTHING_HELD)
  const stamp = parsed && bookId ? `${openGeneration}:${bookId}` : ''

  /* Requests carry the stamp they were made under, so a slow answer for the
     previous book cannot land on this one. */
  const request = useRef(0)
  /**
   * What each contributor last successfully answered, by contribution id.
   *
   * Keyed by id rather than by position so it survives a composition whose
   * contributions change; cleared with the book, because an answer is about
   * ONE book and carrying it into the next would draw a stranger's marks in a
   * book they never read.
   */
  const lastGood = useRef(new Map<string, readonly ForeignAnnotation[]>())

  useEffect(() => {
    if (!parsed || !bookId || contributions.length === 0) {
      /* ⚠️ **CLEARED, NOT LEFT STANDING.** Between books — and between
       * compositions — the previous book's anchors would otherwise be drawn
       * over a book that has nothing to do with them. `app/web/Reader.tsx`
       * records the same defect for its own marks: *"A STORE THAT WENT AWAY
       * TAKES ITS HIGHLIGHTS WITH IT."* */
      setHeld(NOTHING_HELD)
      lastGood.current.clear()
      return
    }

    let live = true
    /* A new book means every remembered answer is about the previous one. */
    lastGood.current.clear()

    const ask = () => {
      /* ⚠️ **DEAD FIRST, REVISION SECOND — and it was the other way round.**
       * A listener belonging to a book that has been left can still fire: a
       * contribution may have queued the callback before its unsubscribe ran.
       * Incrementing before the check let that dead call bump the shared
       * revision, and the CURRENT book's in-flight answer then failed its own
       * `mine` test and was thrown away — leaving the new book showing nothing
       * until some later signal happened to ask again. The stale call must
       * cost nothing at all, not merely commit nothing. */
      if (!live) return
      /* ⚠️ **A REVISION PER REQUEST, because two can be in flight at once.**
       * `subscribe` can fire while an earlier `ask` is still awaiting, and the
       * answers can settle in either order — so a SLOWER, OLDER response could
       * overwrite a newer one, resurrecting a withdrawn passage or removing one
       * that had just arrived. Only the latest request may commit. */
      const mine = ++request.current

      /* ⚠️ **COMMITTED AS EACH CONTRIBUTOR ANSWERS, not once they all have.**
       * `Promise.all` started them together but could publish nothing until
       * the LAST one settled, so a contributor that never settles still cost
       * the reader every other contributor's marks — the exact failure this
       * was changed to prevent, moved one step later. Starting in parallel is
       * only half of it; the other half is that a slow answer must delay ITS
       * OWN marks and no one else's.
       *
       * A slot per contributor, filled in place, so the order the reader sees
       * is the composition's order however the answers arrive. */
      /* ⚠️ **SEEDED FROM WHAT EACH CONTRIBUTOR LAST SAID, and it used to start
       * every slot empty.** With the commit now happening per contributor, an
       * empty slot is published as "this one has nothing" the moment any OTHER
       * contributor answers — so one contributor signalling erased every
       * slower contributor's marks while they were still being fetched, and if
       * one never settled its marks never came back. Empty means "has nothing
       * to say"; it must not also mean "has not spoken yet". */
      const answers: (readonly ForeignAnnotation[])[] = contributions.map(
        (contribution) => lastGood.current.get(contribution.id) ?? NO_ANNOTATIONS,
      )
      const commit = () => {
        if (!live || request.current !== mine) return
        const collected = answers.flat().map(anchorFor)
        const next: Held = { stamp, anchors: collected.length === 0 ? NONE : collected }
        /* ⚠️ **AN UNCHANGED ANSWER MUST NOT BE A NEW STATE.** Every `ask` used
         * to allocate, so re-rendering was unconditional — and a host that
         * composes its `contributions` array during render then hands the
         * effect a new identity, which tears down every subscription and
         * installs it again. One re-ask became a resubscribe loop, and the
         * reader redrew every section for an answer identical to the one it
         * was already showing. It matters more now that every contributor
         * commits: without it, n contributors would be n renders. */
        setHeld((prev) => (showsTheSame(prev, next) ? prev : next))
      }

      contributions.forEach((contribution, at) => {
        void (async () => {
          try {
            const drawn = await contribution.forBook({ bookId, resolve })
            answers[at] = drawn
            /* A successful `[]` IS a withdrawal, so it replaces the seed. Only
               a rejection leaves the previous answer standing — see below. */
            lastGood.current.set(contribution.id, drawn)
          } catch (cause) {
            /* ⚠️ ONE CONTRIBUTOR FAILING MUST NOT COST THE READER THE OTHERS'
             * MARKS. `OverlayContribution.forBook` says it never throws for a
             * book it cannot serve; this is what makes that a promise the host
             * keeps rather than one it depends on. */
            console.warn(
              `Paper: overlay "${contribution.id}" could not answer for this book`,
              cause,
            )
            /* ⚠️ AND ITS SEED IS LEFT ALONE. A contributor that FAILED has said
               nothing about what it holds; treating that as a withdrawal would
               take a reader's friends off the page because a read errored
               once. Nothing is the answer only when it is answered. */
          }
          commit()
        })()
      })

      /* Nothing to wait for, so the empty answer is published now rather than
         never — `contributions.length === 0` is handled above, but a host that
         hands over an array which empties between renders would otherwise hold
         the previous book's marks. */
      if (contributions.length === 0) commit()
    }

    ask()
    /* Every contribution's own signal. Unsubscribing is the contribution's to
       give back, so a capability disposed underneath us takes its listener.
       ⚠️ Guarded on BOTH sides: a `subscribe` that throws would otherwise leak
       the listeners already installed, and one throwing unsubscribe would
       abandon every later one. */
    const offs: (() => void)[] = []
    try {
      for (const one of contributions) offs.push(one.subscribe(ask))
    } catch (cause) {
      for (const off of offs) safely(off)
      throw cause
    }
    return () => {
      live = false
      for (const off of offs) safely(off)
    }
  }, [contributions, bookId, openGeneration, parsed, resolve, stamp])

  /* DURING RENDER, not in an effect — see `held`. */
  return held.stamp === stamp ? held.anchors : NONE
}

/**
 * Whether committing `next` would change what the reader is shown.
 *
 * ⚠️ **THE COMPARISON IS AGAINST WHAT IS ON SCREEN, not against the record.**
 * `held` under a stale stamp already renders as nothing, so the first answer
 * for a book nobody has shared from — by far the ordinary case — moves the
 * stamp and shows exactly what it showed before. Comparing the records would
 * commit it, and a commit costs a render, an effect re-run and a full
 * resubscribe.
 *
 * Order is the contributors' order, which is the composition's — stable by
 * construction, so a positional comparison is the whole question.
 */
function showsTheSame(prev: Held, next: Held): boolean {
  const shown = prev.stamp === next.stamp ? prev.anchors : NONE
  if (shown.length !== next.anchors.length) return false
  return shown.every((one, at) => {
    const other = next.anchors[at]
    return (
      other !== undefined &&
      one.key === other.key &&
      one.cfi === other.cfi &&
      one.sectionIndex === other.sectionIndex &&
      one.readers === other.readers
    )
  })
}

/** Run a teardown, letting the rest run whatever it does. */
function safely(off: () => void): void {
  try {
    off()
  } catch (cause) {
    console.warn('Paper: an overlay listener could not be removed', cause)
  }
}

/**
 * A contributed annotation as the painter's door takes it.
 *
 * ⚠️ **THE KEY IS COMPOSED HERE and not by the contributor**, so `n` readers on
 * one passage are `n` overlay entries whatever a capability chose to call
 * things. `review.md`'s overlay blocker 1 is the collapse this prevents, and
 * leaving the key to the contributor would make the fix depend on every one of
 * them getting it right.
 */
function anchorFor(annotation: ForeignAnnotation): ForeignAnchor {
  return {
    cfi: annotation.cfi,
    sectionIndex: annotation.sectionIndex,
    key: overlayKey(annotation),
    readers: annotation.readers,
  }
}
