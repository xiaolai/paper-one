import { useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { ListsPort, OwnListView } from '../lib/listsPort'
import { NewListForm } from './NewListForm'
import { useAction } from './useAction'
import { useOwnLists } from './useOwnLists'

/**
 * The reader's own lists — WI-23.E1: title, order, notes, and the end of a
 * list. Which books are on one is decided beside the book (`BookPane`).
 * Each list is a row with action state of its own: a note that would not
 * save on one list does not hold the rename on another, and is said beside
 * the list it was about.
 *
 * ⚠️ **DELETING IS FOR GOOD, AND THE COPY SAYS SO.** A `delete` is a tombstone
 * on the log; a list that comes back is a new list under a new id, and a
 * friend who held the old one keeps nothing of it.
 */
export function OwnLists({ lists, openBook }: { readonly lists: ListsPort; readonly openBook?: (bookId: string) => void }) {
  const { own, trouble: unread } = useOwnLists(lists)
  /* Starting a list — the section's own act, apart from any row's. */
  const { busy, trouble, run } = useAction('That did not go through.')
  if (own === null) return null
  return (
    <div className={CAPABILITY_UI.section} data-own-lists="">
      <p className={CAPABILITY_UI.hint}>Your lists</p>
      {unread === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read your lists. {unread}</p>}
      {own.length === 0 && unread === null ? <p className={CAPABILITY_UI.hint}>No lists yet. Start one beside a book, or here.</p> : null}
      {own.map((list) => (
        <OwnListRow key={list.id} list={list} lists={lists} {...(openBook ? { openBook } : {})} />
      ))}
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      <NewListForm busy={busy} placeholder="A new list" onStart={(title) => run(() => lists.create(title))} />
      <p className={CAPABILITY_UI.hint}>A list is shown to the people you show your shelf to. Deleting one is for good.</p>
    </div>
  )
}

function OwnListRow({ list, lists, openBook }: { readonly list: OwnListView; readonly lists: ListsPort; readonly openBook?: (bookId: string) => void }) {
  const [title, setTitle] = useState<string | null>(null)
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const { busy, trouble, run } = useAction('That did not go through.')
  const shown = title ?? list.title
  return (
    <div className={CAPABILITY_UI.section} data-own-list={list.id}>
      <div className={CAPABILITY_UI.row}>
        <input
          type="text"
          className={CAPABILITY_UI.field}
          aria-label={`Title of ${list.title}`}
          value={shown}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
        {title !== null && title.trim() !== '' && title.trim() !== list.title ? (
          <button
            type="button"
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await lists.retitle(list.id, title.trim())
                setTitle(null)
              })
            }
          >
            Rename
          </button>
        ) : null}
        <button type="button" className={CAPABILITY_UI.button} disabled={busy} aria-label={`Delete ${list.title}`} onClick={() => void run(() => lists.delete(list.id))}>
          Delete
        </button>
      </div>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      {list.items.length === 0 ? <p className={CAPABILITY_UI.hint}>Nothing on it yet.</p> : null}
      {list.items.map((item) => {
        const note = notes[item.pub] ?? item.note
        /* A book no longer on the shelf cannot be re-placed, so its note is
           read-only — and a note that cannot change cannot differ. */
        const editable = item.bookId !== null
        // Stryker disable next-line ConditionalExpression,LogicalOperator: the field is disabled when not editable, so a changed note is always an editable one.
        const canKeep = editable && notes[item.pub] !== undefined && notes[item.pub] !== item.note
        return (
          <div className={CAPABILITY_UI.row} key={item.pub} data-list-item={item.pub}>
            <span className={CAPABILITY_UI.grow}>
              {item.title}
              {item.author ? ` — ${item.author}` : ''}
            </span>
            <input
              type="text"
              className={CAPABILITY_UI.field}
              aria-label={`Note on ${item.title}`}
              placeholder="A note"
              value={note}
              disabled={busy || !editable}
              onChange={(e) => setNotes({ ...notes, [item.pub]: e.target.value })}
            />
            {canKeep ? (
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                aria-label={`Keep note on ${item.title}`}
                onClick={() =>
                  void run(async () => {
                    await lists.place(list.id, item.bookId!, notes[item.pub])
                    setNotes(({ [item.pub]: _kept, ...rest }) => rest)
                  })
                }
              >
                Keep note
              </button>
            ) : null}
            {editable && openBook ? (
              <button type="button" className={CAPABILITY_UI.button} onClick={() => openBook(item.bookId!)} aria-label={`Open your copy of ${item.title}`}>
                Open
              </button>
            ) : null}
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} aria-label={`Take ${item.title} off ${list.title}`} onClick={() => void run(() => lists.takeOff(list.id, item.pub))}>
              Take off
            </button>
          </div>
        )
      })}
    </div>
  )
}
