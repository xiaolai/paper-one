// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { CORPUS_BUILDS, CORPUS_PASSAGES, type BuildId } from '../../core/markCorpus.testkit'
import { decide, reanchorPass, type PassDeps, type PendingMark } from './reanchorPass'
import { recordPath } from '../../core/bookFolder'
import { fakeFs } from '../../core/indexFsFake.testkit'
import { createMarkStore } from '../../core/markStore'
import { createMark } from '../../core/marks'
import { writeQueue } from '../../core/writeQueue'

const BOOK = 'book:moby'

/**
 * WI-22.A2 — the walk.
 *
 * The item's acceptance is *"an unplaced mark whose passage exists in this
 * build becomes a normal placed mark … one whose passage does not exist stays
 * unplaced and is not re-walked on the next open"*. The second half is the
 * cache's, and is tested in `useReanchor.test.tsx`; this file is the first
 * half, plus the two properties the plan states as constraints — that the walk
 * yields, and that it stops when the reader closes the book.
 */

const docOf = (build: BuildId, sectionIndex: number): Node =>
  new DOMParser().parseFromString(
    `<html><body>${CORPUS_BUILDS[build].sections[sectionIndex]!.xhtml}</body></html>`,
    'text/html',
  ).body

/** A whole build, as the pass sees a book: N sections, each parsed on demand. */
const bookOf = (build: BuildId, over: Partial<PassDeps> = {}): PassDeps => ({
  sections: CORPUS_BUILDS[build].sections.length,
  documentFor: (index) => Promise.resolve(docOf(build, index)),
  live: () => true,
  breathe: () => Promise.resolve(),
  ...over,
})

/** A passage as another build's archive carries it — quote plus 32 either side. */
const pendingFrom = (from: BuildId, which: number): PendingMark => {
  const passage = CORPUS_PASSAGES[which]!
  return {
    id: `mark-${which}`,
    quote: passage.places[from].quote,
    prefix: passage.places[from].prefix,
    suffix: passage.places[from].suffix,
  }
}

