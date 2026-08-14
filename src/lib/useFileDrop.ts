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
    /* Only file drags. Selecting text inside the book and dragging it also
     * raises these events, and treating that as an incoming book would light
     * the drop state up mid-selection. */
    const isFile = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (event: DragEvent) => {
      if (!isFile(event)) return
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent) => {
      if (!isFile(event)) return
      // THE important one. Without it there is no drop event and the webview
      // navigates to the file instead.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (event: DragEvent) => {
      if (!isFile(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent) => {
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
