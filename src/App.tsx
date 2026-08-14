import { useEffect } from 'react'
import { applyMetrics } from './lib/metrics'
import { usePlatform, usePrefersDark } from './lib/platform'
import { useAppState } from './lib/state'
import { useBook } from './lib/useBook'
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
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })
        return
      }
      if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        dispatch({ type: 'togglePane' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])

  const fixture = BOOKS[0]

  return (
    <WindowShell
      state={state}
      platform={platform}
      titleBar={
        <TitleBar
          state={state}
          dispatch={dispatch}
          platform={platform}
          bookTitle={fixture?.title ?? 'Paper'}
          bookSubtitle={book.position.chapterLabel || (fixture?.locationLabel ?? '')}
          coverTint={coverTint(0)}
        />
      }
      pane={<SidePane state={state} dispatch={dispatch} book={book} />}
    >
      <Reader state={state} dispatch={dispatch} platform={platform} book={book} />
    </WindowShell>
  )
}
