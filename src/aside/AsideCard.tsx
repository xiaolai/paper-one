import { AlignLeft, ArrowUp, List, Pin, Quote, Sparkles } from 'lucide-react'
import type { TocItem } from 'foliate-js/view.js'
import type { Platform } from '../lib/metrics'
import { ICON } from '../lib/metrics'
import type { AppDispatch, AsidePanel } from '../lib/state'
import { LeadingCard } from '../shell/LeadingCard'
import styles from './AsideCard.module.css'

export interface AsideCardProps {
  platform: Platform
  width: number
  panel: AsidePanel
  dispatch: AppDispatch
  toc: readonly TocItem[]
  currentChapter: string
  onGoTo?: (href: string) => void
}

interface FlatTocEntry {
  readonly label: string
  readonly href: string
  readonly depth: number
}

/** The TOC is a tree; the card renders it as an indented list. */
function flattenToc(items: readonly TocItem[], depth = 0): FlatTocEntry[] {
  return items.flatMap((item) => [
    { label: item.label, href: item.href, depth: Math.min(depth, 2) },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ])
}

export function AsideCard({
  platform,
  width,
  panel,
  dispatch,
  toc,
  currentChapter,
  onGoTo,
}: AsideCardProps) {
  const entries = flattenToc(toc)

  return (
    <LeadingCard platform={platform} width={width}>
      <div className={styles.tabs}>
        {(
          [
            { key: 'toc', label: 'Contents', Icon: List },
            { key: 'companion', label: 'Companion', Icon: Sparkles },
          ] as const
        ).map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={styles.tab}
            data-on={panel === key}
            onClick={() => dispatch({ type: 'setAside', panel: key as AsidePanel })}
          >
            <Icon size={14} strokeWidth={ICON.stroke} />
            {label}
          </button>
        ))}
      </div>

      {panel === 'toc' ? (
        <div className={styles.body}>
          <div className={styles.tocList}>
            {entries.length === 0 ? (
              <p className={styles.emptyToc}>
                This book has no table of contents.
              </p>
            ) : (
              entries.map((entry, index) => (
                <button
                  key={`${entry.href}-${index}`}
                  type="button"
                  className={styles.tocRow}
                  data-depth={entry.depth}
                  data-current={entry.label === currentChapter}
                  onClick={() => onGoTo?.(entry.href)}
                >
                  <span className={styles.tocLabel}>{entry.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.companionHead}>
            <span>grounded in this book only</span>
          </div>

          <div className={styles.thread}>
            <div className={styles.summary}>
              <div className={styles.summaryLabel}>
                <AlignLeft size={11} strokeWidth={ICON.stroke} />
                {currentChapter ? `${currentChapter} · summary` : 'Chapter summary'}
              </div>
              <div className={styles.summaryBody}>
                The companion never speaks unprompted. Ask about this chapter, or
                use the palette, and everything it produces is marked amber.
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
        </div>
      )}
    </LeadingCard>
  )
}
