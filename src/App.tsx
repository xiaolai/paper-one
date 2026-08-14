import { useCallback, useEffect, useMemo, useRef } from 'react'
import { buildCommands } from './lib/commands'
import { PANE_SHORTCUTS } from './lib/panes'
import { ACCEPT_FORMATS } from './lib/formats'
import { applyMetrics } from './lib/metrics'
import { usePlatform, usePrefersDark } from './lib/platform'
import { NOT_CONFIGURED } from './lib/companion'
import { hasOpenLayer, useAppState } from './lib/state'
import { useBook } from './lib/useBook'
import { useFileDrop } from './lib/useFileDrop'
import { useLibrary } from './lib/useLibrary'
import { useCards } from './lib/useCards'
import { useMarks } from './lib/useMarks'
import { useMarking } from './lib/useMarking'
import { coverTint, coverTintFor } from './data/fixtures'
import { BookSwitcher } from './overlays/BookSwitcher'
import { CommandPalette } from './overlays/CommandPalette'
import { TitleBar } from './shell/TitleBar'
import { WindowShell } from './shell/WindowShell'
import { Library } from './screens/Library'
import { Reader } from './screens/Reader'
import { SidePane } from './pane/SidePane'
import { useSpeech } from './reader/useSpeech'

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
  const cards = useCards()
  const marking = useMarking(book, marks)
  const library = useLibrary()
  /* Reading aloud follows the spine document: an utterance outlives a section,
   * and would otherwise go on reading words that are no longer on screen. */
  const speech = useSpeech(book.doc)

  /* One file picker for the window. The reader's empty state, the palette and
   * the switcher all ask for books, and one input serves all three rather than
   * each surface growing its own. */
  const pickerRef = useRef<HTMLInputElement>(null)
  const addBooks = useCallback(() => pickerRef.current?.click(), [])

  /**
   * Open a book AND go to it.
   *
   * Every route in — a drop on the window, the switcher, the picker, a cover on
   * the shelf — goes through here. Only the shelf used to switch screens, so a
   * book opened any other way loaded into a reader the library was still
   * covering: the shelf sat there unchanged while the book it had been asked
   * for finished loading out of sight, which reads as the click having done
   * nothing at all.
   */
  const openBook = useCallback(
    (source: File | string) => {
      dispatch({ type: 'goScreen', screen: 'reader' })
      book.open(source)
    },
    [book, dispatch],
  )

  /* Window-wide, not just over the empty state. A file dropped anywhere the
   * app does not intercept NAVIGATES the webview to it — the interface is
   * replaced by WebKit's PDF viewer with no error and no way back. */
  const { dragging } = useFileDrop(openBook)

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

      const overlayOpen = hasOpenLayer(state)

      /* Typing comes first. The search field, a note, and the palette all take
       * arrow keys and a space bar, and turning the page underneath someone
       * mid-word is worse than not binding the key at all. */
      const target = event.target as HTMLElement | null
      const typing =
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'

      /* The accelerator is ⌘ on macOS and Ctrl elsewhere — not either, anywhere.
       *
       * Accepting both meant Control-D, Control-K and Control-\ were swallowed
       * on macOS, where they are the system's own text-editing keys: Control-D
       * deletes forward and Control-K kills to end of line, in every text field
       * in the app. It also meant the combos the palette PRINTS were wrong on
       * one platform or the other, since those always read ⌘. */
      const accel = platform === 'macos' ? event.metaKey : event.ctrlKey

      /* Reading keys belong to the reader.
       *
       * Guarded on the screen and on the modal layers, because the reader stays
       * MOUNTED under the library and under every overlay — see the note at its
       * render. Without the guard, an arrow key pressed while browsing the
       * shelf, or with the palette open, turned pages in a book nobody could
       * see, and the reader came back to a different place than they left. */
      const reading = state.screen !== 'library' && !overlayOpen

      /* §11: ← → turn the page. Unbound until now, which went unnoticed
       * because a scrolled EPUB scrolls — but a fixed-layout book, which is
       * every PDF, does not scroll at all. These were its only way through and
       * it had none, so it opened on one page and stayed there. */
      if (!accel && !typing && reading) {
        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault()
          book.next()
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault()
          book.prev()
          return
        }

        /* §11: Space turns the page in a paginated book.
         *
         * Only there. In scrolled flow with the ruler on, Space belongs to the
         * ruler, which pins it and advances a line — see `ReadingRuler`, which
         * has already had its say by the time this runs and marks the event
         * handled. With the ruler off, Space is the scroll the reader expects
         * and nothing here should take it. */
        if ((event.key === ' ' || event.code === 'Space') && !event.defaultPrevented) {
          if (state.pageLayout !== 'paginated') return
          event.preventDefault()
          if (event.shiftKey) book.prev()
          else book.next()
          return
        }
      }

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
  }, [
    dispatch,
    marking,
    book,
    platform,
    state.screen,
    state.pageLayout,
    state.paletteOpen,
    state.switcherOpen,
  ])

  /* Titlebar metadata comes from the OPEN book, and from nothing else.
   *
   * It used to read BOOKS[0] unconditionally, so every book was presented as
   * Moby-Dick; that was fixed for the open case and left in place for the
   * empty one, where it was the same lie in a quieter voice — the titlebar
   * named a book with a chapter position while the window behind it said the
   * library was empty. With nothing open the chip says so. */
  const title = book.meta?.title || (book.source ? 'Untitled' : 'Paper')
  const subtitle = book.source ? book.position.chapterLabel || book.meta?.author || '' : ''

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
            // The same tint the shelf gives this book, so the chip and the cover agree.
            coverTint={book.bookId ? coverTintFor(book.bookId) : coverTint(0)}
            speech={speech}
            hasBook={book.source !== null}
          />
        }
        overlays={
          <>
            {state.paletteOpen && (
              <CommandPalette
                commands={commands}
                platform={platform}
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
                  openBook(url)
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
            cards={cards}
            onGoTo={book.goTo}
            onDeleteMark={marking.unmark}
            markFocus={marking.focus}
            /* The one place the app decides what the companion is. There is no
               provider in this build — see `lib/companion` — and this is the
               line that changes when there is. */
            companion={NOT_CONFIGURED}
            onAddBooks={addBooks}
          />
        }
      >
        {/* The reader stays mounted under every screen. Unmounting it tears
            foliate down mid-flight and loses the reading position — see the
            note on Library's own stacking. */}
        <Reader
          state={state}
          dispatch={dispatch}
          platform={platform}
          book={book}
          marks={marks}
          marking={marking}
          onAddBooks={addBooks}
          dragging={dragging}
          inert={state.screen === 'library'}
        />

        {state.screen === 'library' && (
          <Library
            books={library.books}
            platform={platform}
            // Opening from the library takes you to what you opened. Staying
            // on the shelf with a book loading behind it is the one thing a
            // reader does not want from a click on a cover.
            onOpen={openBook}
            onAddBooks={addBooks}
          />
        )}
      </WindowShell>

      <input
        ref={pickerRef}
        type="file"
        accept={ACCEPT_FORMATS}
        hidden
        onChange={(event) => {
          const picked = event.target.files?.item(0)
          if (picked) openBook(picked)
          // Reset so picking the same file twice still fires a change.
          event.target.value = ''
        }}
      />
    </>
  )
}
