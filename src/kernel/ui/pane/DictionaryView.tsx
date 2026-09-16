import { Layers, Trash2 } from 'lucide-react'
import {
  MAX_LOOKUP_TERMS,
  MAX_OCCURRENCES,
  cardFromLookup,
  compareTerms,
  placeKey,
  type Lookup,
  type LookupOccurrence,
} from '../../core/lookups'
import { ICON, type Platform } from '../../core/metrics'
import { relativeTime } from '../../core/relativeTime'
import type { CardsView } from '../hooks/useCards'
import type { GlossState } from '../hooks/useGloss'
import type { JumpTarget } from '../hooks/useJumps'
import { lookUpSays } from '../lookUpWords'
import { comboFor } from '../panes'
import styles from './SidePane.module.css'

/**
 * Marginalia's Dictionary view (phase 17, WI-17.3) — the lookup happening now,
 * and the lookups already made.
 *
 * THE BODY SWAPS; THE ROW TYPE DOES NOT. Marginalia renders this instead of its
 * mark list when the Dictionary chip is on, so `matches` is never asked about a
 * lookup and no discriminant is threaded through every mark invariant for one
 * chip's sake — phase 17 §2's decision.
 *
 * ## Two states
 *
 * THE LIVE ENTRY, when a lookup is on: one entry, at the top, and visibly apart
 * from history because it is happening. It keeps the lookup face's doctrine —
 * amber for a definition and for "Looking…", never for a failure or a refusal.
 *
 * HISTORY, otherwise and below it: newest first, each word with the sense it
 * had in each place it was met, the sentence it was met in — which jumps there,
 * by the rule every Marginalia row obeys — and where it came from.
 *
 * ## The bounds, said
 *
 * The history is capped (`MAX_LOOKUP_TERMS`, `MAX_OCCURRENCES`) and the view
 * prints both numbers beside the list, rather than a reader discovering the cap
 * when their oldest word quietly goes.
 */
export interface DictionaryViewProps {
  readonly lookups: readonly Lookup[]
  /** False once a write has failed — see `LookupSnapshot.persistent`. */
  readonly persistent: boolean
  /** The lookup on now, or idle. */
  readonly live: GlossState
  /** The open book, or null. */
  readonly bookId: string | null
  /** Marginalia's "This book" scope — the history narrowed to the open book's places. */
  readonly thisBookOnly: boolean
  readonly now: number
  /** For the empty state, which names the key. */
  readonly platform: Platform
  readonly titleOf?: ((bookId: string) => string | undefined) | undefined
  readonly onShelf?: ((bookId: string) => boolean) | undefined
  readonly onGoTo?: ((target: JumpTarget) => void) | undefined
  /** Absent: no remove control — see `MarginaliaProps.lookups`. */
  readonly onRemove?: ((term: string) => void) | undefined
  /** Absent: no card control — `MarginaliaProps.cards`' rule. */
  readonly cards?: Pick<CardsView, 'make'> | undefined
}

const NOT_SAVING = "Your lookups are not being saved — this device's storage is unavailable."

