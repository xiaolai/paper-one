import { Component, type ReactNode } from 'react'
import type { PaneContext, PaneRenderer } from '../core/capability'
import { renderContribution } from './panes'
import styles from './screens/ContributedScreen.module.css'

/**
 * A capability's renderer, run where a fault cannot take the window with it.
 *
 * ⚠️ **A CAPABILITY'S RENDERER RUNS INSIDE THE KERNEL'S TREE.** One that throws
 * — a port that went away, a shape it did not expect — is an uncaught error
 * during render, and React's answer to that is to unmount everything up to
 * the nearest boundary. Without one, the reader loses the titlebar, the
 * library and the way back, for a fault in a panel they were merely looking
 * at. Every contributed renderer — a screen, a pane, a settings section, a
 * mark control — goes through these two: the BODY, so the renderer runs when
 * React renders it and not when the parent builds its JSX; the BOUNDARY, so
 * what it throws stops here.
 */
export class ContributionBoundary extends Component<
  { readonly label: string; readonly children: ReactNode; readonly resetKey?: string },
  { readonly failed: boolean }
> {
  // Stryker disable next-line ObjectLiteral: an absent `failed` reads as not failed, which is the same start.
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  /**
   * A NEW CONTRIBUTION STARTS FROM NOTHING. React reuses the instance when
   * the same element type stays in the same place, so switching from a pane
   * that threw straight to another kept showing the first one's failure —
   * the second was never asked to draw. The key names what is being drawn.
   */
  override componentDidUpdate(previous: { readonly resetKey?: string }) {
    // Stryker disable next-line LogicalOperator: clearing a failure that is not there changes nothing a reader can see.
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false })
  }

  override componentDidCatch(error: unknown) {
    /* Reported, not swallowed: the reader sees a line that says something is
       wrong, and whoever is debugging gets the stack. */
    console.error(`Paper: ${this.props.label} failed to draw`, error)
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return <p className={styles.failure}>{this.props.label} could not be drawn. Everything else still works.</p>
  }
}

/** The renderer, invoked as this element renders — inside the boundary above it. */
export function ContributionBody({ id, render, context }: { readonly id: string; readonly render: PaneRenderer; readonly context: PaneContext }) {
  return <>{renderContribution(id, render, context)}</>
}
