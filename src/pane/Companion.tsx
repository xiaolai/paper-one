import { AlignLeft, ArrowUp, Pin, Quote } from 'lucide-react'
import { ICON } from '../lib/metrics'
import styles from './SidePane.module.css'

export interface CompanionProps {
  currentChapter: string
  /** False when no book is open — the companion has nothing to be grounded in. */
  hasBook: boolean
}

/**
 * The companion.
 *
 * Everything it produces is amber, everywhere, forever — that is the whole
 * provenance rule, and it is why the summary card, its label and every reply
 * carry the amber tokens rather than the accent. It never speaks unprompted.
 */
export function Companion({ currentChapter, hasBook }: CompanionProps) {
  /* No fabricated content. The thread used to render a hardcoded Moby-Dick
   * exchange under whatever chapter heading was live, so opening any other
   * book showed it invented quotations about that book. */
  if (!hasBook) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No book open</div>
        <div className={styles.emptyBody}>
          The companion is grounded in the book you are reading. Open one to ask
          about it.
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={styles.companionHead}>grounded in this book only</div>

      <div className={styles.thread}>
        <div className={styles.summary}>
          <div className={styles.summaryLabel}>
            <AlignLeft size={11} strokeWidth={ICON.stroke} />
            {currentChapter ? `${currentChapter} · summary` : 'Chapter summary'}
          </div>
          <div className={styles.summaryBody}>
            The companion never speaks unprompted. Ask about this chapter, or use
            the palette, and everything it produces is marked amber.
          </div>
          <div className={styles.cited}>0 passages cited</div>
        </div>

        <div className={styles.askRow}>
          <div className={styles.ask}>What does “hypos” mean here?</div>
        </div>

        <div className={styles.replyRow}>
          <div className={styles.reply}>
            Short for{' '}
            <em style={{ fontFamily: "'Crimson Pro Variable', serif", fontSize: 15 }}>
              hypochondria
            </em>
            , which in 1851 meant low spirits rather than imagined illness.
          </div>
          <div className={styles.replyMeta}>
            <span className={styles.replyMetaItem}>
              <Quote size={11} strokeWidth={ICON.stroke} />¶2 · line 6
            </span>
            {/* §07 disabled rather than a span that looks clickable: pinning
                needs the annotation store, which does not exist yet. */}
            <button
              type="button"
              className={styles.replyMetaItem}
              disabled
              data-disabled="true"
              title="Pin to margin — not available yet"
            >
              <Pin size={11} strokeWidth={ICON.stroke} />
              Pin to margin
            </button>
          </div>
        </div>
      </div>

      <div className={styles.footerActions}>
        {/* Every affordance below is disabled per §07 until a model is wired.
            They were live-looking controls that did nothing on click — the
            companion cannot answer anything yet. */}
        <div className={styles.suggestions}>
          <button type="button" className={styles.suggestion} disabled data-disabled="true">
            Simplify this page
          </button>
          <button type="button" className={styles.suggestion} disabled data-disabled="true">
            Summarise to here
          </button>
        </div>
        <div className={styles.composer} data-disabled="true">
          <input
            className={styles.composerInput}
            placeholder="Asking needs a model — not configured yet"
            aria-label="Ask the companion about this chapter"
            disabled
          />
          <button type="button" className={styles.send} title="Send" disabled data-disabled="true">
            <ArrowUp size={13} strokeWidth={ICON.stroke} />
          </button>
        </div>
      </div>
    </>
  )
}
