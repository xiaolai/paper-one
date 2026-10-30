import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../canonicalJson'
import { DEFAULT_LIFETIME_MS, PUBLIC_VERSION, type PublicEnvelope } from './envelope'
import {
  EMPTY_PUBLIC_FILE,
  comparePublic,
  foldPublic,
  publicationKey,
  sequenceKey,
  type Delivered,
  type PublicFile,
} from './order'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const BOOK = 'c'.repeat(64)
const SIG = 'd'.repeat(128)
const NOW = 1_700_000_000_000
const LATER = NOW + DEFAULT_LIFETIME_MS

function note(over: Partial<PublicEnvelope> = {}): PublicEnvelope {
  return {
    v: PUBLIC_VERSION,
    voice: A,
    book: BOOK,
    seq: 1,
    at: NOW,
    expires: LATER,
    pub: 'p1',
    op: 'note',
    passage: { quote: 'a sentence', prefix: '', suffix: '', chapter: '' },
    sig: SIG,
    ...over,
  } as PublicEnvelope
}

function unnote(over: Partial<PublicEnvelope> = {}): PublicEnvelope {
  return { v: PUBLIC_VERSION, voice: A, book: BOOK, seq: 2, at: NOW, expires: LATER, pub: 'p1', op: 'unnote', sig: SIG, ...over } as PublicEnvelope
}

const delivered = (envelope: PublicEnvelope): Delivered => ({ envelope, received: canonicalJson(envelope) })

/** Every ordering of `items` — the permutation test WI-26.1 asks for. */
function orders<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of orders(rest)) out.push([items[i]!, ...tail])
  }
  return out
}

/** What a fold amounts to, for comparing two delivery orders. */
const shapeOf = (file: PublicFile): string =>
  canonicalJson({
    held: file.held.map((one) => one.received),
    withdrawn: file.withdrawn.map((one) => one.key),
    equivocated: file.equivocated.map((one) => one.key),
  })

describe('every delivery order reaches the same result', () => {
  it('holds for a publication and its withdrawal', () => {
    /* ⚠️ **"ONE VOICE, SO NO MERGING" IS FALSE.** Two recipients can receive
       the same objects from different providers in opposite orders. */
    const items = [delivered(note()), delivered(unnote())]
    const shapes = new Set(orders(items).map((order) => shapeOf(foldPublic(EMPTY_PUBLIC_FILE, order, NOW))))
    expect(shapes.size, 'the delivery order decided the outcome').toBe(1)
    const [only] = [...shapes]
    expect(only).toContain('"held":[]')
  })

  it('holds for two voices, two publications and one withdrawal', () => {
    const items = [
      delivered(note()),
      delivered(note({ voice: B, pub: 'q1', at: NOW + 1 })),
      delivered(unnote()),
      delivered(note({ seq: 3, pub: 'p2', at: NOW + 2 })),
    ]
    const shapes = new Set(orders(items).map((order) => shapeOf(foldPublic(EMPTY_PUBLIC_FILE, order, NOW))))
    expect(shapes.size).toBe(1)
  })

  it('holds when the fold is applied one at a time rather than all at once', () => {
    /* ⚠️ **`applyEntries` IN THE CIRCLE FOLDED RAW AND THE ARRIVAL ORDER
       DECIDED**, measured, not reasoned. One fold at a time and one fold of
       everything have to agree, or a device that received a batch and one that
       received a stream diverge for ever. */
    const items = [delivered(note()), delivered(note({ seq: 4, pub: 'p1', at: NOW + 5 })), delivered(unnote({ seq: 9 }))]
    for (const order of orders(items)) {
      let byOne = EMPTY_PUBLIC_FILE
      for (const one of order) byOne = foldPublic(byOne, [one], NOW)
      expect(shapeOf(byOne), 'one at a time disagreed with all at once').toBe(shapeOf(foldPublic(EMPTY_PUBLIC_FILE, order, NOW)))
    }
  })
})

