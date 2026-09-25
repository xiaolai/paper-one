import { useState } from 'react'
import { SeekTrack, shownFraction } from '../../kernel/ui/reader/SeekTrack'
import styles from './ProgressFooter.module.css'

/**
 * The reader's footer: "37% · ▬▬▬ · 14 min left".
 *
 * From the mockup's Reader screen, which has NO other chrome — the tab bar is
 * gone, the title is gone, and this strip fades up from the foot over a
 * gradient so the last line of the page is never hard-cut.
 *
 * ⚠️ **THE TRACK ITSELF IS `kernel/ui/reader/SeekTrack`, NOT THIS FILE.** It
 * used to live here, and the desktop cannot import it from here — `src/app/`
 * depends on the kernel and never the other way round — so the desktop would
 * have needed a copy. Two implementations of the control whose failure mode is
 * *losing the reader's place* is the shape this repository keeps having to
 * delete, so the track moved to the kernel and this became one of its two
 * callers.
 *
 * ## The estimate is honest about what it is
 *
 * There is no reading-speed model on this client. The figure is the remaining
 * fraction of the BOOK at 250 words a minute over an assumed 90,000 words —
 * a number for a novel, and wrong for a monograph. It is drawn muted and it
 * is not labelled "in chapter", because it is not per chapter.
 */
export interface ProgressFooterProps {
  /** 0–1 through the book, from `ReaderPosition.fraction`. */
  readonly fraction: number
  readonly visible: boolean
  /**
   * The print edition's page here, or empty — see `ReaderPosition.printPage`.
   *
   * ⚠️ **NEVER A SYNTHESISED NUMBER.** A page counted from this window is a
   * fact about this window, and showing it in the same slot as a real one
   * makes the real one untrustworthy. Empty draws nothing.
   */
  readonly printPage?: string | undefined
  /**
   * Go to a place, 0–1 through the book. Absent means the track is a readout.
   *
   * ⚠️ **THE CALLER MUST RECORD A JUMP, NOT CALL `goToFraction` DIRECTLY.**
   * This is the only control in the app that can move a reader a thousand
   * pages by accident, and a slipped thumb in a long book loses their place
   * permanently unless the departure was recorded. `useJumps.jumpTo` is what
   * makes ⌘[ bring them back.
   */
  readonly onSeek?: ((fraction: number) => void) | undefined
}

const WORDS_PER_MINUTE = 250
const ASSUMED_BOOK_WORDS = 90_000

export function minutesLeft(fraction: number): number {
  const left = Math.max(0, Math.min(1, 1 - fraction))
  return Math.round((left * ASSUMED_BOOK_WORDS) / WORDS_PER_MINUTE)
}

export function ProgressFooter({ fraction, visible, onSeek, printPage = '' }: ProgressFooterProps) {
  /* The READOUTS follow the thumb, not the book, so the percentage a reader
     sees while dragging is the place they are about to land on. `SeekTrack`
     owns the drag; this owns the words beside it, and both read the same
     function so they can never disagree about what is being previewed. */
  const [preview, setPreview] = useState<number | null>(null)
  const shown = shownFraction(fraction, preview)
  const pct = Math.round(shown * 100)
  const mins = minutesLeft(shown)

  return (
    /* ⚠️ **`aria-hidden` AND `opacity: 0` DO NOT DISABLE ANYTHING.** The hidden
       footer kept a focusable slider with live pointer handlers, so a reader
       could Tab into an invisible control and seek by accident — including
       mid-selection, which is exactly when the chrome hides. `inert` is the
       one attribute that removes it from focus, from the pointer and from the
       accessibility tree together. */
    <div className={styles.foot} data-visible={visible} inert={!visible}>
      <span className={styles.pct}>{pct}%</span>
      {printPage.trim() !== '' && <span className={styles.page}>p. {printPage.trim()}</span>}
      <SeekTrack
        fraction={fraction}
        className={styles.track}
        {...(onSeek ? { onSeek } : {})}
        onPreview={setPreview}
      />
      {/* ⚠️ **ALWAYS RENDERED, EMPTY WHEN THERE IS NOTHING TO SAY.** It used to
          be absent below 1 %, which meant the row REFLOWED the instant a drag
          preview passed 0 — the track is `flex: 1`, so it narrowed under the
          reader's thumb. The rule the text obeys is unchanged: no estimate
          before the reader has moved, because "~6 h left" for a book nobody
          has opened is a real-sounding figure from an assumed word count. */}
      <span className={styles.left}>
        {pct > 0 ? (mins < 1 ? 'Nearly done' : mins < 60 ? `~${mins} min left` : `~${Math.round(mins / 60)} h left`) : ''}
      </span>
    </div>
  )
}
