import { Component, type ReactNode } from 'react'
import type { PaneRenderer } from '../../core/capability'
import type { Platform } from '../../core/metrics'
import { renderContribution } from '../panes'
import styles from './ContributedScreen.module.css'

/**
 * The page a capability's whole-window view is drawn in — WI-22.D3.
 *
 * ⚠️ **A CONTRIBUTED SCREEN HAD NO FRAME AT ALL, AND IT SHOWED.** It was
 * rendered as a bare fragment into normal flow: the content landed at the
 * bottom of the window as unstyled text, the reader stayed visible behind it,
 * and an empty pane sat beside it. Both of the kernel's own screens are
 * absolutely positioned over the window with a background; a screen that is not
 * is not a screen, it is loose text.
 *
 * ## Why the kernel draws this and not the capability
 *
 * A capability may reach the kernel only through its public entry, so it cannot
 * read `--titlebar-h`, does not know macOS overlays its traffic lights, and has
 * no way to learn the platform. Asking every capability to get window chrome
 * right is asking for one of them to get it wrong — and the one that does takes
 * the whole window with it. It contributes CONTENT; this puts it in a page.
 *
 * ## The heading is the kernel's too
 *
 * The label already exists on the contribution, and the reader needs to know
 * what they are looking at. Drawing it here means a capability cannot forget
 * one, and cannot title its page something other than the name on the control
 * that got them here.
 */

/**
 * The capability's own content, invoked BELOW the boundary.
 *
 * ⚠️ **THE INVOCATION HAS TO HAPPEN INSIDE A CHILD COMPONENT, NOT WHILE
 * BUILDING THE BOUNDARY'S `children`.** A boundary catches what throws while
 * REACT RENDERS its subtree. `renderContribution()` called in the parent's JSX
 * runs before the boundary element even exists, so the throw escapes to the
 * root and React unmounts the whole application — including the control that
 * would take the reader back out. Passing an ELEMENT defers the call to the
 * moment React renders this, which is inside.
 */
function ContributedBody({ id, render }: { readonly id: string; readonly render: PaneRenderer }) {
  return <>{renderContribution(id, render)}</>
}

/**
 * A screen that fails without taking the window with it.
 *
 * ⚠️ **A CAPABILITY'S RENDERER RUNS INSIDE THE KERNEL'S TREE.** One that throws
 * — a port that went away, a shape it did not expect — is an uncaught error
 * during root render, and React's answer to that is to unmount everything. The
 * reader loses the titlebar, the library, and the way back, for a fault in a
 * panel they were merely looking at.
 *
 * A class, because that is the only thing React lets catch a render error.
 */
class ScreenBoundary extends Component<
  { readonly label: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown) {
    /* Reported, not swallowed: the reader sees a screen that says something is
       wrong, and whoever is debugging gets the stack. */
    console.error('Paper: a contributed screen failed to draw', error)
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <p className={styles.failure}>
        {this.props.label} could not be drawn. Everything else still works —
        switch away and back to try again.
      </p>
    )
  }
}

export interface ContributedScreenProps {
  readonly label: string
  readonly platform: Platform
  readonly id: string
  /** Absent when no composition offers this screen — see the render below. */
  readonly render?: PaneRenderer
}

export function ContributedScreen({ label, platform, id, render }: ContributedScreenProps) {
  return (
    <div className={styles.screen} data-platform={platform}>
      <div className={styles.body}>
        <div className={styles.column}>
          {/* OUTSIDE the boundary, so the heading and the way back survive a
              renderer that throws. */}
          <h1 className={styles.title}>{label}</h1>
          <ScreenBoundary label={label}>
            {render === undefined ? (
              <p className={styles.failure}>
                That screen belongs to something this copy of Paper is not running.
              </p>
            ) : (
              <ContributedBody id={id} render={render} />
            )}
          </ScreenBoundary>
        </div>
      </div>
    </div>
  )
}
