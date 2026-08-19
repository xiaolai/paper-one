import { useId, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { IndexedBook } from '../lib/bookIndex'
import {
  displayTitle,
  selectionTags,
  splitTags,
  tagKey,
  tagSuggestions,
  type TagCount,
} from '../lib/library'
import { ICON } from '../lib/metrics'
import styles from './TagEditor.module.css'

/**
 * The tags on a book — or on several — as a thing that can be edited.
 *
 * ONE EDITOR FOR ONE BOOK OR MANY, because the reader's questions are the same
 * in both cases — what is on it, what can I add, what can I take off — and two
 * surfaces answering them differently would be two things to learn. What
 * changes with the count is what a chip means: on one book it is a fact; on
 * a selection it is a fact about SOME of them until it is about all, and it
 * says how many.
 *
 * The chips are the reader's own tags with a ✕, and — for a single book — the
 * publisher's subjects without one, muted, because they are not the reader's
 * to remove and a control that would refuse is worse than none. The field
 * autocompletes over every tag on the shelf, most used first, and offers to
 * create what is not there. Enter or a comma adds and CLEARS THE FIELD BUT NOT
 * THE EDITOR: a reader who has come to lay down five tags should not have to
 * open it five times, which is the reason Finder's tag popover stays up.
 * Backspace on an empty field takes the last chip back, as every tag field a
 * reader has met does.
 *
 * Nothing is buffered. Every add and remove is written the moment it is made,
 * so closing — Escape, a click elsewhere — loses nothing and needs no Save.
 *
 * This is the BOX only. Whoever opens it decides where it goes: over a card,
 * placed by `useRowMenu`; or in a sheet, from the reader. It reads what it
 * needs from `books` and calls back with ids, so it does not care.
 */
export interface TagEditorProps {
  /** The book — or the selection — being edited. At least one. */
  readonly books: readonly IndexedBook[]
  /** Every tag on the shelf with its count, for the suggestions. */
  readonly shelfTags: readonly TagCount[]
  /** Add these tags to these books. Normalised by the store; folded there too. */
  readonly onAdd: (bookIds: readonly string[], tags: readonly string[]) => void
  /** Take this tag off these books. */
  readonly onRemove: (bookIds: readonly string[], tag: string) => void
  /** Fill whatever holds it — the reader's sheet — rather than take a popover's width. */
  readonly fill?: boolean
}

/** How many suggestions to show under the field. Enough to pick from, few
 *  enough to read at a glance; the field narrows the rest. */
const SUGGEST = 6

/**
 * One row of the listbox — a suggestion, or the create line.
 *
 * Extracted because the two carried the same six attributes of plumbing and
 * every one of them is load-bearing: `role`/`id` are what the combobox's
 * `aria-activedescendant` points at, and the prevented `pointerdown` is what
 * keeps the field focused through a click — the reader is going to type the
 * next tag straight away. Written twice, one copy loses an attribute and the
 * two rows quietly behave differently.
 */
function OptionRow({
  id,
  active,
  onActivate,
  onPick,
  data,
  children,
}: {
  readonly id: string
  readonly active: boolean
  readonly onActivate: () => void
  readonly onPick: () => void
  readonly data?: Record<`data-${string}`, unknown>
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      className={styles.suggestion}
      data-active={active}
      {...data}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onPick}
      onPointerEnter={onActivate}
    >
      {children}
    </button>
  )
}

