import { useRef } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { ListsPort } from '../lib/listsPort'
import { NewListForm } from './NewListForm'
import { useAction } from './useAction'
import { useOwnLists } from './useOwnLists'

/**
 * The reader's own lists, as they concern THIS book — WI-23.E1. On or off
 * each list; a new list started with it. The list itself — its title, its
 * order, its notes — is kept on the Circle screen, where the whole list is
 * in view.
 *
 * Its own subscription and its own action state: a list that will not take
 * the book is said here, beside the list, and the stars above stay usable.
 *
 * ⚠️ **MOUNTED PER BOOK — the pane keys it by `bookId`.** A create that lands
 * after the reader moved on lands in an instance that has gone, and must
 * not hand its id to the next book's form.
 */
export function ListMembership({ bookId, lists }: { readonly bookId: string; readonly lists: ListsPort }) {
  const { own, trouble: unread } = useOwnLists(lists)
  const { busy, trouble, run, alive } = useAction('That did not save.')
  /* A list started beside this book and not yet holding it — kept here, so
     a placement that failed is retried onto the same list. */
  const started = useRef<string | null>(null)
  /* Stryker disable next-line ConditionalExpression: the lists are only ever read through the port, so nothing is drawn until the first read lands. */
  if (own === null) return null
  return (
    <div className={CAPABILITY_UI.section} data-own-lists="">
      <p className={CAPABILITY_UI.hint}>Your lists</p>
      {unread === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read your lists. {unread}</p>}
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      {own.map((list) => {
        const on = list.items.find((item) => item.bookId === bookId)
        return (
          <div className={CAPABILITY_UI.row} key={list.id}>
            <span className={CAPABILITY_UI.grow}>{list.title}</span>
            <button
              type="button"
              className={CAPABILITY_UI.button}
              disabled={busy}
              aria-label={on ? `Take this book off ${list.title}` : `Put this book on ${list.title}`}
              onClick={() => void run(() => (on ? lists.takeOff(list.id, on.pub) : lists.place(list.id, bookId)))}
            >
              {on ? 'On it — take off' : 'Put on'}
            </button>
          </div>
        )
      })}
      <NewListForm
        busy={busy}
        placeholder="A new list, starting with this book"
        onStart={(title) =>
          run(async () => {
            const id = started.current ?? (await lists.create(title))
            /* A create that lands after the reader moved on: this instance
               has gone with its book, and the list is not filled from here. */
            if (!alive()) return
            started.current = id
            await lists.place(id, bookId)
            started.current = null
          })
        }
      />
    </div>
  )
}
