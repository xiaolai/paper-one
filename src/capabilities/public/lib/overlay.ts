import {
  overlayKeyOf,
  reconcile,
  standingOf,
  type AnchorWeight,
  type ForeignAnnotation,
  type ForeignOpinion,
  type OverlayRequest,
  type PublicFile,
  type ResolvedPassage,
  type VoiceDecisions,
} from '../../../kernel'

/**
 * Turning held public annotations into something the painter can draw —
 * WI-26.6, and the first of the three seams phase 26 says must be SHARED.
 *
 * ## Why this reuses the circle's contract rather than copying it
 *
 * ⚠️ **THE FIRST DRAFT OF THE PHASE'S CENTRAL RULE SAID "NO CODE PATH, NO
 * DIRECTORY, NO TYPE", WHICH IS NOT ACHIEVABLE AND WOULD BE HARMFUL IF IT
 * WERE.** Three seams force sharing, and copying them to satisfy a slogan buys
 * no admission protection:
 *
 * | Seam | Why it must be shared |
 * |---|---|
 * | `OverlayContribution.forBook` answers `ForeignAnnotation[]`, and the reader has ONE painter | a second painter is a second set of the geometry tests, or none |
 * | `PendingMark` and the resolver | shared geometry; duplicating the walk adds risk and no safety |
 * | `Library.lane` | a public write on an unrelated queue races rekeying and deletion |
 *
 * What is NOT shared is authorization, storage and the wire type — which is
 * where the opposite defaults live, and where a single predicate serving both
 * would make the wrong one invisible.
 *
 * ⚠️ **THE ANNOTATION IS TAGGED BY AUDIENCE, WHICH IS WHAT THE SHARED CONTRACT
 * NEEDED — AND IT USED TO BE TAGGED BY A PREFIX NOTHING DOWNSTREAM READ.**
 * `person` carried `public:<voice>`, a value no 64-hex circle person id can
 * collide with, so the two layers keyed apart correctly. What it did NOT do is
 * reach the painter: `useOverlays` keeps a key and a count and drops the rest,
 * and `attachForeign` labelled everything with the circle's painter kind — so
 * a stranger's mark was drawn as a friend's, in a friend's hue, and the
 * comment above claimed otherwise. `ForeignOpinion.audience` is a field now,
 * the key's first segment comes from it (`overlayKeyOf`), and
 * `MarkPalette.stranger` is what the reader actually sees. Found by audit.
 */

/** One held publication, parsed far enough to anchor and draw. */
interface Readable {
  readonly pub: string
  readonly voice: string
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly note?: string
}

/**
 * Parse a held line far enough to draw it.
 *
 * ⚠️ **PARSED AT THE MOMENT IT IS SHOWN, FROM THE BYTES THAT WERE SIGNED.**
 * There is no stored projection — see `publicStore` — so this is where the
 * passage comes from, every time. A version that cached the parse beside the
 * line would be the separately mutable projection finding #3 is about.
 */
function readable(received: string): Readable | null {
  try {
    const parsed: unknown = JSON.parse(received)
    if (typeof parsed !== 'object' || parsed === null) return null
    const one = parsed as Record<string, unknown>
    const passage = one['passage']
    if (one['op'] !== 'note' || typeof passage !== 'object' || passage === null) return null
    const parts = passage as Record<string, unknown>
    if (
      typeof one['pub'] !== 'string' ||
      typeof one['voice'] !== 'string' ||
      typeof parts['quote'] !== 'string' ||
      typeof parts['prefix'] !== 'string' ||
      typeof parts['suffix'] !== 'string'
    ) {
      return null
    }
    return {
      pub: one['pub'],
      voice: one['voice'],
      quote: parts['quote'],
      prefix: parts['prefix'],
      suffix: parts['suffix'],
      ...(typeof parts['note'] === 'string' ? { note: parts['note'] } : {}),
    }
  } catch {
    return null
  }
}

/** The key an anchored public annotation is filed under. */
function keyOf(one: Readable): string {
  return overlayKeyOf('public', one.voice, one.pub)
}

/** A publication that a re-anchoring pass placed in THIS build. */
interface Anchored {
  readonly one: Readable
  readonly at: ResolvedPassage
}

/**
 * Parse, filter and anchor — everything before the weight is known.
 *
 * ⚠️ **A BLOCKED VOICE IS NOT ANCHORED, NOT MERELY NOT DRAWN.** Anchoring is
 * the expensive step — `reanchorPass` walks every section — so filtering after
 * it would let a blocked voice keep spending the reader's main thread. The
 * circle's `drawsEntry` makes the same decision one layer up for the same
 * reason.
 */
