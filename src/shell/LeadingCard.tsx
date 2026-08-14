import type { CSSProperties, ReactNode } from 'react'
import type { Platform } from '../lib/metrics'
import styles from './LeadingCard.module.css'

export interface LeadingCardProps {
  platform: Platform
  /** Fixed track width — 340 for the aside, per §03. */
  width: number
  children: ReactNode
}

export function LeadingCard({ platform, width, children }: LeadingCardProps) {
  const track: CSSProperties = { flex: `0 0 ${width}px`, width }
  return (
    <div className={styles.card} data-platform={platform} style={track}>
      {children}
    </div>
  )
}
