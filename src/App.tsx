import { useEffect } from 'react'
import { applyMetrics } from './lib/metrics'
import { usePlatform, usePrefersDark } from './lib/platform'
import { useAppState } from './lib/state'
import { useBook } from './lib/useBook'
import { useMarks } from './lib/useMarks'
import { BOOKS, coverTint } from './data/fixtures'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Reader } from './screens/Reader'
import { SidePane } from './pane/SidePane'

export function App() {
  const platform = usePlatform()
  const prefersDark = usePrefersDark()
  const [state, dispatch] = useAppState()
  /* The open book lives here, not in the reader: Contents and Companion read
   * from it and they are panels of the side pane now. */
  const book = useBook()
  /* Marks outlive the open book — the Notes panel browses every book's — so the
   * store is keyed by book rather than owned by one. */
  const marks = useMarks(book.bookId)

  useEffect(() => {
    applyMetrics(document.documentElement, platform)
  }, [platform])

  /* §05: the system follows the OS by default, with an explicit override in
   * Settings. Night is the dark surface; Paper is the light default. */
  useEffect(() => {
    if (!state.themeFollowsOs) return
    dispatch({ type: 'setTheme', theme: prefersDark ? 'night' : 'paper', fromOs: true })
  }, [prefersDark, state.themeFollowsOs, dispatch])

  /* §11 keyboard map. Esc peels one layer rather than clearing the stack. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'dismissTop' })
        return
      }
      // ⌘K is deliberately unbound until the command palette exists. Binding
      // it to a layer nothing renders swallowed the shortcut silently.
      if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        dispatch({ type: 'togglePane' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

  /* Titlebar metadata comes from the OPEN book. It used to read BOOKS[0]
   * unconditionally, so every book — and the empty state — was presented as
   * Moby-Dick. The fixture is only a placeholder for when nothing is open. */
  const fixture = BOOKS[0]
  const title = book.meta?.title || (book.source ? 'Untitled' : (fixture?.title ?? 'Paper'))
  const subtitle = book.source
    ? book.position.chapterLabel || book.meta?.author || ''
    : (fixture?.locationLabel ?? '')

  return (
    <WindowShell
      state={state}
      platform={platform}
      titleBar={
        <TitleBar
          state={state}
          dispatch={dispatch}
          platform={platform}
          bookTitle={title}
          bookSubtitle={subtitle}
          coverTint={book.source ? 'var(--tint-b)' : coverTint(0)}
        />
      }
      pane={
        <SidePane
          state={state}
          dispatch={dispatch}
          book={book}
          marks={marks}
          onGoTo={book.goTo}
        />
      }
    >
      <Reader
        state={state}
        dispatch={dispatch}
        platform={platform}
        book={book}
        marks={marks}
      />
    </WindowShell>
  )
}