describe('the re-anchoring pass', () => {
  it('places a passage carried from another build, with the section it landed in', async () => {
    /* THE WHOLE ITEM, in one assertion. A mark made against Gutenberg's build
       arrives with no anchor in the Standard Ebooks one; the pass finds the
       words and produces the cfi a reader can navigate to. */
    const pending = pendingFrom('gutenberg', 0)
    const outcome = await reanchorPass([pending], bookOf('standard-ebooks'))

    expect(outcome.found).toHaveLength(1)
    expect(outcome.found[0]!.id).toBe(pending.id)
    expect(outcome.missed).toEqual([])
    expect(outcome.complete).toBe(true)
    /* ⚠️ **THE SPINE STEP HAS TO AGREE WITH `sectionIndex`, and the first
       version of this assertion could not fail** — it rebuilt the expected
       string out of the actual one, so any cfi matched itself. A mark written
       with section 0's index and section 3's path is offered to the wrong
       overlay for ever, which is precisely the defect worth catching here.

       Compared against the index INDEPENDENTLY: the passage is known to be in
       Standard Ebooks section 2, so both halves are named rather than derived. */
    expect(outcome.found[0]!.sectionIndex).toBe(2)
    expect(outcome.found[0]!.cfi.startsWith('epubcfi(/6/6!')).toBe(true)
  })

  it('reports a passage that is not in this build as missed, not as found', async () => {
    const outcome = await reanchorPass(
      [{ id: 'ghost', quote: 'a sentence no build of this book contains', prefix: '', suffix: '' }],
      bookOf('gutenberg'),
    )
    expect(outcome.found).toEqual([])
    expect(outcome.missed).toEqual(['ghost'])
    expect(outcome.complete).toBe(true)
  })

  it('indexes each section ONCE however many marks are waiting', async () => {
    /* ⚠️ **THE COST PROPERTY, and it is the reason `reanchorIn` was split out
       of `reanchor`.** `reanchor` builds the index itself, so a mark-outer loop
       over five marks and forty sections would parse and walk 200 documents for
       40. Counting `documentFor` is the observable half of that: the walk asks
       for each section at most once, whatever the mark count. */
    const asked: number[] = []
    const deps = bookOf('gutenberg', {
      documentFor: (index) => {
        asked.push(index)
        return Promise.resolve(docOf('gutenberg', index))
      },
    })
    const many = [0, 1, 2].map((i) => ({
      id: `ghost-${i}`,
      quote: `absent passage ${i}`,
      prefix: '',
      suffix: '',
    }))

    await reanchorPass(many, deps)

    expect(asked).toEqual([...new Set(asked)])
    expect(asked).toHaveLength(CORPUS_BUILDS.gutenberg.sections.length)
  })

  it('stops the moment the book stops being the open one', async () => {
    /* ⚠️ **THE READING-PATH CONSTRAINT.** Forty cold sections is ~139 ms, and a
       reader who closed the book must not pay for the rest of it. `live()` is
       asked BEFORE each section, so the walk stops within one section rather
       than at the end of the book. */
    let sections = 0
    const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
      sections: 40,
      documentFor: (index) => {
        sections += 1
        return Promise.resolve(docOf('standard-ebooks', Math.min(index, 3)))
      },
      live: () => sections < 2,
      breathe: () => Promise.resolve(),
    })

    expect(sections).toBeLessThan(4)
    expect(outcome.complete).toBe(false)
  })

  it('reports NOTHING as missed when it was cut short, however many it walked', async () => {
    /* ⚠️ **THE ONE THAT MATTERS MOST, and it is not obvious.** A miss is only a
       fact once every section has been looked at. A pass the reader interrupted
       has established nothing about the marks it did not reach — and the caller
       writes `missed` into the cache as a REMEMBERED FAILURE, which
       `reanchorCache` defines as *"this was tried against these exact bytes and
       the passage is not in them"*. Remembering one from an interrupted walk is
       a permanent wrong answer bought for one closed book: the mark would never
       be looked for again in this session, and it is there.

       Asserted as a whole array rather than a length, so a walk that leaked one
       id through cannot pass. */
    const outcome = await reanchorPass(
      [
        { id: 'a', quote: 'absent one', prefix: '', suffix: '' },
        { id: 'b', quote: 'absent two', prefix: '', suffix: '' },
      ],
      bookOf('gutenberg', { live: () => false }),
    )
    expect(outcome.missed).toEqual([])
    expect(outcome.complete).toBe(false)
    expect(outcome.walked).toBe(0)
  })

  it('hands the main thread back between sections', async () => {
    /* The other half of "not on the reading path". ~139 ms held in one piece
       drops frames on the open it runs after; the same time in forty pieces
       does not. Counted rather than timed — a timing assertion here would be
       measuring the machine. */
    const breathe = vi.fn(() => Promise.resolve())
    await reanchorPass([{ id: 'ghost', quote: 'absent', prefix: '', suffix: '' }], {
      sections: 5,
      documentFor: (index) => Promise.resolve(docOf('gutenberg', Math.min(index, 2))),
      live: () => true,
      breathe,
    })
    /* Between, not before each — five sections are four gaps. */
    expect(breathe).toHaveBeenCalledTimes(4)
  })

  it('walks EVERY section even after a hit, because a later one may be better', async () => {
    /* ⚠️ **THIS REPLACED AN "IT STOPS EARLY" TEST, and the optimisation it
       asserted was unsound.** Breaking at the first hit is only correct if the
       first hit is the right one, which is exactly what a whole-book sweep
       cannot assume — see the ambiguity block below. The plan's cost budget
       already assumes a full walk: forty cold sections at ~139 ms, once. */
    let asked = 0
    const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
      sections: 6,
      documentFor: (index) => {
        asked += 1
        return Promise.resolve(docOf('standard-ebooks', Math.min(index, 3)))
      },
      live: () => true,
      breathe: () => Promise.resolve(),
    })
    expect(outcome.found).toHaveLength(1)
    expect(asked).toBe(6)
  })

  it('places nothing at all when the walk was cut short', async () => {
    /* ⚠️ **THE COROLLARY OF THE AMBIGUITY RULE, and it is not obvious.** A
       candidate from section 3 is only the answer once section 20 has been
       ruled out. A walk that stopped at section 4 has ruled out nothing, so
       placing what it happened to have would put a mark on the wrong words on
       exactly the opens a reader cut short — the hardest kind to notice. */
    let seen = 0
    const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
      sections: 40,
      documentFor: (index) => {
        seen += 1
        return Promise.resolve(docOf('standard-ebooks', Math.min(index, 3)))
      },
      live: () => seen < 4,
      breathe: () => Promise.resolve(),
    })
    expect(outcome.found).toEqual([])
    expect(outcome.missed).toEqual([])
    expect(outcome.complete).toBe(false)
  })

  it('refuses to conclude anything when a section will not load', async () => {
    /* ⚠️ **THIS TEST ASSERTED THE OPPOSITE, and the opposite was wrong.** It
       said the pass should treat an unreadable section as an empty one and
       carry on — `enrichOne`'s *"never throws, a failure is a result"* posture.
       That posture is right for a pass that ENRICHES and wrong here, and the
       two differ in what a gap COSTS.

       A book that fails to parse keeps the metadata it had. A section that
       fails to parse silently changes the meaning of every miss in the book:
       the caller writes `missed` into the cache as *"tried against these exact
       bytes and the passage is not in them"*, and the passage may be sitting in
       the one section nobody could read. The mark is then never looked for
       again while it is there.

       So a load failure makes the whole walk inconclusive — no placements, no
       misses, `complete: false` — and the next open tries again. Still REPORTED,
       because a section that will not parse is a fact about the book. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
        sections: 4,
        documentFor: (index) =>
          index === 2
            ? Promise.reject(new Error('malformed section'))
            : Promise.resolve(docOf('standard-ebooks', index)),
        live: () => true,
        breathe: () => Promise.resolve(),
      })
      /* Section 2 IS where this passage lives, so a pass that carried on would
         have reported it missed — the exact permanent wrong answer. */
      expect(outcome.complete).toBe(false)
      expect(outcome.found).toEqual([])
      expect(outcome.missed).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('treats a section with no document as empty, which is not a failure', () => {
    /* The distinction the fix above must not blur. A spine item a backend does
       not build — an unstyled cover, a nav document — has nothing to find and
       says so by answering null. That is a section with no text, not a section
       that could not be read, and the walk stays conclusive. */
    return expect(
      reanchorPass([pendingFrom('gutenberg', 0)], {
        sections: 4,
        documentFor: (index) =>
          index === 0 ? Promise.resolve(null) : Promise.resolve(docOf('standard-ebooks', index)),
        live: () => true,
        breathe: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ complete: true })
  })

  it('stops if the book closes while the last section is loading', async () => {
    /* ⚠️ The loop checks `live()` BEFORE each section, and `documentFor` is the
       slow step. A book closed during the final section's load was still
       indexed and still answered `complete: true` — there is no next iteration
       to catch it. */
    let closed = false
    const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
      sections: 1,
      documentFor: async (index) => {
        closed = true
        return docOf('standard-ebooks', index)
      },
      live: () => !closed,
      breathe: () => Promise.resolve(),
    })
    expect(outcome.complete).toBe(false)
    expect(outcome.found).toEqual([])
  })

  it('will not call a section-less book a complete answer', async () => {
    /* A backend with no spine — a PDF, a CBZ — or one whose sections are not
       built yet is a book this pass cannot speak about. Answering
       `complete: true` with an empty `missed` claimed every section had been
       looked at while naming none of the marks still waiting. */
    const outcome = await reanchorPass([pendingFrom('gutenberg', 0)], {
      sections: 0,
      documentFor: () => Promise.resolve(null),
      live: () => true,
      breathe: () => Promise.resolve(),
    })
    expect(outcome.complete).toBe(false)
    expect(outcome.missed).toEqual([])
  })

  it('counts only the sections it actually indexed', async () => {
    /* `walked` is the one field that tells "walked and found nothing" apart
       from "never walked", and it was incremented for sections that were never
       read. */
    const outcome = await reanchorPass([{ id: 'ghost', quote: 'absent', prefix: '', suffix: '' }], {
      sections: 5,
      documentFor: (index) =>
        index % 2 === 0 ? Promise.resolve(docOf('gutenberg', 1)) : Promise.resolve(null),
      live: () => true,
      breathe: () => Promise.resolve(),
    })
    expect(outcome.walked).toBe(3)
    expect(outcome.complete).toBe(true)
  })

  it('walks nothing at all when there is nothing waiting', async () => {
    const documentFor = vi.fn()
    const outcome = await reanchorPass([], bookOf('gutenberg', { documentFor }))
    expect(documentFor).not.toHaveBeenCalled()
    expect(outcome.complete).toBe(true)
    expect(outcome.walked).toBe(0)
  })
})

