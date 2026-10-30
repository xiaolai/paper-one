import { matchWork, type Hlc } from '../../../kernel'
import { claimOfShelved } from './circleView'
import { bookVia, claimOf, indexOf, type BookLike } from './exchange'
import { createList, deleteList, placeOnList, removeFromList, retitleList, stateOf, type ListFile, MAX_LIST_NOTE, MAX_LIST_TITLE } from './lists'
import { workOf, type ShelvedBook } from './shelf'
import { createListeners } from './listeners'
import { MAX_LISTS_PER_REQUEST } from './protocol'

/**
 * The reader's own lists, as the surfaces use them — WI-23.E1.
 *
 * PURE over its deps, like `opinionPort.ts`: the screen is the hardest thing
 * to reach from a test, so the deciding is here. Every act appends a row to
 * the list's file (`lists.ts`) under this device's next sequence and the
 * kernel clock's stamp, and the file is what `circle.lists` serves — so a
 * list changed here reaches a friend the switch is on for at the next
 * cadence, with no second store.
 *
 * ⚠️ **NOTHING IS WRITTEN WITHOUT AN IDENTITY.** A row carries the device
 * that wrote it and is served under a delegation that names it; a device with
 * no person has neither, and a list it kept could never be served. The acts
 * refuse with the sentence the share control uses for the same case.
 *
 * Writes are serialised on one chain, for the opinion driver's reason: two
 * acts racing on one file would interleave their sequence numbers.
 */

export interface OwnListItem {
  readonly pub: string
  readonly title: string
  readonly author: string
  readonly position: number
  readonly note: string
  /** The reader's copy, by id — the work placed was one of theirs, but it may have left the shelf since. */
  readonly bookId: string | null
}

export interface OwnListView {
  readonly id: string
  readonly title: string
  /** In the position rule's order. */
  readonly items: readonly OwnListItem[]
}

export interface ListsPort {
  /** Every list that exists and is not deleted, by title. */
  lists(): Promise<readonly OwnListView[]>
  /** Make a list; the new id. */
  create(title: string): Promise<string>
  retitle(listId: string, title: string): Promise<void>
  /**
   * Place one of the reader's books on a list, at the end — or, for a book
   * already on it, keep its place and rewrite its note.
   */
  place(listId: string, bookId: string, note?: string): Promise<void>
  /** Take an item off a list — a tombstone on its `pub`, for good. */
  takeOff(listId: string, pub: string): Promise<void>
  delete(listId: string): Promise<void>
  /** Told after every act. */
  subscribe(listener: () => void): () => void
}

/** A book as the library holds it, narrowed to what a list names. */
export type ListableBook = ShelvedBook

export interface ListsDeps {
  readonly ids: () => Promise<readonly string[]>
  readonly read: (listId: string) => Promise<ListFile>
  /** Change one list as one step on its lane — `updateOwnList`; see `SharingDeps.update`. */
  readonly update: (listId: string, transform: (held: ListFile) => ListFile) => Promise<ListFile>
  readonly books: () => readonly ListableBook[]
  /** This device's id when it has a person identity, else null. */
  readonly device: () => Promise<string | null>
  readonly clock: () => Hlc
  readonly mintPub: () => string
}

/** What an act says when there is nobody to write as. */
export const NO_IDENTITY = 'Start a circle to keep a list.'

/** What an act on a list that is not there says. */
export const NO_SUCH_LIST = 'That list is not there any more.'

/** What making one list too many says. */
export const TOO_MANY_LISTS = `A circle carries at most ${MAX_LISTS_PER_REQUEST} lists.`

/**
 * A list an act may change: created, and not deleted. A row appended to a
 * list that was never made, or is gone, is a row nobody will ever see —
 * refused rather than written.
 */
function alive(held: ListFile, listId: string): ListFile {
  const state = stateOf(held)
  if (!state.created || state.deleted) throw new Error(`${NO_SUCH_LIST} (${listId})`)
  return held
}

const bookLike = (book: ListableBook): BookLike => {
  const { bookId, title, author, identifier, languages } = book
  /* Stryker disable all: `claimFor` reads an explicit `undefined` as absence; the spreads keep the type honest, not the answer. */
  return {
    id: bookId,
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(languages === undefined ? {} : { languages }),
  }
  // Stryker restore all
}

/** A title within the bound the file reads back — refused, not cut: it is the reader's own word. */
function titled(title: string): string {
  if (title.length > MAX_LIST_TITLE) throw new Error(`a list title is at most ${MAX_LIST_TITLE} characters`)
  return title
}

