import { useEffect, useRef, useState } from 'react'

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

export function useFileDrop(onFile: (file: File) => void): FileDrop {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onFile)
  handler.current = onFile

  /* dragenter and dragleave fire for every element crossed, so a boolean
   * flickers as the pointer moves over the interface. Depth counting is what
   * makes leave mean "left the window". */
  const depth = useRef(0)

  useEffect(() => {
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
      const file = event.dataTransfer?.files?.item(0)
      if (file) handler.current(file)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return { dragging }
}
