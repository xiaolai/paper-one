import { messageOf } from '../../../kernel'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ListsPort, OwnListView } from '../lib/listsPort'

/**
 * The reader's own lists, as a surface reads them — WI-23.E1. One hook for
 * the two surfaces that draw them (the Circle screen, and the book's pane),
 * which each carried a copy of the read generation, the subscription, the
 * retained result and the failure line — and had drifted.
 *
 * `own` is `null` until the first read of a port lands — a new port starts
 * from nothing, so the previous port's lists are not shown as its own — and
 * a read that failed keeps the last lists read and says so: "no lists" and
 * "could not read the lists" are different news.
 */
export function useOwnLists(lists: ListsPort | null): { readonly own: readonly OwnListView[] | null; readonly trouble: string | null } {
  const [own, setOwn] = useState<readonly OwnListView[] | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  /** Which read is newest, so a slow answer cannot overwrite a later one. */
  const read = useRef(0)
  const refresh = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no port the read fails into an empty list nobody draws. */
    if (lists === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++read.current
    try {
      const held = await lists.lists()
      if (read.current !== mine) return
      setOwn(held)
      // Stryker disable next-line CallExpression: a read that lands clears the trouble line; a trouble that stays would be the next failure's, which sets it again.
      setTrouble(null)
    } catch (cause) {
      if (read.current !== mine) return
      setOwn((was) => was ?? [])
      setTrouble(messageOf(cause))
    }
  }, [lists])
  useEffect(() => {
    // Stryker disable next-line CallExpression: the read that follows replaces both; the reset only spares a flash of the previous port's.
    setOwn(null)
    // Stryker disable next-line CallExpression: as above.
    setTrouble(null)
    void refresh()
    return lists?.subscribe(() => void refresh())
  }, [lists, refresh])
  return { own, trouble }
}