export function DictionaryView({
  lookups,
  persistent,
  live,
  bookId,
  thisBookOnly,
  now,
  platform,
  titleOf,
  onShelf,
  onGoTo,
  onRemove,
  cards,
}: DictionaryViewProps) {
  /* THE SCOPE NARROWS PLACES, and a word with none left in scope is not shown —
     phase 17 §2: "storing `bookId` on each occurrence makes the existing scope
     chips work on lookups with no new UI".

     NEWEST FIRST BY WHAT IS SHOWN. The store orders words by their newest place
     in ANY book, so narrowed to this one, a word met elsewhere a moment ago sat
     above a word met here since (#123). A record's places are newest first, so
     a word's first place in scope is its newest; a tie goes to the term, by the
     comparator `byRecent` settles its own ties with, which makes the order a
     function of the data. */
  const shown = lookups
    .flatMap((lookup) => {
      const places =
        thisBookOnly && bookId !== null ? lookup.occurrences.filter((one) => one.bookId === bookId) : lookup.occurrences
      const first = places[0]
      /* Spelled as it was met first in scope — the row's headword. */
      return first === undefined ? [] : [{ lookup, places, spelled: first.spelled, at: first.at }]
    })
    .sort((a, b) => b.at - a.at || compareTerms(a.lookup.term, b.lookup.term))

  /* MARGINALIA'S RULE, for a place: the open book always, another book when it
     is on the shelf — and a place with no anchor, or a host with nowhere to go,
     is not somewhere to go. `undefined` is the disabled control, so the button
     cannot be enabled with nothing behind it. */
  const goTo = (place: LookupOccurrence): (() => void) | undefined =>
    onGoTo !== undefined && place.cfi !== '' && (place.bookId === bookId || (onShelf?.(place.bookId) ?? false))
      ? () => onGoTo({ bookId: place.bookId, cfi: place.cfi })
      : undefined

  return (
    <>
      {live.kind !== 'idle' && <LiveLookUp state={live} />}

      {!persistent && (
        <div className={styles.panelMeta}>
          <span>{NOT_SAVING}</span>
        </div>
      )}

      {shown.length === 0 ? (
        live.kind === 'idle' && (
          <div className={styles.empty}>
            <div className={styles.emptyBody}>
              {thisBookOnly && bookId !== null ? 'No lookups in this book yet. ' : 'No lookups yet. '}
              Select a word and choose Look up, or press {comboFor('⌃⌘D', platform)}
              {/* WHAT IS KEPT, SAID AS IT IS (#126). "Every word you look up" is
                  not: a lookup is filed when Paper defines the word, and a
                  failure or a refusal files nothing. And a history that is not
                  being saved is held only until Paper closes — the notice above
                  says so, and this must not promise otherwise under it. */}
              {persistent
                ? ' — every word Paper defines is kept here.'
                : ' — the words Paper defines are listed here until you close Paper.'}
            </div>
          </div>
        )
      ) : (
        <>
          {shown.map(({ lookup, places, spelled }) => (
            <div key={lookup.term} className={styles.note} data-kind="lookup">
              <div className={styles.lookupHead}>
                <span className={styles.lookupTerm}>{spelled}</span>
                {onRemove && (
                  <button
                    type="button"
                    className={styles.noteDelete}
                    title="Remove from your lookups"
                    aria-label={`Remove “${spelled}” from your lookups`}
                    onClick={() => onRemove(lookup.term)}
                  >
                    <Trash2 size={ICON.inline} strokeWidth={ICON.stroke} />
                  </button>
                )}
              </div>
              {places.map((place) => {
                const go = goTo(place)
                return (
                  /* KEYED BY THE RECORD'S OWN IDENTITY for a place, so the list
                     cannot call two places one that the record keeps as two —
                     two unanchored places in one book shared `bookId|cfi`. */
                  <div key={placeKey(place)} className={styles.lookupPlace}>
                    {/* THE SENSE HERE, which is the whole point of keeping the
                        place: the same word in two sentences is two senses. */}
                    <div className={styles.lookupSense}>{place.gloss}</div>
                    <button type="button" className={styles.noteJump} disabled={go === undefined} onClick={go}>
                      <span className={styles.lookupSentence}>{place.sentence}</span>
                    </button>
                    <div className={styles.noteSource}>
                      <span>
                        {place.bookId !== bookId ? `${titleOf?.(place.bookId) || 'Another book'} · ` : ''}
                        {place.chapter || 'Unknown chapter'} · {relativeTime(place.at, now)}
                      </span>
                      {cards !== undefined && (
                        <span className={styles.rowActions}>
                          {/* WI-17.6 — history is what you looked up, a card is
                              what you decided to keep, and this is the one
                              gesture between them, the same one a mark row has. */}
                          <button
                            type="button"
                            className={styles.noteDelete}
                            aria-label={`Make a card of “${place.spelled}”`}
                            title="Make a card"
                            onClick={() => cards.make(cardFromLookup(place))}
                          >
                            <Layers size={ICON.inline} strokeWidth={ICON.stroke} />
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          <div className={styles.panelMeta}>
            <span>
              Paper keeps the last {MAX_LOOKUP_TERMS} words you looked up, and {MAX_OCCURRENCES} places for each.
            </span>
          </div>
        </>
      )}
    </>
  )
}

/**
 * The lookup happening now. The lookup face's states, in a row's clothes — and
 * its doctrine: `data-kind="companion"` (amber) only for a definition and for
 * the wait before one, never for a failure or a refusal.
 */
function LiveLookUp({ state }: { readonly state: Exclude<GlossState, { readonly kind: 'idle' }> }) {
  /* THE WORDS ARE `lookUpWords`', THE LAYOUT IS THIS ROW'S (#124). The popup's
     face draws the same four sentences and each file had its own copy of all
     of them. */
  const { said, because } = lookUpSays(state)
  if (state.kind === 'asking' || state.kind === 'ready') {
    return (
      <div className={styles.note} data-kind="companion" role="status">
        <div className={styles.noteKind}>{state.kind === 'asking' ? 'Looking up' : 'Looked up'}</div>
        <div className={styles.lookupTerm}>{state.term}</div>
        <div className={styles.lookupSense}>{said}</div>
      </div>
    )
  }
  return (
    /* A PLACE ROW'S CLOTHES, so no tint bar says anything about a mark. */
    <div className={styles.note} data-place="true" role="status">
      <div className={styles.noteKind}>Look up</div>
      {/* ONE LINE, cause and all: a row has no second line to give it, which is
          the layout difference `LookUpWords.because` exists to leave to each
          surface. */}
      <div className={styles.noteComment}>{because === null ? said : `${said} ${because}`}</div>
    </div>
  )
}
