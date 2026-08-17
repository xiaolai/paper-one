import { useEffect, useRef, useState } from 'react'
import { IMPORTABLE, MAX_DEPTH, MAX_FILES } from './importFolder'

/**
 * Books dropped anywhere on the window.
 *
 * This exists because of the failure mode it prevents, which is total and
 * silent: a file dropped on a page that does not call `preventDefault` is
 * NAVIGATED TO. The webview leaves the app and renders the PDF in WebKit's
 * built-in viewer — no titlebar, no pane, no reader, no error. It looks exactly
 * like the interface collapsing, and it is unrecoverable without a reload.
 *
 * The reader's empty state used to be the only drop target, so every drop that
 * missed that one div did this: on the titlebar, on the pane, on the margins,
 * or anywhere at all once a book was open and the empty state was gone.
 *
 * So the listeners go on the WINDOW, and `preventDefault` is called on the
 * whole sequence rather than only on the drop. `dragover` is the load-bearing
 * one: without preventing it the drop event never fires at all, and the
 * navigation happens instead.
 */

export interface FileDrop {
  /** True while a file is being dragged over the window. */
  readonly dragging: boolean
}

/**
 * What one drop yielded.
 *
 * THREE OUTCOMES, NOT ONE LIST, because the caller has three different things
 * to say. An empty list used to mean all of "you dropped no books", "the books
 * you dropped could not be read", and "we stopped counting at five thousand",
 * and the reader was told the first of those regardless — which is a lie in
 * two cases out of three, and the more alarming two.
 */
export interface DropHaul {
  readonly books: File[]
  /** Entries that exist and could not be read. Distinct from "not a book". */
  readonly unreadable: number
  /** True when `MAX_FILES` ended the walk before the drop did. */
  readonly truncated: boolean
}

/** The accumulator the walk fills, before it is frozen into a `DropHaul`. */
interface Haul {
  books: File[]
  unreadable: number
  truncated: boolean
}

/**
 * One entry's bytes, or a recorded failure.
 *
 * Extracted because this was written out twice — once per walker — and the two
 * copies are exactly the kind that drift: each has to decide what a failed read
 * means, and they have to decide it the same way.
 */
async function fileFrom(entry: FileSystemFileEntry, haul: Haul): Promise<void> {
  const file = await new Promise<File | null>((resolve) => {
    entry.file(resolve, () => resolve(null))
  })
  if (file) haul.books.push(file)
  // COUNTED, not swallowed. A book that exists and will not open is a thing
  // the reader needs told; silently returning fewer books than were dropped is
  // how "nothing happened" gets reported for a real failure.
  else haul.unreadable += 1
}

/**
 * Every book under a dropped directory, depth-first.
 *
 * The web's own directory API rather than `collectBooks`, and not by choice: a
 * drop hands the webview `FileSystemEntry` objects, not paths, so Tauri's
 * `readDir` has nothing to walk. The BOUNDS and the format list are imported
 * from `importFolder` so the two walkers cannot disagree about what a book is
 * or how far to go — a drop that accepted what the picker refused would be a
 * difference nobody chose.
 *
 * `readEntries` IS BATCHED, and that is the trap in this API: it returns at
 * most a hundred or so per call and signals the end with an EMPTY array, not by
 * returning everything. Calling it once — which reads like the obvious use —
 * silently imports the first hundred books of a folder and drops the rest, and
 * looks exactly like a folder that had a hundred books in it.
 */
