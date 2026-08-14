import { ArrowUp } from 'lucide-react'
import { NOT_CONFIGURED_REASON, type CompanionProvider } from '../lib/companion'
import { ICON } from '../lib/metrics'
import styles from './SidePane.module.css'

export interface CompanionProps {
  currentChapter: string
  /** False when no book is open — the companion has nothing to be grounded in. */
  hasBook: boolean
  provider: CompanionProvider
}

/**
 * The companion.
 *
 * Everything it produces is amber, everywhere, forever — that is the whole
 * provenance rule, and it is why a reply and its label carry the amber tokens
 * rather than the accent. It never speaks unprompted.
 *
 * There is no thread here because there is nothing to put in one. The panel
 * used to render a fixed exchange about Moby-Dick — a question the reader never
 * asked and an answer nothing produced — under whatever chapter heading was
 * live, so opening any other book showed invented quotations attributed to it.
 * Amber is a provenance mark; using it on fabrications is the one thing that
 * makes it worthless. The state below says what is missing instead.
 */
export function Companion({ currentChapter, hasBook, provider }: CompanionProps) {
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

  if (!provider.configured) {
    return (
      <>
        <div className={styles.companionHead}>grounded in this book only</div>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>The companion is not available</div>
          <div className={styles.emptyBody}>
            {NOT_CONFIGURED_REASON} Everything it produced would be marked amber
            and cite the passage it came from
            {currentChapter ? ` in ${currentChapter}` : ''} — your highlights and
            notes work as usual in the meantime.
          </div>
        </div>

        {/* §07: the composer stays visible and disabled rather than vanishing.
            The reader should be able to see where asking will happen, and the
            placeholder is the reason it cannot happen yet. */}
        <div className={styles.footerActions}>
          <div className={styles.composer} data-disabled="true">
            <input
              className={styles.composerInput}
              placeholder={NOT_CONFIGURED_REASON}
              aria-label="Ask the companion about this chapter"
              disabled
            />
            <button
              type="button"
              className={styles.send}
              title="Send"
              aria-label="Send"
              disabled
              data-disabled="true"
            >
              <ArrowUp size={13} strokeWidth={ICON.stroke} />
            </button>
          </div>
        </div>
      </>
    )
  }

  /* Unreachable in this build, and deliberately not a half-written thread: a
   * provider that reports itself configured is the change that brings the
   * conversation UI with it, built against real messages and real citations
   * rather than against a shape guessed at in advance.
   *
   * It says so on screen rather than looking like a feature that is loading.
   * A panel headed "Ask about Chapter 4" with an encouraging line under it,
   * over a provider whose answers nothing displays, is a promise this build
   * cannot keep. */
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>Conversation view not built yet</div>
      <div className={styles.emptyBody}>
        {provider.name} is configured, but nothing here asks it anything yet:
        this build has the provider seam and none of the thread that would show
        an answer. Your marks and notes are unaffected.
      </div>
    </div>
  )
}
