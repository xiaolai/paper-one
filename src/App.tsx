import { useCallback, useEffect, useMemo, useRef } from 'react'
import { buildCommands, PANE_SHORTCUTS } from './lib/commands'
import { ACCEPT_FORMATS } from './lib/formats'
import { applyMetrics } from './lib/metrics'
import { usePlatform, usePrefersDark } from './lib/platform'
import { useAppState } from './lib/state'
import { useBook } from './lib/useBook'
import { useLibrary } from './lib/useLibrary'
import { useMarks } from './lib/useMarks'
import { useMarking } from './lib/useMarking'
import { BOOKS, coverTint } from './data/fixtures'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
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
  const marking = useMarking(book, marks)
  const library = useLibrary()

  /* One file picker for the window. The reader's empty state, the palette and
   * the switcher all ask for books, and one input serves all three rather than
   * each surface growing its own. */
  const pickerRef = useRef<HTMLInputElement>(null)
  const addBooks = useCallback(() => pickerRef.current?.click(), [])

  useEffect(() => {
    applyMetrics(document.documentElement, platform)
  }, [platform])

  /* §05: the system follows the OS by default, with an explicit override in
   * Settings. Night is the dark surface; Paper is the light default. */
  useEffect(() => {
    if (!state.themeFollowsOs) return
    dispatch({ type: 'setTheme', theme: prefersDark ? 'night' : 'paper', fromOs: true })
  }, [prefersDark, state.themeFollowsOs, dispatch])

  /* Remember every book that opens, so the switcher lists what this reader has
   * actually read rather than a fixture shelf. Keyed on the metadata arriving,
   * because that is when there is a title worth showing. */
  const { bookId, meta, source } = book
  const { record } = library
  useEffect(() => {
    if (!bookId || !meta) return
    record({
      bookId,
      title: meta.title,
      author: meta.author,
      // A File cannot be reopened later — there is no path to keep — so only a
      // URL source records one. The switcher shows the difference.
      url: typeof source === 'string' ? source : null,
      lastOpened: Date.now(),
    })
  }, [bookId, meta, source, record])

  const commands = useMemo(
    () =>
      buildCommands({
        state,
        dispatch,
        hasBook: book.source !== null,
        // Null when nothing is selected, so the palette simply does not offer
        // a command that could not do anything.
        markSelection: marking.selection ? () => marking.mark('') : null,
        openBookPicker: addBooks,
        closeBook: () => book.close(),
        openSwitcher: () => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' }),
      }),
    [state, dispatch, book, marking, addBooks],
  )

  /* §11's keyboard map. Every combo the design publishes is bound here, and
   * nothing is bound to a layer that does not exist — ⌘K used to be left
   * deliberately unbound for exactly that reason, and now has a palette. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dispatch({ type: 'dismissTop' })
        return
      }

      const accel = event.metaKey || event.ctrlKey
      if (!accel) return

      if (event.key === 'k') {
        event.preventDefault()
        dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })
        return
      }
      if (event.key === '\\') {
        event.preventDefault()
        dispatch({ type: 'togglePane' })
        return
      }
      if (event.key === 'd') {
        // Only when there is a selection to mark; otherwise ⌘D stays the
        // browser's own, rather than being swallowed to do nothing.
        if (!marking.selection) return
        event.preventDefault()
        marking.mark('')
        return
      }
      const shortcut = PANE_SHORTCUTS.find((entry) => entry.digit === event.key)
      if (shortcut) {
        event.preventDefault()
        dispatch({ type: 'openPane', pane: shortcut.pane })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch, marking])

  /* Titlebar metadata comes from the OPEN book. It used to read BOOKS[0]
   * unconditionally, so every book — and the empty state — was presented as
   * Moby-Dick. The fixture is only a placeholder for when nothing is open. */
  const fixture = BOOKS[0]
  const title = book.meta?.title || (book.source ? 'Untitled' : (fixture?.title ?? 'Paper'))
  const subtitle = book.source
    ? book.position.chapterLabel || book.meta?.author || ''
    : (fixture?.locationLabel ?? '')

  return (
    <>
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
        overlays={
          <>
            {state.paletteOpen && (
              <CommandPalette
                commands={commands}
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'paletteOpen' })}
                /* The companion has no model configured, so an unmatched query
                 * goes to the panel that says so rather than being answered.
                 * §13 forbids producing content about the book that is not
                 * grounded in it. */
                onAsk={() => dispatch({ type: 'openPane', pane: 'companion' })}
              />
            )}
            {state.switcherOpen && (
              <BookSwitcher
                books={library.books}
                currentBookId={book.bookId}
                onOpen={(url) => {
                  dispatch({ type: 'closeLayer', layer: 'switcherOpen' })
                  book.open(url)
                }}
                onDismiss={() => dispatch({ type: 'closeLayer', layer: 'switcherOpen' })}
                onAddBooks={addBooks}
              />
            )}
          </>
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
          marking={marking}
          onAddBooks={addBooks}
        />
      </WindowShell>

      <input
        ref={pickerRef}
        type="file"
        accept={ACCEPT_FORMATS}
        hidden
        onChange={(event) => {
          const picked = event.target.files?.item(0)
          if (picked) book.open(picked)
          // Reset so picking the same file twice still fires a change.
          event.target.value = ''
        }}
      />
    </>
  )
}
