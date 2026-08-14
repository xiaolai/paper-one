import type { CSSProperties, ReactNode } from 'react'
import type { Platform } from '../lib/metrics'
import type { Side } from '../lib/state'
import styles from './LeadingCard.module.css'

export interface LeadingCardProps {
  platform: Platform
  /** Fixed track width — 400 for the side pane, per §03. */
  width: number
  /** Which edge the card hugs, so its margin mirrors. */
  side: Side
  children: ReactNode
}

export function LeadingCard({ platform, width, side, children }: LeadingCardProps) {
  const track: CSSProperties = { flex: `0 0 ${width}px`, width }
  return (
    <div
      className={styles.card}
      data-platform={platform}
      data-side={side}
      style={track}
    >
      {children}
    </div>
  )
}
