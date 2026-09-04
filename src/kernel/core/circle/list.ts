import { type Hlc } from '../hlc'
import { compareEntries, type Entry, type ShelvedWork, type Stamped } from './log'

/**
 * A list (豆列), folded — WI-23.E1.
 *
 * A list is a titled, ordered set of works with a note per item. It is its
 * own object with its own log per `(person, listId)`: `create`, `retitle`,
 * `place`, `remove`, `delete`. Same chain, same signing, same cursors as
 * every other log; this is the fold, and `fold` in `log.ts` ignores the five
 * kinds because they never reach it.
 *
 * ## The rules, one per kind
 *
 * | Kind | Rule |
 * |---|---|
 * | `create` | the list exists; its title is a register the `create` seeds |
 * | `retitle` | the title register: the NEWEST stamp wins, ties by `(device, seq)` |
 * | `place` | a register per `pub`: newest stamp wins, so re-placing moves an item |
 * | `remove` | a tombstone per `pub`, and it wins for ever — a re-add mints a new `pub` |
 * | `delete` | a tombstone for the list, and it wins for ever — a new list is a new id |
 *
 * ## The position rule
 *
 * ⚠️ **TWO DEVICES PLACE AT POSITION 3: THE EARLIER STAMP KEEPS THE SPOT AND
 * THE LATER ONE FOLLOWS IT.** Items are ordered by `(position, at, device,
 * seq)`. A placement is an insertion at a spot in the list as the placer saw
 * it; the placer with the earlier stamp saw a list the later placer's item
 * was not yet in, so the later item goes after it — the same answer both
 * devices reach once they have each other's pages, which is what makes the
 * fold a fold. The device id breaks a true tie so two readers of one log
 * never disagree about the order, and the stamp — not the arrival — decides,
 * so the order does not depend on which page landed first.
 *
 * Positions are what the placer said, so two items can hold one number; the
 * rule above is what turns that into one order. A consumer that wants dense
 * positions renumbers `items` by index.
 */

export interface ListItem {
  readonly pub: string
  readonly work: ShelvedWork
  readonly position: number
  readonly note: string
  readonly at: Hlc
  readonly device: string
  readonly seq: number
}

export interface ListState {
  /** Whether a `create` has been seen — a list of placements with no `create` is not a list yet. */
  readonly created: boolean
  readonly title: string
  readonly deleted: boolean
  /** In the order the position rule gives. */
  readonly items: readonly ListItem[]
}

export const NO_LIST: ListState = { created: false, title: '', deleted: false, items: [] }

/** Whether `entry` beats `held` — the newest stamp, ties by `(device, seq)`. */
function newer(entry: Stamped, held: Stamped | undefined): boolean {
  return held === undefined || compareEntries(entry, held) > 0
}

/** The position rule — see the module header. */
export function compareItems(a: ListItem, b: ListItem): number {
  if (a.position !== b.position) return a.position - b.position
  return compareEntries(a, b)
}

export function foldList(entries: readonly Entry[]): ListState {
  let created = false
  let deleted = false
  let title: (Stamped & { readonly title: string }) | undefined
  const items = new Map<string, ListItem>()
  const removed = new Set<string>()

  for (const entry of entries) {
    switch (entry.op) {
      case 'create':
        created = true
        if (newer(entry, title)) title = entry
        break
      case 'retitle':
        if (newer(entry, title)) title = entry
        break
      case 'delete':
        deleted = true
        break
      case 'remove':
        removed.add(entry.pub)
        items.delete(entry.pub)
        break
      case 'place': {
        if (removed.has(entry.pub)) break
        if (!newer(entry, items.get(entry.pub))) break
        items.set(entry.pub, {
          pub: entry.pub,
          work: entry.work,
          position: entry.position,
          note: entry.note,
          at: entry.at,
          device: entry.device,
          seq: entry.seq,
        })
        break
      }
      /* Every other kind belongs to another log and says nothing here. */
      // Stryker disable all: nine arms of one decision — the type names them so a new kind fails to compile.
      case 'share':
      case 'unshare':
      case 'status':
      case 'rate':
      case 'tag':
      case 'review':
      case 'unreview':
      case 'shelf':
      case 'unshelf':
        break
      // Stryker restore all
    }
  }
  return { created, title: title?.title ?? '', deleted, items: [...items.values()].sort(compareItems) }
}

/**
 * A list log's compacted view — the title's winning entry, the live
 * placements, and the deletion if any. What a newly admitted peer would be
 * served, for `compacted`'s reason; the removed and the re-placed are
 * retracted history.
 */
export function compactedList(entries: readonly Entry[], device: string): readonly Entry[] {
  const state = foldList(entries)
  const live = new Set(state.items.map((one) => `${one.device}:${one.seq}`))
  let titled: Entry | undefined
  for (const entry of entries) {
    if ((entry.op === 'create' || entry.op === 'retitle') && newer(entry, titled)) titled = entry
  }
  const kept = entries.filter((entry) => {
    switch (entry.op) {
      case 'create':
        /* KEPT WHATEVER THE TITLE'S WINNER. The creation is what makes the
           log a list at all: a compacted view holding the retitle and not the
           create folds to a list never created, and a newly admitted peer
           served it would hold a renamed list that does not exist. */
        return true
      case 'retitle':
        return entry === titled
      case 'place':
        return live.has(`${entry.device}:${entry.seq}`)
      case 'delete':
        return true
      default:
        return false
    }
  })
  /* A deleted list's compacted view is the deletion alone, and a list never
     created is nothing: neither has anything a new peer should hold. */
  const served = state.deleted ? kept.filter((entry) => entry.op === 'delete').slice(0, 1) : state.created ? kept : []
  return served.map((entry, i) => ({ ...entry, device, seq: i + 1 }))
}
