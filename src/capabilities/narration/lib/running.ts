/**
 * The export control the host publishes, for the palette row to read.
 *
 * ⚠️ **MODULE STATE, READ AT THE MOMENT IT IS NEEDED.** The host is a window
 * host, drawn by the kernel; the row is built by `commands`, which the kernel
 * calls whenever it rebuilds the palette — opening the palette is one of those
 * moments. Neither can hand the other anything, so the host writes here and the
 * row reads here: the label as the palette is built, and the control again when
 * the row is chosen, so a press always reaches the export that is running now.
 */

/** What the palette row needs: whether an export is running, and how to start or stop one. */
export interface AudiobookControl {
  readonly running: boolean
  readonly run: () => void
}

let current: AudiobookControl | null = null

/** The control the host published, or null while it has none to offer. */
export function currentControl(): AudiobookControl | null {
  return current
}

/**
 * Publish a control, or withdraw one with null.
 *
 * ⚠️ **A WITHDRAWAL ONLY WITHDRAWS ITS OWN.** A host that unmounts after another
 * has published must not clear the newer one, so the caller passes what it
 * published and the slot is emptied only while it still holds that.
 */
export function publishControl(control: AudiobookControl): () => void {
  current = control
  return () => {
    if (current === control) current = null
  }
}
