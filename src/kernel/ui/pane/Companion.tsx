import { ArrowUp, Square } from 'lucide-react'
import { useState } from 'react'
import {
  NOT_CONFIGURED_REASON,
  type AskPassage,
  type Citation,
  type CompanionProvider,
} from '../../core/companion'
import { ICON } from '../../core/metrics'
import { useCompanionThread } from '../hooks/useCompanionThread'
import styles from './SidePane.module.css'

export interface CompanionProps {
  currentChapter: string
  /** False when no book is open — the companion has nothing to be grounded in. */
  hasBook: boolean
  provider: CompanionProvider
  /** The book being read, for the grounding context. */
  bookTitle?: string
  /** The reader's selection, when the question is about one. */
  selection?: string | null
  /**
   * The book text an answer may be grounded in, in reading order.
   *
   * A FUNCTION, called when the reader asks — not a value passed on every
   * render. Assembling it means walking the rendered document, and doing that
   * per keystroke in the composer would put a DOM walk on the typing path.
   * Empty is legal and is what a build with nothing to read gives: the
   * companion then has nothing to cite, and says so rather than answering
   * around it.
   */
  passages?: () => readonly AskPassage[]
  /** Navigate to a citation — the same `goTo` a search hit uses. */
  onGoTo?: (cfi: string) => void
}

/**
 * The companion.
 *
 * Everything it produces is amber, everywhere, forever — that is the whole
 * provenance rule, and it is why a reply and its label carry the amber tokens
 * rather than the accent. It never speaks unprompted.
 *
 * The panel used to render a fixed exchange about Moby-Dick — a question the
 * reader never asked and an answer nothing produced — under whatever chapter
 * heading was live, so opening any other book showed invented quotations
 * attributed to it. Amber is a provenance mark; using it on fabrications is
 * the one thing that makes it worthless. **The thread below shows only what a
 * provider actually returned**, and a claim whose citation could not be
 * resolved says so rather than carrying one that points somewhere plausible.
 */
export function Companion({
  currentChapter,
  hasBook,
  provider,
  bookTitle = '',
  selection = null,
  passages,
  onGoTo,
}: CompanionProps) {
  const thread = useCompanionThread(provider, () => ({
    bookTitle,
    chapterLabel: currentChapter,
    selection,
    passages: passages?.() ?? [],
  }))
  const [draft, setDraft] = useState('')

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

  const submit = (): void => {
    thread.ask(draft)
    setDraft('')
  }

  return (
    <>
      <div className={styles.companionHead}>grounded in this book only</div>

      <div className={styles.thread}>
        {thread.messages.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>
              Ask about {currentChapter || 'this book'}
            </div>
            <div className={styles.emptyBody}>
              Answers come from the passages on the page and cite where they came
              from. Everything the companion writes is marked amber.
            </div>
          </div>
        ) : (
          thread.messages.map((message) => (
            <div key={message.id} className={styles.turn} data-role={message.role}>
              <div className={styles.turnBody}>
                {message.text}
                {/* A caret while the answer is still arriving: §08 says the
                    reply should appear as it is produced rather than arriving
                    whole, and a stopped stream must not look like a short
                    answer. */}
                {message.streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
              </div>

              {message.citations.length > 0 ? (
                <div className={styles.citations}>
                  {message.citations.map((citation: Citation) => (
                    <button
                      key={citation.cfi}
                      type="button"
                      className={styles.citation}
                      onClick={() => onGoTo?.(citation.cfi)}
                      disabled={onGoTo === undefined}
                    >
                      {citation.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {/* ⚠️ THE HALF WI-15.5 ASKED FOR AND NOTHING COULD DRAW. The
                  drop of a fabricated `[47]` was implemented and tested; the
                  visible note beside it was not, because the flag saying one
                  had been dropped was discarded where the citations were
                  resolved. An answer that quietly cites less than it claims is
                  precisely the outcome the drop exists to prevent. */}
              {message.notice !== null ? (
                <div className={styles.turnNotice}>{message.notice}</div>
              ) : null}

              {message.failure !== null ? (
                <div className={styles.turnFailure}>{message.failure}</div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className={styles.footerActions}>
        <div className={styles.composer}>
          <input
            className={styles.composerInput}
            placeholder={`Ask about ${currentChapter || 'this book'}`}
            aria-label="Ask the companion about this chapter"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {/* ONE BUTTON, whose meaning is the action available now: send, or
              stop the answer that is arriving. A separate always-visible stop
              would be a control that does nothing most of the time. */}
          {thread.busy ? (
            <button
              type="button"
              className={styles.send}
              title="Stop"
              aria-label="Stop"
              onClick={() => thread.cancel()}
            >
              <Square size={11} strokeWidth={ICON.stroke} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.send}
              title="Send"
              aria-label="Send"
              disabled={draft.trim() === ''}
              data-disabled={draft.trim() === '' ? 'true' : undefined}
              onClick={submit}
            >
              <ArrowUp size={13} strokeWidth={ICON.stroke} />
            </button>
          )}
        </div>
      </div>
    </>
  )
}