describe('the whole-book ambiguity rule', () => {
  /* ⚠️ **`docs/design/circle/review.md` §"The overlay seam" blocker 2, run as a
     test.** *"The resolver has no whole-book ambiguity rule. A foreign passage
     has no section index, so integration must sweep — but `reanchor` treats one
     exact occurrence WITHIN A SECTION as certain. Check: wrong context around
     'the whale' in section 1, matching context in section 20; a first-hit sweep
     picks section 1 and reports confidence."*

     The first version of `reanchorPass` was that first-hit sweep. This is the
     check the review names, spelled as a synthetic book so both occurrences are
     exactly where the argument needs them. */

  const page = (text: string): Node =>
    new DOMParser().parseFromString(`<html><body><p>${text}</p></body></html>`, 'text/html').body

  /** Section 1 has the quote in the wrong company; section 3 has it in the right. */
  const bookWithTwo = (sections: readonly string[]): PassDeps => ({
    sections: sections.length,
    documentFor: (index) => Promise.resolve(page(sections[index]!)),
    live: () => true,
    breathe: () => Promise.resolve(),
  })

  const WRONG = 'Nothing at all like it, the whale, and nothing after it either.'
  const RIGHT = 'so much depends upon the whale which swam beside the boat'
  const passage: PendingMark = {
    id: 'm1',
    quote: 'the whale',
    prefix: 'so much depends upon ',
    suffix: ' which swam beside the boat',
  }

  it('picks the section whose context agrees, not the first one it meets', async () => {
    const outcome = await reanchorPass([passage], bookWithTwo(['nothing here', WRONG, 'nor here', RIGHT]))

    expect(outcome.found).toHaveLength(1)
    /* SECTION 3, not section 1. A first-hit sweep answers 1 and reports
       confidence, which is a mark drawn on the wrong words. */
    expect(outcome.found[0]!.sectionIndex).toBe(3)
    expect(outcome.found[0]!.cfi.startsWith('epubcfi(/6/8!')).toBe(true)
  })

  it('refuses a passage that two sections claim equally', async () => {
    /* Both sections carry the quote with the SAME (absent) context, so there is
       no evidence to prefer either. Refusing leaves the mark unplaced and
       readable in Marginalia, which is the state WI-21.7 built; placing it puts
       a highlight on a passage the reader never marked. */
    const bare: PendingMark = { id: 'm2', quote: 'the whale', prefix: '', suffix: '' }
    const outcome = await reanchorPass([bare], bookWithTwo([WRONG, 'nothing', RIGHT]))

    expect(outcome.found).toEqual([])
    expect(outcome.missed).toEqual(['m2'])
    expect(outcome.complete).toBe(true)
  })

  it('refuses the whole mark when one section could not choose', async () => {
    /* ⚠️ **AMBIGUOUS IS NOT ABSENT, and `reanchorIn` used to answer `null` for
       both.** Section 1 carries the quote TWICE with no context to tell them
       apart; section 3 carries it once. Collapsed to "no hit", section 1
       contributed nothing, section 3 looked unique, and the mark was placed
       there — on the strength of a section that had actually said *"it might
       well be here."*

       The evidence pointing away from the answer is the evidence that was being
       discarded, which is why this reads as a confident placement rather than
       as a near miss. */
    const bare: PendingMark = { id: 'm4', quote: 'the whale', prefix: '', suffix: '' }
    const outcome = await reanchorPass(
      [bare],
      bookWithTwo(['the whale swam and then the whale dived', 'nothing', 'nor here', RIGHT]),
    )

    expect(outcome.found).toEqual([])
    expect(outcome.missed).toEqual(['m4'])
    expect(outcome.complete).toBe(true)
  })

  it('still places a passage that only one section has, with no context at all', async () => {
    /* ⚠️ **THE REGRESSION THE RULE COULD EASILY HAVE CAUSED.** `Mark.prefix` is
       *"Empty when the mark sits at the edge of its section, or when it was made
       before this field existed"* — which is most marks a reader already has. A
       rule that demanded context would refuse every one of them. One candidate
       needs none: there is nowhere else it could be. */
    const bare: PendingMark = { id: 'm3', quote: 'the whale', prefix: '', suffix: '' }
    const outcome = await reanchorPass([bare], bookWithTwo(['nothing', WRONG, 'nor here']))

    expect(outcome.found).toHaveLength(1)
    expect(outcome.found[0]!.sectionIndex).toBe(1)
    expect(outcome.missed).toEqual([])
  })
})