async function booksUnder(dir: FileSystemDirectoryEntry, depth: number, haul: Haul): Promise<void> {
  if (depth > MAX_DEPTH) return
  if (haul.books.length >= MAX_FILES) {
    haul.truncated = true
    return
  }
  const reader = dir.createReader()
  for (;;) {
    const failed = { yes: false }
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      // Ending this directory rather than the whole drop, matching
      // `collectBooks`: one unreadable branch should cost that branch, not
      // every other book the reader dropped. It is RECORDED either way.
      reader.readEntries(resolve, () => {
        failed.yes = true
        resolve([])
      })
    })
    if (failed.yes) haul.unreadable += 1
    if (batch.length === 0) return
    for (const entry of batch) {
      if (haul.books.length >= MAX_FILES) {
        haul.truncated = true
        return
      }
      if (entry.isDirectory) {
        /* THE DOT CHECK BELONGS TO DIRECTORIES ONLY, which is where
         * `collectBooks` puts it. Hoisted above this branch it also skipped
         * hidden FILES, so a `.book.pdf` imported by picker and not by drop —
         * breaking the walker parity the header above promises, three lines
         * after promising it. */
        if (entry.name.startsWith('.')) continue
        await booksUnder(entry as FileSystemDirectoryEntry, depth + 1, haul)
      } else if (IMPORTABLE.test(entry.name)) {
        await fileFrom(entry as FileSystemFileEntry, haul)
      }
    }
  }
}

/**
 * What was dropped, flattened to books.
 *
 * Entries have to be taken from `DataTransferItemList` SYNCHRONOUSLY — the
 * list is emptied the moment the drop handler returns, so reaching for it after
 * an await finds nothing. Hence the split: the caller collects entries in the
 * event, this walks them afterwards.
 */
async function booksFrom(
  entries: readonly FileSystemEntry[],
  plain: readonly File[],
): Promise<DropHaul> {
  const haul: Haul = { books: [], unreadable: 0, truncated: false }

  /* No entries means no directory API — every dropped item is already a File.
   * IT IS STILL CAPPED. This branch returned the filtered list whole, so a drop
   * of loose files walked straight past the ceiling the other branch enforces —
   * the same ceiling `importFolder` documents as the thing standing between a
   * mis-aimed drop and an hour of work. */
  if (entries.length === 0) {
    const books = plain.filter((file) => IMPORTABLE.test(file.name))
    return {
      books: books.slice(0, MAX_FILES),
      unreadable: 0,
      truncated: books.length > MAX_FILES,
    }
  }

  for (const entry of entries) {
    if (haul.books.length >= MAX_FILES) {
      haul.truncated = true
      break
    }
    if (entry.isDirectory) {
      await booksUnder(entry as FileSystemDirectoryEntry, 0, haul)
    } else if (IMPORTABLE.test(entry.name)) {
      await fileFrom(entry as FileSystemFileEntry, haul)
    }
  }
  return haul
}

/**
 * @param onDrop Everything one drop yielded, in one call.
 *
 * A HAUL, not a file. This took `files.item(0)` and opened it, so dropping five
 * books opened one and discarded four in silence — the same defect
 * `keepOwnCopy`'s note records as having been fixed for the PICKER ("picking
 * five books used to add one") while it stayed live on this path. Handing the
 * caller everything is what lets a drop be reported the way a pick is.
 */