async function anchoredRows(
  held: PublicFile,
  decisions: VoiceDecisions,
  request: OverlayRequest,
): Promise<readonly Anchored[]> {
  const rows = held.held
    .map((one) => readable(one.received))
    .filter((one): one is Readable => one !== null)
    .filter((one) => standingOf(one.voice, decisions) !== 'blocked')
  if (rows.length === 0) return []

  const result = await request.resolve(
    rows.map((one) => ({ id: keyOf(one), quote: one.quote, prefix: one.prefix, suffix: one.suffix })),
  )
  const found = new Map<string, ResolvedPassage>()
  for (const one of result.found) found.set(one.id, one)

  return rows
    .map((one) => ({ one, at: found.get(keyOf(one)) }))
    .filter((pair): pair is Anchored => pair.at !== undefined)
}

/** Where a publication landed, as both this module and `reconcile` key it. */
function anchorOf(at: ResolvedPassage): string {
  return `${at.sectionIndex}#${at.cfi}`
}

/**
 * Anchor what is held, then hand over what can be drawn.
 *
 * ⚠️ **THREE STAGES, AND THE MIDDLE ONE IS THE WORK ITEM.** Anchoring decides
 * what exists, `reconcile` decides who is behind it, and only then is anything
 * grouped for the painter. The stages are separate functions because the
 * question "what did this stage lose?" is the one that has now twice had a
 * wrong answer here — a blocked voice walked anyway, and every note after the
 * first at one anchor discarded.
 */
export async function publicAnnotationsFor(
  held: PublicFile,
  decisions: VoiceDecisions,
  request: OverlayRequest,
): Promise<readonly ForeignAnnotation[]> {
  const anchored = await anchoredRows(held, decisions, request)
  if (anchored.length === 0) return []

  /* ⚠️ **RECONCILIATION BEFORE THE WEIGHT — WI-26.6.** Several voices bound to
     one person are one person, and an unbound voice is nobody at all. Weighing
     first is what counts one person twice. The circle's own marks are NOT in
     this input — they arrive through their own contribution — so what this
     stage can reconcile is voices against each other; the cross-contribution
     half is the overlay host's, which is why the PEOPLE travel and not a
     number. */
  const weights = new Map<string, AnchorWeight>(
    reconcile(
      anchored.map(({ one, at }) => ({ anchor: anchorOf(at), voice: one.voice })),
      decisions,
    ).map((weight) => [weight.anchor, weight]),
  )

  return grouped(anchored, weights)
}

/**
 * One drawable mark per anchor, keeping every publication's own words.
 *
 * ⚠️ **GROUPED FOR THE WEIGHT, NOT FOR THE WORDS — AND IT USED TO BE BOTH.**
 * `if (byAnchor.has(anchor)) continue` dropped every publication after the
 * first at one passage, so a second stranger's note was parsed, verified,
 * anchored and then silently discarded along with who wrote it. Grouping is
 * still right: a hundred free keys on one sentence must be ONE rule, or the
 * reader's page is a denial of service anybody can mount. What was wrong is
 * that the notes went with the weight. Found by audit, in the circle's
 * `drawable` too — the shape this copied.
 */
function grouped(
  anchored: readonly Anchored[],
  weights: ReadonlyMap<string, AnchorWeight>,
): readonly ForeignAnnotation[] {
  const byAnchor = new Map<string, { annotation: ForeignAnnotation; opinions: ForeignOpinion[] }>()
  for (const { one, at } of anchored) {
    const anchor = anchorOf(at)
    const opinion: ForeignOpinion = {
      pub: one.pub,
      audience: 'public',
      /* The voice's own claim, never Paper's verdict — `drawable`'s rule for
         a circle person's name, and the same reasoning: there is nothing here
         Paper has checked about who this is. */
      author: one.voice,
      ...(one.note === undefined ? {} : { note: one.note }),
    }
    const seen = byAnchor.get(anchor)
    if (seen !== undefined) {
      seen.opinions.push(opinion)
      continue
    }
    byAnchor.set(anchor, {
      opinions: [opinion],
      annotation: {
        person: one.voice,
        cfi: at.cfi,
        sectionIndex: at.sectionIndex,
        quote: one.quote,
        opinions: [],
        /* ⚠️ **THE PEOPLE, NEVER A COUNT OF VOICES.** `reconcile` has already
           folded several of one person's bound voices into that person and
           left every unbound voice out entirely — so an anchor a thousand
           free keys marked carries an EMPTY list, and `readersAmong` floors it
           at the one reader a mark on the page implies. */
        people: weights.get(anchor)?.readers ?? [],
      },
    })
  }
  return [...byAnchor.values()].map(({ annotation, opinions }) => ({ ...annotation, opinions }))
}