describe('withdrawal precedence', () => {
  it('a withdrawal that arrives first suppresses the publication that follows', () => {
    const file = foldPublic(EMPTY_PUBLIC_FILE, [delivered(unnote()), delivered(note())], NOW)
    expect(file.held).toEqual([])
    expect(file.withdrawn.map((one) => one.key)).toEqual([publicationKey(A, 'p1')])
  })

  it('a republished note at a HIGHER sequence does not revive it', () => {
    /* ⚠️ **ORDERING THESE BY `seq` WOULD LET A VOICE THAT LOST ITS COUNTER
       UN-WITHDRAW SOMETHING A READER HAD TAKEN BACK.** A reader taking their
       words back must not be defeated by the publisher's own bookkeeping. */
    const file = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note()), delivered(unnote({ seq: 2 })), delivered(note({ seq: 99 }))], NOW)
    expect(file.held).toEqual([])
  })

  it('withdrawing one publication leaves the voice’s others', () => {
    const file = foldPublic(
      EMPTY_PUBLIC_FILE,
      [delivered(note()), delivered(note({ seq: 2, pub: 'p2' })), delivered(unnote({ seq: 3, pub: 'p1' }))],
      NOW,
    )
    expect(file.held.map((one) => one.pub)).toEqual(['p2'])
  })

  it('a withdrawal is forgotten once nothing it suppresses could still be valid', () => {
    /* ⚠️ **BOUNDED SUPPRESSION IS WHY THE EXPIRY IS SIGNED.** The circle
       remembers a withdrawal for ever, which was reasonable for admitted
       humans; here keys and publication ids are free. */
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(unnote())], NOW)
    expect(held.withdrawn).toHaveLength(1)
    expect(foldPublic(held, [], LATER + 1).withdrawn).toEqual([])
  })
})

describe('duplicate delivery', () => {
  it('the same statement twice is one publication', () => {
    const twice = [delivered(note()), delivered(note())]
    expect(foldPublic(EMPTY_PUBLIC_FILE, twice, NOW).held).toHaveLength(1)
  })

  it('the same publication id at a later sequence does not move it', () => {
    /* The EARLIER stands, so a redelivery cannot quietly move a passage up a
       reader's list — `fold`'s rule in `log.ts`. */
    const file = foldPublic(
      EMPTY_PUBLIC_FILE,
      [delivered(note({ seq: 5, passage: { quote: 'first', prefix: '', suffix: '', chapter: '' } })), delivered(note({ seq: 7 }))],
      NOW,
    )
    expect(file.held).toHaveLength(1)
    expect(file.held[0]?.seq).toBe(5)
    expect(file.held[0]?.received).toContain('first')
  })
})

describe('equivocation — two valid conflicting envelopes', () => {
  const first = note({ passage: { quote: 'one thing', prefix: '', suffix: '', chapter: '' } })
  const second = note({ passage: { quote: 'another thing', prefix: '', suffix: '', chapter: '' } })

  it('drops both, whichever order they arrive in', () => {
    /* ⚠️ **ONLY THIS VOICE'S OWN KEY COULD HAVE SIGNED BOTH**, so recording it
       against the voice is not a denial vector somebody else can aim. */
    for (const order of orders([delivered(first), delivered(second)])) {
      const file = foldPublic(EMPTY_PUBLIC_FILE, order, NOW)
      expect(file.held, 'an equivocating voice kept a publication').toEqual([])
      expect(file.equivocated.map((one) => one.key)).toEqual([sequenceKey(A, 1)])
    }
  })

  it('a later redelivery of either does not revive it', () => {
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(first), delivered(second)], NOW)
    expect(foldPublic(after, [delivered(first)], NOW).held).toEqual([])
    expect(foldPublic(after, [delivered(second)], NOW).held).toEqual([])
  })

  it('takes down only the sequence it happened at', () => {
    const file = foldPublic(
      EMPTY_PUBLIC_FILE,
      [delivered(first), delivered(second), delivered(note({ seq: 2, pub: 'p2', at: NOW + 1 }))],
      NOW,
    )
    expect(file.held.map((one) => one.pub)).toEqual(['p2'])
  })

  it('leaves another voice at the same sequence alone', () => {
    const file = foldPublic(
      EMPTY_PUBLIC_FILE,
      [delivered(first), delivered(second), delivered(note({ voice: B, pub: 'q1' }))],
      NOW,
    )
    expect(file.held.map((one) => one.voice)).toEqual([B])
  })

  it('is forgotten once nothing could still carry it', () => {
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(first), delivered(second)], NOW)
    expect(after.equivocated).toHaveLength(1)
    expect(foldPublic(after, [], LATER + 1).equivocated).toEqual([])
  })
})