export function useFileDrop(onDrop: (haul: DropHaul) => void): FileDrop {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onDrop)
  handler.current = onDrop

  /* dragenter and dragleave fire for every element crossed, so a boolean
   * flickers as the pointer moves over the interface. Depth counting is what
   * makes leave mean "left the window". */
  const depth = useRef(0)

  /* THE DROPS, IN THE ORDER THEY WERE DROPPED. Each drop used to start its own
   * detached traversal, so a folder dropped first and a file dropped second
   * raced: whichever finished last called the handler last and decided which
   * book ended up open. Walking a directory tree takes far longer than reading
   * one file, so the reader reliably got the OLDER drop — and the newer one it
   * looked like they had asked for was the one thrown away.
   *
   * A promise chain rather than a "latest wins" token, deliberately. Superseding
   * would fix the ordering by discarding work the reader explicitly asked for;
   * queueing keeps every dropped book and still delivers them in the order the
   * drops happened. */
  const queue = useRef<Promise<void>>(Promise.resolve())
  /* Set by the effect's own cleanup, and checked on BOTH sides of the walk. The
   * listeners come off at unmount but an in-flight traversal does not, so
   * without this the handler fires into a component that is gone — reopening a
   * book on a screen the reader has already left. */
  const gone = useRef(false)

  useEffect(() => {
    gone.current = false
    /* Whether this drag carries a book. Selecting text inside the book and
     * dragging it also raises these events, and treating that as an incoming
     * book would light the drop state up mid-selection.
     *
     * This gates the VISIBLE response only — never `preventDefault`. See below. */
    const isFile = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    /* Where a drop is a legitimate edit rather than a navigation.
     *
     * Everything else on the window is inert to dropping, so preventing the
     * default there costs nothing. Inside a text field it would cost the
     * ordinary ability to drag text into the search box, and a text drop on an
     * input inserts text — it does not navigate — so the hazard is absent. */
    const isEditable = (event: DragEvent) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return false
      return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
    }

    const onDragEnter = (event: DragEvent) => {
      if (isEditable(event)) return
      event.preventDefault()
      if (!isFile(event)) return
      depth.current += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent) => {
      if (isEditable(event)) return
      /* THE important one, and it must NOT be gated on the drag carrying a
       * file. Without a prevented `dragover` there is no `drop` event at all —
       * so the unconditional guard in `onDrop` below never runs, and the
       * webview navigates to whatever was dropped. A URL dragged from a
       * browser carries `text/uri-list` rather than `Files`, which is exactly
       * the case a file-only check lets through: the app is replaced by that
       * page, with no way back short of a reload. */
      event.preventDefault()
      if (event.dataTransfer && isFile(event)) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      if (!isFile(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
      if (isEditable(event)) return
      // Not gated on `isFile`: whatever was dropped, the default must not run.
      // A dropped URL navigates away just as a dropped file does.
      event.preventDefault()
      depth.current = 0
      setDragging(false)

      const transfer = event.dataTransfer
      if (!transfer) return

      /* BOTH READ NOW, BEFORE ANY AWAIT. `DataTransferItemList` is emptied as
       * soon as this handler returns, so an entry fetched after the first await
       * comes back null and a dropped folder silently yields nothing. The walk
       * therefore happens outside this function, on values already in hand. */
      const entries: FileSystemEntry[] = []
      for (const item of Array.from(transfer.items ?? [])) {
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }
      const plain = Array.from(transfer.files ?? [])

      /* Nothing was dropped at all — a stray drag that carried no files. There
       * is nothing to say about it, so nothing is said. */
      if (entries.length === 0 && plain.length === 0) return

      /* ONTO THE QUEUE, not off on its own — see `queue`. The chain is what
       * makes two quick drops arrive in the order they were dropped instead of
       * in the order their traversals happen to finish. */
      queue.current = queue.current
        .then(async () => {
          if (gone.current) return
          const haul = await booksFrom(entries, plain)
          if (gone.current) return
          /* CALLED EVEN WHEN THE LIST IS EMPTY, which is the difference between
           * "no books here" and "nothing happened". Filtering on `IMPORTABLE`
           * means a dropped `.txt`, or a folder with no books in it, produces
           * an empty list where the old code would at least have tried to open
           * the file and failed loudly. Swallowing that would trade one bug for
           * a quieter one: a reader who drags a file onto a reader and sees no
           * response at all cannot tell the app from a dead window. The haul
           * carries enough for the caller to say WHICH kind of nothing it was. */
          handler.current(haul)
        })
        .catch((cause: unknown) => {
          // Reported rather than discarded: this chain is not awaited anywhere,
          // so a throw would reach the window as an unhandled rejection with
          // nothing naming the drop that caused it. Caught here rather than per
          // link, so one failed drop cannot break the chain for the next.
          console.error('Paper: could not read what was dropped', cause)
        })
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      // Before the listeners come off, because what this stops is not a
      // listener: it is the traversal already running, which no amount of
      // unbinding reaches.
      gone.current = true
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return { dragging }
}
