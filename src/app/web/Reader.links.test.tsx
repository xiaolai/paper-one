// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Reader } from './Reader'
import type { ContentFacts, RemoteContent } from './content'
import { readingPositions, type PositionStore } from './positions'

/**
 * WHAT A BOOK'S LINK MAY DO TO THE BROWSER CLIENT.
 *
 * ## Why this is its own file
 *
 * The only way to reach the handler is to hold the props `Reader` hands the
 * renderer, and that means mocking `FoliateView`. `Reader.test.tsx` needs the
 * real one — its cases are about which SOURCE a book opens through — and
 * `vi.mock` applies to the whole module, so the two cannot share a file.
 *
 * ## The defect
 *
 * `onExternalLink` was `ignore`: `useCallback(() => {}, [])`. foliate treats an
 * `external-link` event nobody cancelled as permission and runs
 * `globalThis.open(href_, '_blank')`. `epub.js` calls a link external when its
 * scheme is anything but `blob:` (`/^(?!blob)\w+:/i`), so `javascript:` and
 * `data:` reach that line exactly like `https:` does — and an EPUB is a zip a
 * stranger wrote.
 *
 * The desktop reader has cancelled this event and consulted `externalTarget`
 * since `open_external` was written. This surface shipped without it, and
 * nothing went red, because no test held the handler.
 */

const view = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }))

vi.mock('../../kernel/ui/browser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  /* Captures the props and paints nothing. The reader's own markup is what the
     other suites assert on; this one only wants the callback. */
  FoliateView: (props: Record<string, unknown>) => {
    view.props = props
    return null
  },
}))

/* pdf.js reads `DOMMatrix` at module scope and jsdom does not implement it.
 * Nothing here paints, so the stub only has to exist. */
const globals = globalThis as { DOMMatrix?: unknown }
globals.DOMMatrix ??= class {}

/** Say what the operating system's colour scheme is, as jsdom cannot. */
function osPrefersDark(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: dark && query.includes('prefers-color-scheme: dark'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  cleanup()
  view.props = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('style')
  window.localStorage?.clear()
})

function shelf() {
  return {
    locate: async (): Promise<ContentFacts> => ({ here: true, ext: 'epub', size: 10, contentHash: null }),
    readRange: async () => new Uint8Array(0),
    fileOf: async (_book: string, name: string) => new File(['PK'], name),
  } as unknown as RemoteContent
}

/** Positions over a store the test owns, so no browser storage is touched. */
function fakePositions() {
  let held: string | null = null
  const store: PositionStore = { getItem: () => held, setItem: (_k, v) => void (held = v) }
  return readingPositions(store, () => 1)
}

/** Render, then wait until the renderer has been handed its props. */
async function handler() {
  render(
    <Reader
      content={shelf()}
      bookId="one"
      name="Moby-Dick"
      onClose={vi.fn()}
      positions={fakePositions()}
    />,
  )
  await waitFor(() => expect(view.props).not.toBeNull())
  const onExternalLink = view.props?.onExternalLink
  expect(typeof onExternalLink).toBe('function')
  return onExternalLink as (detail: { href_: string }, event: Event) => void
}

/** An event that records whether the reader cancelled it. */
function linkEvent() {
  const event = new Event('external-link', { cancelable: true })
  const preventDefault = vi.spyOn(event, 'preventDefault')
  return { event, preventDefault }
}

describe('a link that leaves the book', () => {
  /**
   * THE CANCEL IS THE WHOLE DEFENCE, and it has to happen on every path.
   *
   * foliate's fallback runs when the event comes back uncancelled. A handler
   * that inspects the href and returns early without cancelling is the same bug
   * as one that does nothing — which is why this asserts the cancel for the
   * refused schemes too, not only for the allowed one.
   */
  it('cancels foliate\'s fallback before deciding anything', async () => {
    vi.spyOn(globalThis, 'open').mockReturnValue(null)
    const onExternalLink = await handler()
    for (const href of ['https://example.org/', 'javascript:alert(1)', 'not a url']) {
      const { event, preventDefault } = linkEvent()
      onExternalLink({ href_: href }, event)
      expect(preventDefault, `${href} must be cancelled`).toHaveBeenCalled()
    }
  })

  /* THE CANCEL IS ASSERTED HERE TOO, and not out of thoroughness. `open` is
     never called by the old `ignore` handler either — foliate is what would
     have called it, and the mocked renderer is not foliate. So "did not open"
     alone passes for a handler that does nothing at all, which is the exact bug.
     Cancelling is what separates refusing a link from ignoring one. */
  it('refuses every scheme but http and https, cancelling rather than ignoring', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
    const onExternalLink = await handler()
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'file:///etc/passwd',
      'mailto:someone@example.org',
      'blob:https://example.org/abc',
    ]) {
      const { event, preventDefault } = linkEvent()
      onExternalLink({ href_: href }, event)
      expect(preventDefault, `${href} must be cancelled, not merely unopened`).toHaveBeenCalled()
    }
    expect(open, 'a refused scheme must never reach the platform').not.toHaveBeenCalled()
  })

  /**
   * `noopener` IS NOT DECORATION. Without it the opened tab receives
   * `window.opener` and can navigate this one — the signed-in shelf replaced by
   * a page of the book's choosing, which is the whole of tabnabbing.
   */
  it('opens an allowed link with noopener and noreferrer', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
    const onExternalLink = await handler()
    const { event } = linkEvent()
    onExternalLink({ href_: 'https://example.org/citation' }, event)
    expect(open).toHaveBeenCalledWith(
      'https://example.org/citation',
      '_blank',
      'noopener,noreferrer',
    )
  })
})

/**
 * "FOLLOW SYSTEM APPEARANCE" HAS TO FOLLOW SOMETHING.
 *
 * `themeFollowsOs` is on by default (design system §05). It was read out of the
 * settings store, handed to the `Settings` pane so the row could draw its own
 * state, and consulted nowhere else — nothing on this client subscribed to
 * `prefers-color-scheme`. So a reader whose system is dark opened a white book,
 * with the setting that should have prevented it already switched on, and no
 * way to work out why.
 *
 * The RENDERER'S `theme` prop is the assertion, not the applied palette:
 * `useAppPalette` reads its colours from `tokens.css` through
 * `getComputedStyle`, and jsdom loads no stylesheets, so every theme measures
 * as empty there. The prop is what the book is actually coloured from.
 */
describe('following the system appearance', () => {
  const themeOf = () => view.props?.['theme']

  it('opens Night on a dark system and Paper on a light one', async () => {
    osPrefersDark(true)
    await handler()
    expect(themeOf()).toBe('night')

    cleanup()
    view.props = null
    osPrefersDark(false)
    await handler()
    expect(themeOf()).toBe('paper')
  })
})