export function TagEditor({ books, shelfTags, onAdd, onRemove, fill = false }: TagEditorProps) {
  /* PER INSTANCE, via useId — the combobox contract's ids were fixed strings,
   * on the reasoning that only one editor is ever open, and the reasoning had
   * a keyboard-shaped hole: the bulk editor and a card's editor can coexist
   * for a beat, and two listboxes under one id make `aria-activedescendant`
   * ambiguous exactly for the reader who cannot see which is which. */
  const baseId = useId()
  const listId = `${baseId}-options`
  const optionId = (i: number) => `${baseId}-option-${i}`
  const [draft, setDraft] = useState('')
  /* Which suggestion the arrows have landed on. -1 is the field itself, so
   * Enter on a typed word that matches nothing creates it rather than picking
   * something the reader did not point at. */
  const [active, setActive] = useState(-1)
  const ids = useMemo(() => books.map((book) => book.bookId), [books])
  const bulk = books.length > 1
  const one = books[0]

  /* The chips. One book: its own tags, then its subjects. Many: the union of
   * their own tags, each with how many carry it.
   *
   * The single-book list is deduplicated BY KEY like everything else that
   * renders tags — the store folds on write, but a record hand-edited or
   * migrated can carry two spellings of one tag, and unfolded they drew two
   * chips under one React key. First spelling wins, as in `allTags`. */
  const own = useMemo(() => {
    if (bulk) return selectionTags(books)
    const seen = new Set<string>()
    const out: { tag: string; count: number }[] = []
    for (const tag of one?.tags ?? []) {
      const key = tagKey(tag)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ tag, count: 1 })
    }
    return out
  }, [books, bulk, one])
  const subjects = useMemo(() => {
    if (bulk || !one) return []
    const ownKeys = new Set((one.tags ?? []).map(tagKey))
    const seen = new Set<string>()
    const out: string[] = []
    for (const subject of one.subjects ?? []) {
      const key = tagKey(subject)
      if (!key || ownKeys.has(key) || seen.has(key)) continue
      seen.add(key)
      out.push(subject)
    }
    return out
  }, [bulk, one])

  /* What is already carried, so it is not offered again. On one book that is
   * everything on it, whoever put it there. On a selection it is only what
   * EVERY book carries — a tag on some of them is exactly what the reader may
   * want to put on the rest, and it stays offered. */
  const already = useMemo(() => {
    const keys = new Set<string>()
    if (bulk) {
      for (const row of own) if (row.count === books.length) keys.add(tagKey(row.tag))
    } else {
      for (const row of own) keys.add(tagKey(row.tag))
      for (const subject of subjects) keys.add(tagKey(subject))
    }
    return keys
  }, [bulk, own, subjects, books.length])

  const { rows: suggested, exact } = useMemo(
    () => tagSuggestions(shelfTags, draft, already, SUGGEST),
    [shelfTags, draft, already],
  )
  /* "Create" is offered when what was typed is a tag nobody has — not when it
   * names one already on the shelf (that is a pick, and it is in the list),
   * and not when it names one already on the book (nothing to do). The comma
   * case is several tags at once; it is offered as a whole line, since
   * splitting it into per-tag rows would be a list of things to click one at
   * a time, which is what the comma exists to avoid. */
  const typed = splitTags(draft)
  /* Typing the name of a subject the book already carries is the one way to
   * make it the reader's own from here — a different thing from "already on
   * the book", and offered in those words. */
  /* The SUBJECT'S spelling when adopting, not what was typed: `history` typed
   * against a publisher's `History` becomes the reader's `History`, so the
   * one chip does not change case the moment it changes hands. EVERY typed
   * piece resolves this way, not only a lone one — `fiction, history` used to
   * adopt neither and store the typed casing beside the subjects'. */
  const canonical = (tag: string): string =>
    subjects.find((subject) => tagKey(subject) === tagKey(tag)) ?? tag
  const adopted =
    !bulk && typed.length === 1
      ? subjects.find((subject) => tagKey(subject) === tagKey(typed[0]!))
      : undefined
  const adopts = adopted !== undefined
  const creates =
    typed.length > 1
      ? typed.map(canonical)
      : adopts
        ? [adopted]
        : typed.length === 1 && !exact && !already.has(tagKey(typed[0]!))
          ? typed
          : []
  /* The rows the arrows walk: the suggestions, then the create line if any. */
  const choices = suggested.length + (creates.length ? 1 : 0)

  const add = (tags: readonly string[]) => {
    if (tags.length === 0) return
    onAdd(ids, tags.map(canonical))
    setDraft('')
    setActive(-1)
  }

  const commit = () => {
    if (active >= 0 && active < suggested.length) {
      add([suggested[active]!.tag])
      return
    }
    if (active === suggested.length && creates.length) {
      add(creates)
      return
    }
    // Enter with nothing pointed at: whatever was typed, split on commas.
    add(typed)
  }

  /* NO BOOKS, NO EDITOR — said in code, not only in the prop's comment. An
   * empty selection reaching here rendered a working-looking editor whose
   * every action wrote to nobody, which is a form that swallows input. */
  if (!one) return null

  const heading = bulk ? `Tags for ${books.length} books` : `Tags for ${displayTitle(one)}`

  return (
    <div className={styles.editor} data-fill={fill} role="group" aria-label={heading}>
      <div className={styles.heading}>{heading}</div>

      {(own.length > 0 || subjects.length > 0) && (
        <div className={styles.chips}>
          {own.map(({ tag, count }) => {
            const partial = bulk && count < books.length
            return (
              <span
                key={tagKey(tag)}
                className={styles.chip}
                data-mine="true"
                data-partial={partial}
              >
                {/* On a selection, a chip carried by SOME is one click from
                    being carried by all — the number says what the click will
                    reach, so the reader knows before doing it. On one book the
                    label is a label. */}
                {partial ? (
                  <button
                    type="button"
                    className={styles.chipFill}
                    title={`On ${count} of ${books.length} — click to put it on all`}
                    onClick={() => add([tag])}
                  >
                    {tag}
                    <span className={styles.chipCount}>
                      {count}/{books.length}
                    </span>
                  </button>
                ) : (
                  <span className={styles.chipLabel}>{tag}</span>
                )}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={bulk ? `Remove ${tag} from all ${books.length}` : `Remove ${tag}`}
                  title={bulk ? `Remove from all ${books.length}` : 'Remove'}
                  onClick={() => onRemove(ids, tag)}
                >
                  <X size={ICON.control} strokeWidth={ICON.stroke} />
                </button>
              </span>
            )
          })}
          {subjects.map((subject) => (
            <span
              key={tagKey(subject)}
              className={styles.chip}
              data-mine="false"
              /* Says whose it is, since it looks different and the reader is
                 owed the reason. Not removable: it is a fact about the book,
                 comes back on the next parse, and offering a ✕ that refuses
                 would teach nothing. */
              title="From the publisher — add it as your own to make it yours"
            >
              <span className={styles.chipLabel}>{subject}</span>
            </span>
          ))}
        </div>
      )}

      <input
        className={styles.field}
        value={draft}
        placeholder={bulk ? `Add a tag to all ${books.length}…` : 'Add a tag…'}
        aria-label={bulk ? `Add a tag to ${books.length} books` : 'Add a tag'}
        /* THE COMBOBOX CONTRACT, so a screen reader hears what the pointer
           sees: the field owns a list, the list is open, and this row of it is
           the one the arrows are on. Without these the suggestions were a
           silent sibling — announced never, navigated blind. */
        role="combobox"
        aria-expanded={choices > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-autocomplete="list"
        /* NO maxLength. There was a `TAG_MAX * 4`, and an aggregate cap on a
           field that takes `a, b, c` is wrong in both directions: it lets one
           tag run far past what the store keeps and cuts off a legitimate
           pasted list of five. `splitTags` already cuts EACH tag to `TAG_MAX`,
           which is the only limit that is real. */
        autoFocus
        onChange={(event) => {
          const value = event.target.value
          setDraft(value)
          /* The first suggestion is pointed at as soon as there is text to
             match, so Enter picks the best match — which is what a reader
             typing `Se` and pressing Enter means. With nothing typed the field
             points at itself, so Enter does nothing. And with a tag the book
             ALREADY carries typed out in full, likewise — row 0 would be some
             other tag, and Enter on a finished name must not add a neighbour
             the reader did not type. */
          const pieces = splitTags(value)
          const alreadyTyped =
            pieces.length === 1 && already.has(tagKey(pieces[0]!)) && !subjects.some((s) => tagKey(s) === tagKey(pieces[0]!))
          setActive(value.trim() && !alreadyTyped ? 0 : -1)
        }}
        onKeyDown={(event) => {
          /* MID-COMPOSITION, EVERY KEY IS THE IME'S. Enter confirms the
             candidate and comma can be the reader picking one — committing on
             either writes half-composed text as a tag. */
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === ',' ) {
            /* A comma COMMITS what is before it, the way a tag field does,
               unless there is nothing yet — a leading comma is a typo. */
            if (typed.length) {
              event.preventDefault()
              add(typed)
            }
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActive((at) => (choices ? Math.min(choices - 1, at + 1) : -1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((at) => Math.max(-1, at - 1))
          } else if (event.key === 'Backspace' && !draft && !bulk && own.length) {
            /* Only on one book. On a selection a Backspace that stripped a
               tag from forty books would be a large thing to do by accident,
               and the ✕ is right there. */
            event.preventDefault()
            onRemove(ids, own[own.length - 1]!.tag)
          }
        }}
      />

      {choices > 0 && (
        <div id={listId} className={styles.suggestions} role="listbox" aria-label="Tags to add">
          {suggested.map((row, i) => (
            <OptionRow
              key={tagKey(row.tag)}
              id={optionId(i)}
              active={active === i}
              onActivate={() => setActive(i)}
              onPick={() => add([row.tag])}
              data={{ 'data-mine': row.mine }}
            >
              <span className={styles.suggestionLabel}>{row.tag}</span>
              {/* Whose it is, quietly: a subject is offered too, since
                  adopting one is a legitimate thing to type, but it should not
                  read as part of the reader's own vocabulary. */}
              {!row.mine && <span className={styles.suggestionKind}>subject</span>}
              <span className={styles.suggestionCount}>{row.count}</span>
            </OptionRow>
          ))}
          {creates.length > 0 && (
            <OptionRow
              id={optionId(suggested.length)}
              active={active === suggested.length}
              onActivate={() => setActive(suggested.length)}
              onPick={() => add(creates)}
              data={{ 'data-create': 'true' }}
            >
              <Plus size={ICON.control} strokeWidth={ICON.stroke} />
              <span className={styles.suggestionLabel}>
                {creates.length > 1
                  ? `Add ${creates.length} tags: ${creates.join(', ')}`
                  : adopts
                    ? `Keep “${creates[0]}” as your own tag`
                    : `Create “${creates[0]}”`}
              </span>
            </OptionRow>
          )}
        </div>
      )}
    </div>
  )
}
