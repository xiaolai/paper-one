import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '../platform'
import { CLOSE_HOLD_MS, createCloseSequence } from '../closeWindow'

/**
 * Ask the window to close, the way the red button does.
 *
 * This is what Ctrl+Q means off macOS (`accel.ts`): the request lands in the
 * interceptor below, which runs the teardown and destroys — so a quit by key
 * closes the sync journal exactly as a quit by button does. Outside Tauri
 * there is no window to close and nothing to do.
 */
export function requestWindowClose(): void {
  if (!isTauri()) return
  void getCurrentWindow()
    .close()
    .catch((cause: unknown) => {
      console.error('Paper: window close failed', cause)
    })
}

/**
 * Hold the window shut until everything written has landed.
 *
 * # Why this is not in `App`
 *
 * It is a whole errand with its own failure modes — an async registration
 * against a synchronous cleanup, a drain that must be bounded, a sequence that
 * must always destroy — and none of it touches the reading position, the
 * screen or the keyboard map that `App` otherwise coordinates. Both defects
 * this code has had were lifetime defects, and a lifetime defect is far easier
 * to see in thirty lines than in seventeen hundred.
 *
 * # What it is for
 *
 * Every write in this app is deliberately asynchronous — a page turn must not
 * wait on a disk — and that is right until the process is about to go away, at
 * which point an unfinished write is a highlight the reader will not get back.
 * `pagehide` was the previous answer and it cannot be one: it STARTS the work
 * and the webview is torn down underneath it.
 *
 * So the close is intercepted, the queue drained, and the window closed for
 * real. The reader sees a window that takes a few milliseconds longer to shut,
 * which is the correct price.
 *
 * BOUNDED. A queue that will not drain — a disk that has stopped answering —
 * must not make the app unclosable, because then the only way out is to kill
 * it and that loses strictly more. See `CLOSE_DRAIN_MS`, which the app's quit
 * path shares.
 */
export function useWindowClose(prepare: () => Promise<unknown>): void {
  useEffect(() => {
    if (!isTauri()) return
    /* The registration is ASYNC and the cleanup is not: torn down before the
     * promise resolved — which StrictMode's mount/unmount/mount does on every
     * launch in dev — `stop` was still undefined, the cleanup removed nothing,
     * and the second mount added a second handler: two intercepts, two
     * destroys, racing. A registration that lands after its effect died is
     * unregistered on the spot. */
    let disposed = false
    let stop: (() => void) | undefined
    /* THE SEQUENCE IS ITS OWN UNIT, and every failure path lives there — see
     * `closeWindow.ts`. `preventDefault` has already run by the time it
     * starts, so nothing else will close this window; a throw anywhere in here
     * used to reject the listener and leave the reader with a window that
     * would not close. */
    /* `prepare` IS THE SAME TEARDOWN ⌘Q RUNS when the composition root
     * supplies one (`App`'s `beforeWindowClose`): the red button used to
     * flush and drain and never end the capabilities, so the sync journal's
     * flag stayed up on every close — and on Windows and Linux, which have no
     * quit menu, that was every quit. */
    const close = createCloseSequence({
      prepare,
      destroy: () => getCurrentWindow().destroy(),
      timeoutMs: CLOSE_HOLD_MS,
      report: (message, cause) => console.error(message, cause),
    })
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault()
        await close()
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        stop = unlisten
      })
      .catch((cause: unknown) => {
        // Without the listener the window closes as it always did — writes in
        // flight are at risk, which is the state this replaces rather than a
        // new one. Reported, because it is the difference between "saved" and
        // "probably saved".
        console.error('Paper: could not hold the window open to finish saving', cause)
      })
    return () => {
      /* SET, which it never was. The comment above describes a registration
       * landing after its effect died being "unregistered on the spot", and
       * `disposed` was declared and read and never written — so StrictMode's
       * mount/unmount/mount left the first listener registered and the second
       * mount added another: two intercepts, two teardowns, racing. */
      disposed = true
      stop?.()
    }
  }, [prepare])
}