describe('expiry', () => {
  it('drops a publication whose signed expiry has passed', () => {
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note())], NOW)
    expect(held.held).toHaveLength(1)
    expect(foldPublic(held, [], LATER + 1).held).toEqual([])
  })

  it('keeps one exactly at its expiry’s last moment and drops it after', () => {
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note())], NOW)
    expect(foldPublic(held, [], LATER - 1).held).toHaveLength(1)
    expect(foldPublic(held, [], LATER).held).toEqual([])
  })
})

describe('comparePublic', () => {
  const row = (over: Partial<{ at: number; voice: string; seq: number }>) => ({
    received: '',
    voice: A,
    pub: 'p',
    seq: 1,
    at: NOW,
    expires: LATER,
    ...over,
  })

  it('orders by the publisher’s stated time, then the voice, then the sequence', () => {
    expect(comparePublic(row({ at: 1 }), row({ at: 2 }))).toBeLessThan(0)
    expect(comparePublic(row({ voice: A }), row({ voice: B }))).toBeLessThan(0)
    expect(comparePublic(row({ seq: 1 }), row({ seq: 2 }))).toBeLessThan(0)
  })

  it('is total, so two replicas list the same things the same way', () => {
    /* ⚠️ **`at` IS THE PUBLISHER'S OWN CLOCK AND IS NOT EVIDENCE.** It decides
       a list's order and nothing else; the tiebreaks are what make the order
       identical everywhere, which is the property that matters. */
    const rows = [row({ at: 2 }), row({ at: 1, voice: B }), row({ at: 1, voice: A, seq: 3 }), row({ at: 1, voice: A, seq: 2 })]
    const forward = [...rows].sort(comparePublic).map((one) => `${one.at}${one.voice[0]}${one.seq}`)
    const backward = [...rows].reverse().sort(comparePublic).map((one) => `${one.at}${one.voice[0]}${one.seq}`)
    expect(forward).toEqual(backward)
  })
})

describe('the sequence is recorded even for a withdrawn publication', () => {
  it('so a second envelope at that sequence is still caught', () => {
    /* ⚠️ **THIS WAS RECORDED AFTER THE WITHDRAWAL CHECK, AND THE EVIDENCE WAS
       LOST.** A note whose publication had already been withdrawn returned
       without leaving its sequence behind, so a SECOND envelope at the same
       sequence met no conflict and was admitted — the voice had equivocated
       and the fold could not see it. */
    const first = note({ passage: { quote: 'one thing', prefix: '', suffix: '', chapter: '' } })
    const second = note({ passage: { quote: 'another thing', prefix: '', suffix: '', chapter: '' } })
    const file = foldPublic(EMPTY_PUBLIC_FILE, [delivered(unnote({ seq: 5 })), delivered(first), delivered(second)], NOW)
    expect(file.held).toEqual([])
    expect(file.equivocated.map((one) => one.key)).toEqual([sequenceKey(A, 1)])
  })
})

describe('conflicts are resolved before any effect is applied', () => {
  it('a withdrawal at an equivocated sequence takes effect in NO order', () => {
    /* ⚠️ **MEASURED BY AUDIT: `[note(p,1), unnote(p,2), note(q,2)]` WITHDREW
       `p`, AND SWAPPING THE LAST TWO LEFT `p` VISIBLE.** In one order the
       withdrawal took effect before its own sequence was found to be
       equivocated; in the other it never took effect at all. Detecting an
       equivocation removes the publications — it cannot undo an effect already
       applied — so nothing may be applied until every conflict is known. */
    const items = [
      delivered(note({ seq: 1, pub: 'p' })),
      delivered(unnote({ seq: 2, pub: 'p' })),
      delivered(note({ seq: 2, pub: 'q' })),
    ]
    const shapes = new Set(orders(items).map((order) => shapeOf(foldPublic(EMPTY_PUBLIC_FILE, order, NOW))))
    expect(shapes.size, 'the delivery order decided whether p was withdrawn').toBe(1)
    const [only] = [...shapes]
    /* Sequence 2 equivocated, so neither envelope at it counts — `p` stands. */
    expect(only).toContain('"withdrawn":[]')
    expect(only).toContain('"equivocated":["' + sequenceKey(A, 2) + '"]')
  })
})

