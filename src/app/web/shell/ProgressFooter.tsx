import styles from './ProgressFooter.module.css'

/**
 * The reader's footer: "37% · ▬▬▬ · 14 min left in chapter".
 *
 * From the mockup's Reader screen, which has NO other chrome — the tab bar is
 * gone, the title is gone, and this strip fades up from the foot over a
 * gradient so the last line of the page is never hard-cut. §12's rule for the
 * duration: "14 min left in chapter", never "0:14:00".
 *
 * ## The estimate is honest about what it is
 *
 * There is no reading-speed model on this client. The figure is the remaining
 * fraction of the BOOK at 250 words a minute over an assumed 90,000 words —
 * a number for a novel, and wrong for a monograph. It is drawn muted and it
 * is not labelled "in chapter", because it is not per chapter: `chapterHref`
 * names the section but nothing here knows the section's length. Saying
 * "in chapter" would be a precision the number does not have.
 */
export interface ProgressFooterProps {
  /** 0–1 through the book, from `ReaderPosition.fraction`. */
  readonly fraction: number
  readonly visible: boolean
}

const WORDS_PER_MINUTE = 250
const ASSUMED_BOOK_WORDS = 90_000

export function minutesLeft(fraction: number): number {
  const left = Math.max(0, Math.min(1, 1 - fraction))
  return Math.round((left * ASSUMED_BOOK_WORDS) / WORDS_PER_MINUTE)
}

export function ProgressFooter({ fraction, visible }: ProgressFooterProps) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100)
  const mins = minutesLeft(fraction)
  return (
    <div className={styles.foot} data-visible={visible} aria-hidden={!visible}>
      <span className={styles.pct}>{pct}%</span>
      <span className={styles.track} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className={styles.fill} style={{ inset: `0 ${100 - pct}% 0 0` }} />
      </span>
      {/* NO ESTIMATE BEFORE THE READER HAS MOVED. At 0% the arithmetic gives
          "6 h left" for a book nobody has opened — a real-sounding figure from
          an assumed word count. Keyed on the DISPLAYED percent: a book at 0.3%
          is "0%" to the reader, and "0% · ~6 h left" is the same false reading
          with the guard on `fraction` still passing. The mockup's "14 min left in chapter" is
          measured; this is not, and a guess presented as a reading looks like
          a reading. Once there is progress the number is at least about THIS
          reader, and it is muted and unlabelled. */}
      {pct > 0 && (
        <span className={styles.left}>
          {mins < 1 ? 'Nearly done' : mins < 60 ? `~${mins} min left` : `~${Math.round(mins / 60)} h left`}
        </span>
      )}
    </div>
  )
}
