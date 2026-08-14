import { AlignLeft, ArrowUp, Pin, Quote } from 'lucide-react'
import { ICON } from '../lib/metrics'
import styles from './SidePane.module.css'

export interface CompanionProps {
  currentChapter: string
}

/**
 * The companion.
 *
 * Everything it produces is amber, everywhere, forever — that is the whole
 * provenance rule, and it is why the summary card, its label and every reply
 * carry the amber tokens rather than the accent. It never speaks unprompted.
 */
export function Companion({ currentChapter }: CompanionProps) {
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
            <span className={styles.replyMetaItem}>
              <Pin size={11} strokeWidth={ICON.stroke} />
              Pin to margin
            </span>
          </div>
        </div>
      </div>

      <div className={styles.footerActions}>
        <div className={styles.suggestions}>
          <button type="button" className={styles.suggestion}>
            Simplify this page
          </button>
          <button type="button" className={styles.suggestion}>
            Summarise to here
          </button>
        </div>
        <div className={styles.composer}>
          <input
            className={styles.composerInput}
            placeholder="Ask about this chapter…"
            aria-label="Ask the companion about this chapter"
          />
          <button type="button" className={styles.send} title="Send">
            <ArrowUp size={13} strokeWidth={ICON.stroke} />
          </button>
        </div>
      </div>
    </>
  )
}
