import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createRemoteCards, type CardsStore } from './cards'
import { createRemoteMarks, type MarksStore } from './marks'
import type { ShelfChannel } from './channel'
import type { ShelfLink } from './reconnect'
import type { Card } from '../../kernel'

/**
 * THE SHELF'S NOTES AND CARDS, for as long as the LINK is open.
 *
 * ## Why this is its own module
 *
 * `ShelfList` was two hundred and sixty lines holding navigation state, remote
 * mutation adaptation, store lifecycles, settings and four screens. This is the
 * lifecycle half: two stores, built per channel and disposed with it, and the
 * subscription the deck reads through. Nothing here knows there are tabs, and
 * nothing about the tabs needs to know when a store is rebuilt.
 *
 * ## One store per link, and why not per render
 *
 * The argument is the reconnecting `ShelfLink` (WI-20.30), which outlives
 * every channel it opens — so the stores are built ONCE and told to re-read
 * when a channel is back (below), not rebuilt per channel. This header used to
 * say "per channel" and "null between channels" from the phase-18 design,
 * where the argument was a single channel; a plain `ShelfChannel` still works
 * here and simply never hears a reopen.
 *
 * `createRemoteMarks` reads EVERY mark on the shelf when it is built —
 * `mark.list` with no book, which is the fact that makes the cross-book notes
 * pane worth mounting at all. A store built per render would re-read the whole
 * shelf every time anything changed.
 *
 * ## And disposed with it
 *
 * A store outliving its channel goes on refreshing over a socket that has
 * closed: an error per attempt, for ever, over a shelf the reader has left.
 */

/** The same array until the deck changes — `getSnapshot`'s contract. */
const EMPTY_CARDS: readonly Card[] = []

export interface RemoteStores {
  /** Null between channels — the store is rebuilt, not carried across. */
  readonly marks: MarksStore | null
  readonly cards: CardsStore | null
  /** The deck, subscribed, so `Cards` stays a plain-props pane. */
  readonly cardRows: readonly Card[]
}

export function useRemoteStores(channel: ShelfChannel & Partial<Pick<ShelfLink, 'onOpened'>>): RemoteStores {
  const [marks, setMarks] = useState<MarksStore | null>(null)
  useEffect(() => {
    const store = createRemoteMarks(channel)
    setMarks(store)
    return () => {
      store.dispose()
      setMarks(null)
    }
  }, [channel])

  const [cards, setCards] = useState<CardsStore | null>(null)
  useEffect(() => {
    const store = createRemoteCards(channel)
    setCards(store)
    return () => {
      store.dispose()
      setCards(null)
    }
  }, [channel])

  /* READ AGAIN WHEN THE CHANNEL IS BACK (WI-20.30). The link outlives its
     channels, so these stores are not rebuilt on a drop — and a store built
     over a link that later reconnected would otherwise show the marks as they
     were at the drop, for the rest of the session. A bare channel has no
     `onOpened`; then there is nothing to hear. */
  useEffect(() => {
    /* DECLARED, NOT CAST: the optional `onOpened` is part of the parameter's
       type — the same shape `remotePositions` takes — so a caller passing a
       link is checked, and a bare channel is honestly the case with nothing
       to hear. The cast this replaced invented the capability at the call. */
    if (typeof channel.onOpened !== 'function') return
    return channel.onOpened(() => {
      marks?.refresh()
      cards?.refresh()
    })
  }, [channel, marks, cards])

  const cardRows = useSyncExternalStore(
    useCallback((l: () => void) => cards?.subscribe(l) ?? (() => {}), [cards]),
    useCallback(() => cards?.all ?? EMPTY_CARDS, [cards]),
  )

  return { marks, cards, cardRows }
}
