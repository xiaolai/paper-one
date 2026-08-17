import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WriteQueue } from './writeQueue'
import { folderOf, marksPathIn, readMarks, trashOf, writeMarks } from './bookFolder'
import { scanAllMarks, type IndexFs } from './bookIndex'
import { upsertOverlapping } from './markMatch'
import {
  createMark,
  parseMarks,
  removeMark as removeFrom,
  updateNote as updateNoteIn,
  type Mark,
  type NewMark,
} from './marks'

/**
 * The annotation store, bound to React.
 *
 * All the rules live in `marks.ts`; this holds the state, persists after every
 * change, and narrows the whole collection to the open book. Writing on every
 * change rather than on an interval or on unload is deliberate: a reader who
 * highlights a line and then force-quits should still have the highlight, and
 * the payload is small enough that debouncing would buy nothing.
 */

/** One shared empty list, so a book with no marks does not re-render on identity. */
const EMPTY: readonly Mark[] = []

export interface MarkStore {
  /** Every mark, across every book — what the Notes panel browses. Empty
   *  until `loadAll` has run, because it costs a read per book. */
  readonly all: readonly Mark[]
  /** The open book's marks, in book order. */
  readonly current: readonly Mark[]
  /**
   * False once a write has failed. Surfaced rather than swallowed so the
   * reader can be told their marks are not being saved; a store that silently
   * stops persisting is indistinguishable from one that works.
   */
  readonly persistent: boolean
  add: (draft: NewMark) => Mark
  remove: (id: string) => void
  setNote: (id: string, note: string) => void
  /**
   * Move every row from a superseded book id onto the current one.
   *
   * A no-op unless the reader has rows written under the previous identity
   * scheme — see `idMigration`. Called on open rather than at load, because the
   * old id can only be recomputed from the file itself.
   */
  rekey: (from: string, to: string) => void
  /**
   * Read every book's marks into `all`.
   *
   * Called by the Notes pane when it mounts. Marks live in book folders, so
   * answering "every book's marks" costs one read per book — paid at the moment
   * somebody asks for cross-book notes rather than at boot, where nobody did.
   */
  loadAll: () => void
}