describe('a suppression outlives the note it suppresses', () => {
  it('a short withdrawal of a long note does not let the note come back', () => {
    /* ⚠️ **MEASURED BY AUDIT.** Suppression expired when the WITHDRAWAL said
       it did, so a short-lived `unnote` for a long-lived `note` was forgotten
       while the note was still valid — the exact replay WI-26.3 exists to
       prevent, arriving through the expiry rather than around it. */
    const long = note({ seq: 1, pub: 'p', expires: NOW + 100_000 })
    const brief = unnote({ seq: 2, pub: 'p', expires: NOW + 10 })
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(long), delivered(brief)], NOW)
    expect(after.held).toEqual([])
    /* Past the withdrawal's own expiry, and the note still cannot return. */
    const later = foldPublic(after, [delivered(long)], NOW + 50)
    expect(later.held, 'a withdrawn note came back once its withdrawal expired').toEqual([])
  })

  it('and a note arriving after the withdrawal extends it too', () => {
    const brief = unnote({ seq: 2, pub: 'p', expires: NOW + 10 })
    const long = note({ seq: 1, pub: 'p', expires: NOW + 100_000 })
    const withdrawnFirst = foldPublic(EMPTY_PUBLIC_FILE, [delivered(brief)], NOW)
    const thenNote = foldPublic(withdrawnFirst, [delivered(long)], NOW + 5)
    expect(foldPublic(thenNote, [delivered(long)], NOW + 50).held).toEqual([])
  })
})

describe('expired state is pruned before anything is evaluated', () => {
  it('an expired withdrawal does not suppress an arriving note', () => {
    /* ⚠️ **MEASURED BY AUDIT: an expired withdrawal suppressed a note on the
       first fold and permitted the same note if an empty fold had run first.**
       Whether a publication appeared depended on how many times the caller had
       folded, which is not a rule. */
    const brief = unnote({ seq: 2, pub: 'p', expires: NOW + 10 })
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(brief)], NOW)
    const fresh = note({ seq: 5, pub: 'p', at: NOW + 100, expires: NOW + 100_000 })

    const direct = foldPublic(held, [delivered(fresh)], NOW + 50)
    const viaEmpty = foldPublic(foldPublic(held, [], NOW + 50), [delivered(fresh)], NOW + 50)
    expect(shapeOf(direct)).toBe(shapeOf(viaEmpty))
    expect(direct.held).toHaveLength(1)
  })
})

describe('a cached suppression cannot outlive its evidence', () => {
  /* ⚠️ **THE WITHDRAWN MAP WAS CARRIED FORWARD BEFORE CONFLICTS WERE KNOWN.**
     A withdrawal recorded by one fold went on suppressing even after a later
     fold found its own sequence equivocated — the cache outlived the evidence
     that justified it, and nothing could take it back. Reproduced by audit. */
  it('stops suppressing once the withdrawal’s own sequence turns out to be equivocated', () => {
    /* First fold: the withdrawal is honest and takes p down. */
    const gone = unnote({ seq: 2, pub: 'p1' })
    const first = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note()), delivered(gone)], NOW)
    expect(first.held, 'the withdrawal did not take effect').toHaveLength(0)
    expect(first.withdrawn.map((one) => one.key)).toEqual([publicationKey(A, 'p1')])

    /* Then the SAME voice is seen to have used sequence 2 for something else.
       The withdrawal is now one of two conflicting envelopes, so it is not
       evidence of anything — and the publication it took down must come back. */
    const rival = note({ seq: 2, pub: 'p2', passage: { quote: 'another', prefix: '', suffix: '', chapter: '' } })
    const after = foldPublic(first, [delivered(rival)], NOW)
    expect(after.equivocated.map((one) => one.key)).toContain(sequenceKey(A, 2))
    expect(
      after.held.map((one) => one.pub),
      'a withdrawal by an equivocated sequence still suppressed, because the map was cached',
    ).toEqual(['p1'])
  })

  /* The other side of the asymmetry: an equivocation IS remembered, because it
     is detected by seeing two spellings and stops being detectable the moment
     either side expires. */
  it('keeps remembering an equivocation after one side is redelivered alone', () => {
    const first = note({ passage: { quote: 'one thing', prefix: '', suffix: '', chapter: '' } })
    const second = note({ passage: { quote: 'another thing', prefix: '', suffix: '', chapter: '' } })
    const caught = foldPublic(EMPTY_PUBLIC_FILE, [delivered(first), delivered(second)], NOW)
    expect(foldPublic(caught, [delivered(first)], NOW).held).toEqual([])
  })
})