export function listsPortOver(deps: ListsDeps): ListsPort & { dispose(): void } {
  const listeners = createListeners('list')
  const changed = (): void => listeners.tell()
  let chain: Promise<unknown> = Promise.resolve()
  /** Run one act after every act before it, and tell the listeners. */
  const act = <T>(work: (by: { device: string; at: Hlc }) => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const device = await deps.device()
      if (device === null) throw new Error(NO_IDENTITY)
      const result = await work({ device, at: deps.clock() })
      changed()
      return result
    })
    chain = next.catch(() => undefined)
    return next
  }

  /* The same `BookLike[]` for the same shelf snapshot, so `indexOf` finds its
     index built: a fresh array per read was a fresh index per read. */
  let projected: { readonly from: ReturnType<typeof deps.books>; readonly books: readonly BookLike[] } | null = null
  const bookLikes = (): readonly BookLike[] => {
    const from = deps.books()
    if (projected === null || projected.from !== from) projected = { from, books: from.map(bookLike) }
    return projected.books
  }

  return {
    lists: async () => {
      const index = indexOf(bookLikes())
      const views: OwnListView[] = []
      for (const id of await deps.ids()) {
        const state = stateOf(await deps.read(id))
        if (!state.created || state.deleted) continue
        views.push({
          id,
          title: state.title,
          items: state.items.map((item) => ({
            pub: item.pub,
            title: item.work.title,
            author: item.work.author,
            position: item.position,
            note: item.note,
            bookId: bookVia(index, claimOfShelved(item.work))?.id ?? null,
          })),
        })
      }
      return views.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    },
    create: (title) =>
      act(async (by) => {
        /* ⚠️ **HELD TO THE BOUND A FRIEND'S REQUEST CAN NAME.** A lists
           request carries one cursor per list, and the parser refuses one
           naming more than `MAX_LISTS_PER_REQUEST`; a sixty-fifth list made
           every request for this reader's lists invalid, and their lists
           stopped reaching anybody. Deleted lists count: their ids are still
           files a friend holds a cursor for. Refused, not silently capped —
           it is the reader's own act. */
        const ids = await deps.ids()
        if (ids.length >= MAX_LISTS_PER_REQUEST) throw new Error(TOO_MANY_LISTS)
        const id = deps.mintPub()
        await deps.update(id, (held) => createList(held, titled(title), by))
        return id
      }),
    retitle: (listId, title) =>
      act(async (by) => {
        await deps.update(listId, (held) => retitleList(alive(held, listId), titled(title), by))
      }),
    place: (listId, bookId, note = '') =>
      act(async (by) => {
        if (note.length > MAX_LIST_NOTE) throw new Error(`a note on a list is at most ${MAX_LIST_NOTE} characters`)
        const book = deps.books().find((one) => one.bookId === bookId)
        if (book === undefined) throw new Error('that book is not on the shelf')
        /* ⚠️ **ONE CUT FOR THE WORK AND THE CLAIM.** `workOf` holds the fields
           to their bound and `claimOf` hashes the same cut fields, so the
           claim a duplicate is looked for by, the work the item carries and
           the claim it is linked back by are made from one string. Cut on
           the item alone, a long title was placed under the whole title's
           claim and linked by the cut one's: an item that read as a book the
           reader did not have, and a second placement a duplicate. */
        const work = workOf(book)
        const claim = claimOf(bookLike(book))
        const pub = deps.mintPub()
        await deps.update(listId, (held) => {
          const state = stateOf(alive(held, listId))
          const already = state.items.find((item) => matchWork(claim, claimOfShelved(item.work)) !== 'none')
          const last = state.items.at(-1)?.position ?? 0
          /* Only a NEW item takes a position; a note on an item already placed keeps its own. */
          if (already === undefined && last >= Number.MAX_SAFE_INTEGER) throw new Error('this list has no room for another position')
          const placed =
            already === undefined
              ? { pub, work, position: last + 1, note }
              : { pub: already.pub, work: already.work, position: already.position, note }
          return placeOnList(held, placed, by)
        })
      }),
    takeOff: (listId, pub) =>
      act(async (by) => {
        await deps.update(listId, (held) => removeFromList(alive(held, listId), pub, by))
      }),
    delete: (listId) =>
      act(async (by) => {
        await deps.update(listId, (held) => deleteList(alive(held, listId), by))
      }),
    subscribe: listeners.subscribe,
    dispose: () => {
      listeners.clear()
    },
  }
}