export function useMarks(
  bookId: string | null,
  fs: IndexFs | null,
  shared: WriteQueue,
): MarkStore {
  /* THE OPEN BOOK'S MARKS ONLY, held here.
   *
   * They live in that book's folder, so there is nothing to load until a book is
   * open and nothing to filter once one is — `current` used to be
   * `marksForBook(everything)`, which is what a shared store forces.
   *
   * Loaded asynchronously, which is safe because marks are DRAWN after a section
   * loads: the overlay is built on the `load` event and reads the marks then, so
   * a read that resolves a few frames into the open is indistinguishable from
   * one that resolved before it. */
  /* HELD WITH THEIR BOOK, not beside it.
   *
   * A bare list kept the previous book's marks until the new book's read
   * resolved — so the reader could be shown, and the overlay could DRAW,
   * another book's highlights. Pairing them means a mismatch is simply an empty
   * list, and a read that resolves after the reader has moved on is discarded
   * because its id no longer matches. */
  const [loaded, setLoaded] = useState<{ bookId: string | null; marks: readonly Mark[] }>({
    bookId: null,
    marks: [],
  })
  const current = loaded.bookId === bookId ? loaded.marks : EMPTY
  const [persistent, setPersistent] = useState(true)
  const [all, setAll] = useState<readonly Mark[]>([])
  /**
   * Whether the cross-book scan has RUN, which emptiness cannot tell you.
   *
   * `all.length === 0` was standing in for "not loaded yet", and it is also what
   * a reader with no marks has — so opening Notes on a fresh library and making
   * the first highlight left `all` untouched, and the pane went on saying
   * "Nothing marked yet" about the mark that was on screen behind it.
   */
  const scanned = useRef(false)

  const latest = useRef<readonly Mark[]>(current)
  latest.current = current

  /* One write at a time per book — see `writeQueue`. Every write goes to the
   * same `marks.json.writing` neighbour, so a reader highlighting three
   * passages in a second had three writes racing for one temporary file. */
  /* THE SHELF'S QUEUE, not one of its own.
   *
   * A book is a folder, and its record and its marks are two files in it. Two
   * queues meant a write to one could not see a write to the other — which is
   * how a mark landed in a folder a removal had just moved, and how the checks
   * that catch that had to be written twice. One queue keyed by book makes every
   * write touching a book genuinely serial, and gives the window something to
   * wait for when it closes. */
  const queue = useRef(shared)
  queue.current = shared

  /** Which book is open, for tasks that finish after a render. */
  const openRef = useRef(bookId)
  openRef.current = bookId

  /** Whether a write has failed since the last successful load — see below. */
  const failed = useRef(false)

  useEffect(() => {
    if (!bookId || !fs) {
      setLoaded({ bookId: null, marks: [] })
      return
    }
    let live = true
    failed.current = false
    /* THE READ GOES ON THE QUEUE TOO, which is the point rather than a detail.
     * A highlight made before this lands is written as a change and reaches the
     * file first; an unqueued read then returned the file as it was BEFORE that
     * change and installed it as the open book's list, so the next highlight
     * wrote a snapshot without the first one in it. Ordering the read against
     * the writes is what makes the answer it gets the current answer. */
    void queue.current
      .append(bookId, async () => {
        const raw = await readMarks(fs, bookId)
        // Parsed through the same validator the shared store used: this is a
        // file on disk, and a mark with no CFI cannot be drawn.
        if (live) setLoaded({ bookId, marks: parseMarks(JSON.stringify(raw)) })
      })
      .catch(() => {
        if (live) setLoaded({ bookId, marks: [] })
      })
    return () => {
      live = false
    }
  }, [bookId, fs])

  /**
   * Change this book's marks: the screen at once, the file as a change.
   *
   * ONE PATH, and the reason is the bug that had two. A snapshot write captures
   * the list at the moment the reader highlights something, and anything else
   * still in flight for that book is not in it — highlight A while the file is
   * being read, highlight B before A's write lands, and B persists a list
   * without A in it. Every version of this that wrote a captured list had some
   * version of that hole in it.
   *
   * So the CHANGE goes to disk, not the result: read, modify, write, in order,
   * on the book's queue. `mutate` is applied to what is actually in the file at
   * the moment it is written. The optimistic update below is for the screen
   * only, and is corrected by whatever the write finds.
   */
  const apply = useCallback(
    (mutate: (prev: readonly Mark[]) => readonly Mark[]) => {
      if (!bookId) return
      /* The screen first, and only when the file has been read — before that,
       * `latest` is not this book's list and predicting from it would show marks
       * appearing and vanishing. The write below still lands either way. */
      if (loaded.bookId === bookId) {
        const next = mutate(latest.current)
        if (next !== latest.current) {
          latest.current = next
          setLoaded({ bookId, marks: next })
          /* `all` kept in step, so a Notes row does not revert to the old value
           * the moment it is edited. It only holds what a scan put there, so a
           * book the scan never reached is left alone rather than half-updated. */
          /* Only once the scan has run: `all` holds what that scan put there,
           * so a book it never reached must be left alone rather than
           * half-updated. Before it has run there is nothing to keep in step. */
          setAll((prev) =>
            scanned.current ? [...next, ...prev.filter((mark) => mark.bookId !== bookId)] : prev,
          )
        }
      }
      applyElsewhereRef.current?.(bookId, mutate)
    },
    [bookId, loaded.bookId],
  )

  /**
   * Read every book's marks, for the Notes pane.
   *
   * Called by Notes when it mounts, which is the moment somebody asked for
   * cross-book notes — and Notes only mounts when its pane is open, so a reader
   * who never opens it never pays for the scan.
   */
  const loadAll = useCallback(() => {
    if (!fs) return
    void scanAllMarks(fs)
      .then((raw) => {
        scanned.current = true
        setAll(parseMarks(JSON.stringify(raw)))
      })
      .catch(() => {
        // NOT marked scanned: a failed scan has not established that there is
        // nothing, and treating it as though it had is how an empty pane
        // becomes permanent.
        setAll([])
      })
  }, [fs])

  /**
   * Write a change to one book's marks file — the only thing that writes one.
   *
   * Named for the case it was added for, which is a mark belonging to a book
   * that is NOT open.
   *
   * Notes lists every book's marks, so a reader can edit or delete one from a
   * book they are not reading — and every mutation here acted on the open
   * book's list, so those were silent no-ops: the row appeared to change and
   * reverted on the next render.
   *
   * Reads that book's file, changes it, writes it back, on the same per-book
   * queue as everything else. `all` is updated so the row stays changed; the
   * open book's list is untouched, because by definition this is not it.
   */
  /* `apply` needs `applyElsewhere` and `applyElsewhere` does not need `apply`,
   * but the one that is declared first cannot name the other. A ref rather than
   * a reorder, because the reading order — the open book first, then everything
   * else — is the one that explains the file. */
  const applyElsewhereRef = useRef<((id: string, mutate: (prev: readonly Mark[]) => readonly Mark[]) => void) | null>(null)

  const applyElsewhere = useCallback(
    (targetId: string, mutate: (prev: readonly Mark[]) => readonly Mark[]) => {
      if (!fs) {
        /* SAID OUT LOUD. With nowhere to write, a mark is drawn and gone at the
         * next redraw — and a store that silently stops persisting is
         * indistinguishable from one that works, which is the whole reason this
         * flag exists. */
        setPersistent(false)
        return
      }
      void queue.current
        /* APPEND. Unlike the open book's writes, which persist the whole list
         * and so make their predecessors redundant, this one READS the file and
         * changes part of it. Coalescing two — delete a mark, then recolour
         * another — drops the first, and the row it belonged to reappears. */
        .append(targetId, async () => {
          /* `writeMarks` creates the folder it writes into, so a change landing
           * after a removal puts a marks-only directory back where the book had
           * been. Checked before — and, because a removal can land between the
           * check and the write, checked AFTER as well: the trash entry the
           * removal leaves is the evidence, exactly as `updateBook` uses it. */
          if (!(await fs.exists(folderOf(targetId)))) return
          const trashedBefore = await fs.exists(trashOf(targetId))
          const before = parseMarks(JSON.stringify(await readMarks(fs, targetId)))
          const next = mutate(before)
          if (next === before) return
          await writeMarks(fs, targetId, next)
          if (!trashedBefore && (await fs.exists(trashOf(targetId)))) {
            /* The removal won. What was just written is a fragment of this
             * book's marks in a folder that is no longer the book — and leaving
             * it there is worse than losing the edit, because a later re-add
             * lets that fragment beat the complete list waiting in the trash. */
            await fs.remove(marksPathIn(targetId)).catch(() => {})
            return
          }
          setAll((prev) => [...next, ...prev.filter((mark) => mark.bookId !== targetId)])
          /* AND THE OPEN BOOK'S OWN LIST, when this is that book. It is, every
           * time `apply` routes here because the file has not been read yet —
           * and leaving the list behind meant the mark just made was missing
           * from it, so the NEXT mark wrote a snapshot that erased the first.
           * The path added to stop a mark being lost was losing one. */
          if (openRef.current === targetId) {
            latest.current = next
            setLoaded({ bookId: targetId, marks: next })
          }
          /* NOT AFTER A FAILURE, until the book is read again. A write that
           * fails is an edit that is gone: the next one is computed from the
           * file WITHOUT it, so reporting "saving" again on that success hides
           * the loss behind the very thing that caused it. The load effect is
           * what clears this, because that is the point at which what is on
           * screen agrees with what is on disk. */
          if (!failed.current) setPersistent(true)
        })
        .catch((cause: unknown) => {
          console.error('Paper: could not save that book\'s marks', cause)
          failed.current = true
          setPersistent(false)
        })
    },
    [fs],
  )

  applyElsewhereRef.current = applyElsewhere

  /**
   * Route a change to whichever book the mark belongs to.
   *
   * NOT CONDITIONAL ON A BOOK BEING OPEN. Notes lists every book's marks and is
   * reachable with no book open at all — and `!bookId` returned early, so in
   * exactly that state every edit and every delete was a silent no-op: the row
   * changed on screen and came back on the next render.
   */
  const applyToMark = useCallback(
    (id: string, mutate: (prev: readonly Mark[]) => readonly Mark[]) => {
      // The open book's own list first, which is the only one held in memory.
      if (latest.current.some((mark) => mark.id === id)) {
        apply(mutate)
        return
      }
      /* Otherwise the owner comes from `all`, whether or not anything is open
       * and whether or not it is the open book — a mark can be in `all` and not
       * yet in `current`, because the two are read separately. */
      const owner = all.find((mark) => mark.id === id)?.bookId
      if (owner) applyElsewhere(owner, mutate)
    },
    [apply, all, bookId, applyElsewhere],
  )

  const add = useCallback(
    (draft: NewMark) => {
      const mark = createMark(draft)
      /* Overlapping, not byte-identical. A mark is reached by any selection
       * that covers part of it, so the row a new mark replaces is the row that
       * selection resolved to — otherwise re-marking a passage the reader was
       * just told is marked writes a second, overlapping row. */
      apply((prev) => upsertOverlapping(prev, mark))
      return mark
    },
    [apply],
  )

  const remove = useCallback(
    (id: string) => applyToMark(id, (prev) => removeFrom(prev, id)),
    [applyToMark],
  )

  const setNote = useCallback(
    (id: string, note: string) => applyToMark(id, (prev) => updateNoteIn(prev, id, note)),
    [applyToMark],
  )

  /**
   * Carry marks written under a superseded book id onto this one.
   *
   * With marks in book folders this MOVES a file rather than rewriting rows: the
   * old id named a different folder, so its marks are read from there and merged
   * into this book's. A no-op unless the reader has marks under the previous
   * identity scheme — see `idMigration`.
   */
  const rekey = useCallback(
    (from: string, to: string) => {
      if (!fs || from === to) return
      void (async () => {
        /* TWO PLACES, because the library may have got here first.
         *
         * `rekeyBook` renames the whole folder, `marks.json` included — so by
         * the time this runs the marks are usually already in the new book's
         * file, with the OLD id still written inside every one of them. Reading
         * only the old folder therefore found nothing and did nothing, and Notes
         * then sorted the reader's own highlights under a book that no longer
         * existed and refused to navigate to them.
         *
         * So: rewrite what is already here, AND merge anything still sitting in
         * the old folder if the rename has not happened. Whichever order the two
         * ran in, the answer is the same. */
        let waiting: Mark[] = []
        try {
          waiting = parseMarks(JSON.stringify(await readMarks(fs, from)))
        } catch (cause) {
          // The old file is there and will not read. Left alone, and said out
          // loud, rather than quietly treated as a book with no marks.
          console.error('Paper: could not read the marks under the old book id', cause)
        }
        apply((prev) => {
          let rewrote = false
          const mine = prev.map((mark) => {
            if (mark.bookId !== from) return mark
            rewrote = true
            return { ...mark, bookId: to }
          })
          /* BY ID, and the set grows as it goes — a file holding two marks with
           * one id would otherwise let both through. Nothing is deleted from the
           * old folder: this ran on every open and only ever copied, so before
           * the deduplication a reader who opened a migrated book five times had
           * five of every highlight. Removing the source after `apply`, which
           * only QUEUES the write, would delete the original before the copy was
           * durable — so it stays, and the duplicate is what is prevented. */
          const held = new Set(mine.map((mark) => mark.id))
          const fresh: Mark[] = []
          for (const mark of waiting) {
            if (held.has(mark.id)) continue
            held.add(mark.id)
            fresh.push({ ...mark, bookId: to })
          }
          if (!rewrote && fresh.length === 0) return prev
          return [...mine, ...fresh]
        })
      })()
    },
    [fs, apply],
  )

  return useMemo<MarkStore>(
    () => ({ all, current, persistent, add, remove, setNote, rekey, loadAll }),
    [all, current, persistent, add, remove, setNote, rekey, loadAll],
  )
}