describe('what is kept is what is persisted', () => {
  /* ⚠️ **THE SUPPRESSION OUTLIVED THE EVIDENCE, SO A RELOAD REVIVED THE
     NOTE.** The derived `withdrawn` map already took the later of the two
     expiries; `kept` — the thing that is actually persisted — did not, and
     pruned the withdrawal on its own. A reader who took something back saw it
     come back as soon as the withdrawal expired, while the note it withdrew
     was still live. Reproduced by audit. */
  it('keeps a short-lived withdrawal while the longer-lived note it took back is still live', () => {
    const lasting = note({ seq: 1, pub: 'p', expires: NOW + 100_000 })
    const brief = unnote({ seq: 2, pub: 'p', expires: NOW + 10 })
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(lasting), delivered(brief)], NOW)
    expect(held.held, 'the withdrawal did not take effect at all').toHaveLength(0)

    /* Past the WITHDRAWAL's own expiry, well inside the NOTE's. */
    const later = foldPublic(held, [], NOW + 50)
    expect(
      later.kept.some((one) => one.op === 'unnote'),
      'the evidence was pruned while the note it suppresses was still live',
    ).toBe(true)
    expect(later.held, 'the withdrawn note came back').toHaveLength(0)

    /* And replaying the original note does not revive it either — which is the
       failure a reader would actually meet, since providers re-send. */
    const replayed = foldPublic(later, [delivered(lasting)], NOW + 60)
    expect(replayed.held, 'a replay revived a withdrawn note').toHaveLength(0)
  })

  /* The other side of the same rule: retention is BOUNDED. Once nothing it
     suppresses is live, the withdrawal goes — otherwise the store grows by one
     permanent record per publication anybody ever takes back. */
  it('forgets the withdrawal once the note it took back has expired too', () => {
    const short = note({ seq: 1, pub: 'p', expires: NOW + 20 })
    const brief = unnote({ seq: 2, pub: 'p', expires: NOW + 10 })
    const held = foldPublic(EMPTY_PUBLIC_FILE, [delivered(short), delivered(brief)], NOW)
    const after = foldPublic(held, [], NOW + 50)
    expect(after.kept, 'suppression state outlived everything it was about').toHaveLength(0)
  })

  it('keeps the withdrawal itself, so a reload re-derives the suppression', () => {
    /* ⚠️ **THE STORE USED TO WRITE ONLY THE LIVE NOTES**, so `withdrawn` and
       `equivocated` died with the process and replaying a withdrawn note
       brought it straight back. The evidence is the ENVELOPES — nothing
       unsigned is stored, and a reload verifies every line again. */
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note()), delivered(unnote())], NOW)
    expect(after.held).toEqual([])
    expect(after.kept.map((one) => one.op).sort()).toEqual(['note', 'unnote'])

    /* A reload: fold the kept lines from nothing, as `readPublic` does. */
    const reloaded = foldPublic(
      EMPTY_PUBLIC_FILE,
      after.kept.map((one) => ({ envelope: JSON.parse(one.received) as never, received: one.received })),
      NOW,
    )
    expect(shapeOf(reloaded)).toBe(shapeOf(after))
    expect(foldPublic(reloaded, [delivered(note())], NOW).held, 'a replayed note revived after a reload').toEqual([])
  })

  it('keeps BOTH sides of an equivocation, so a reload re-derives it', () => {
    const first = note({ passage: { quote: 'one thing', prefix: '', suffix: '', chapter: '' } })
    const second = note({ passage: { quote: 'another thing', prefix: '', suffix: '', chapter: '' } })
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(first), delivered(second)], NOW)
    expect(after.kept).toHaveLength(2)
    const reloaded = foldPublic(
      EMPTY_PUBLIC_FILE,
      after.kept.map((one) => ({ envelope: JSON.parse(one.received) as never, received: one.received })),
      NOW,
    )
    expect(reloaded.equivocated.map((one) => one.key)).toEqual([sequenceKey(A, 1)])
    expect(reloaded.held).toEqual([])
  })

  it('drops an expired line from what is kept', () => {
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note())], NOW)
    expect(after.kept).toHaveLength(1)
    expect(foldPublic(after, [], LATER + 1).kept).toEqual([])
  })

  it('keeps one line per distinct envelope however often it is delivered', () => {
    const after = foldPublic(EMPTY_PUBLIC_FILE, [delivered(note()), delivered(note()), delivered(note())], NOW)
    expect(after.kept).toHaveLength(1)
  })
})