describe('decide', () => {
  const at = (sectionIndex: number, agreement: number) =>
    ({ cfi: `epubcfi(/6/${2 * (sectionIndex + 1)}!/4/2)`, sectionIndex, agreement }) as never

  it('takes the only candidate whatever its evidence', () => {
    expect(decide([at(7, 0)])!.sectionIndex).toBe(7)
  })

  it('takes a clear winner', () => {
    expect(decide([at(1, 0.1), at(20, 0.9)])!.sectionIndex).toBe(20)
  })

  it('refuses a near tie, however high both scores are', () => {
    /* A MARGIN, not a threshold: 0.9 against 0.88 is a coin toss dressed as
       evidence. The reader is better served by a mark that stays unplaced and
       says so than by one placed in the likelier of two chapters. */
    expect(decide([at(1, 0.9), at(20, 0.88)])).toBeNull()
  })

  it('refuses when the best candidate has almost no evidence', () => {
    /* The floor beneath the margin — a gap between two amounts of nothing is
       not a finding. */
    expect(decide([at(1, 0.2), at(20, 0.0)])).toBeNull()
  })

  it('answers null for no candidates at all', () => {
    expect(decide([])).toBeNull()
  })
})

describe('Stage A exit — an imported unplaced mark becomes navigable and stays that way', () => {
  /**
   * ⚠️ **THE PLAN'S STAGE A EXIT, RUN AS A TEST rather than left as a manual
   * pass.** The stated criterion is *"a reader with imported unplaced marks
   * opens the book and watches them become navigable — the thing WI-21.7
   * promised and could not yet deliver"*, and the falsifier beneath WI-22.A2 is
   * *"relaunch and watch `marks.json`. If a mark that resolved is unplaced
   * again, the write did not happen."*
   *
   * Every other test in this phase holds one seam still: `reanchorPass.test.ts`
   * fakes the store, `markStore.test.ts` fakes the resolution. This one fakes
   * neither — a REAL corpus passage carried from one build, the REAL resolver
   * and pass, the REAL store over a filesystem, and a second store reading that
   * same filesystem as the relaunch. What it cannot exercise is foliate's own
   * renderer, which is the honest remaining gap and is why `cfiFor`'s header
   * says only a real reader can confirm the section index.
   */
  it('walks, places, and is still placed after a relaunch', async () => {
    const one = createMark({
      bookId: BOOK,
      /* NO ANCHOR HERE — the state WI-21.7 built, exactly as a name-matched
         import leaves it: an empty cfi made legal by the discriminator. */
      cfi: '',
      sectionIndex: 0,
      /* The passage as GUTENBERG's archive carries it. The book on this shelf
         is the STANDARD EBOOKS build, so the two differ in typography and the
         stored cfi would have addressed the wrong words. */
      text: CORPUS_PASSAGES[0]!.places.gutenberg.quote,
      prefix: CORPUS_PASSAGES[0]!.places.gutenberg.prefix,
      suffix: CORPUS_PASSAGES[0]!.places.gutenberg.suffix,
      note: 'what I thought when I read it',
      kind: 'highlight',
      tint: 'green',
      style: 'fill',
      chapter: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    })

    const fs = fakeFs({
      [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }),
    })
    const marks = createMarkStore({ fs, queue: writeQueue() })
    await marks.open(BOOK)
    await marks.addMany(BOOK, [one])

    /* Where the reader starts: Marginalia lists it, the painter is never
       offered it, and the jump control is disabled. */
    expect(marks.getSnapshot().unplaced.map((m) => m.id)).toEqual([one.id])
    expect(marks.getSnapshot().current).toEqual([])

    /* The open. */
    const outcome = await reanchorPass(
      marks.getSnapshot().unplaced.map((m) => ({
        id: m.id,
        quote: m.text,
        prefix: m.prefix,
        suffix: m.suffix,
      })),
      bookOf('standard-ebooks'),
    )
    expect(outcome.complete).toBe(true)
    expect(outcome.found).toHaveLength(1)
    for (const hit of outcome.found) await marks.place(hit.id, hit.cfi, hit.sectionIndex, BOOK)

    /* Navigable: in `current`, which is what the painter and the jump read. */
    const now = marks.getSnapshot()
    expect(now.unplaced).toEqual([])
    expect(now.current.map((m) => m.id)).toEqual([one.id])

    /* ⚠️ **THE RELAUNCH — the plan's own falsifier.** A second store over the
       same filesystem. A mark resolved only in memory passes every assertion
       above and fails here. */
    const relaunched = createMarkStore({ fs, queue: writeQueue() })
    await relaunched.open(BOOK)
    const after = relaunched.getSnapshot()

    expect(after.unplaced).toEqual([])
    expect(after.current.map((m) => m.id)).toEqual([one.id])
    expect(after.current[0]!.cfi).toBe(outcome.found[0]!.cfi)
    expect(after.current[0]!.sectionIndex).toBe(outcome.found[0]!.sectionIndex)
    /* The reader's own words came with it. */
    expect(after.current[0]!.note).toBe('what I thought when I read it')
    expect(after.current[0]!.tint).toBe('green')
  })

  it('leaves a passage this build does not contain unplaced, and readable', async () => {
    /* The other half of the acceptance. An unplaced mark is not a failure state
       to be cleaned up — Marginalia lists it, search finds its text, the reader
       can read their own note on it. It simply has nowhere to be painted. */
    const ghost = createMark({
      bookId: BOOK,
      cfi: '',
      sectionIndex: 0,
      text: 'a sentence that is in no build of this book',
      prefix: '',
      suffix: '',
      note: 'kept anyway',
      kind: 'highlight',
      tint: 'purple',
      style: 'fill',
      chapter: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    })
    const fs = fakeFs({
      [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }),
    })
    const marks = createMarkStore({ fs, queue: writeQueue() })
    await marks.open(BOOK)
    await marks.addMany(BOOK, [ghost])

    const outcome = await reanchorPass(
      [{ id: ghost.id, quote: ghost.text, prefix: '', suffix: '' }],
      bookOf('standard-ebooks'),
    )
    expect(outcome.found).toEqual([])
    expect(outcome.missed).toEqual([ghost.id])

    const now = marks.getSnapshot()
    expect(now.current).toEqual([])
    expect(now.unplaced.map((m) => m.note)).toEqual(['kept anyway'])
  })
})
