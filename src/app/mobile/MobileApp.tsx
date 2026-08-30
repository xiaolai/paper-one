import { useMemo, useState, useSyncExternalStore } from 'react'
import {
  Cards,
  Library,
  coverIn,
  resolvePlatform,
  tauriVaultFs,
  useAppPalette,
  useCards,
  useLibrary,
  usePrefersDark,
} from '../../kernel/ui/mobile'
import {
  KERNEL_SETTINGS,
  type Composition,
  type IndexedBook,
  type KernelServices,
} from '../../kernel'
import { TabBar, type Tab } from '../shell/TabBar'
import { ContinueStrip } from '../shell/ContinueStrip'
import { ReadingSettings } from './ReadingSettings'
import styles from '../shell/shell.module.css'

/**
 * THE PHONE'S SHELL — the mobile design, over this device's own library.
 *
 * `dev-docs/design/Paper Mobile.dc.html`: "Designed separately from desktop,
 * sharing only the design system and the reading core. Adjacency becomes
 * sequence: the side pane becomes a sheet, the companion column becomes a
 * sheet, the titlebar chip becomes a tab."
 *
 * ## What this shares, and with whom
 *
 * The furniture is `src/app/shell/` — the tab bar and the Continue strip —
 * which the BROWSER client mounts too. That directory is where the design was
 * first built, inside `src/app/web/`, and it moved up rather than being
 * written a second time here.
 *
 * What differs is entirely the data behind it. The browser client reaches a
 * shelf over a WebSocket and is granted reads plus `book.position`; this shell
 * holds the real services the launch built, on the device's own disk, and may
 * write. So: same components, different wiring, and no branch inside either.
 *
 * ## Why the desktop `Library` and not a phone-shaped copy
 *
 * Because the design asks for a list of books at a phone's width, not for a
 * different list. `Library` already carries search, tag chips, sort, the row
 * menu and the virtualiser that makes 1,961 rows scroll; a second
 * implementation would begin by being simpler and end by being those things
 * again, minus the fixes. The phone-specific part — the Continue strip above
 * it — is a component of its own, which is exactly the seam the mockup draws.
 */
export interface MobileAppProps {
  readonly services: KernelServices
  /** The shelf could not be READ, which is not the same as having no books. */
  readonly shelfUnread: boolean
  /** What composed, so the settings screen can draw what capabilities contribute. */
  readonly composition: Composition
}

/**
 * This device's jackets, bound once.
 *
 * ⚠️ **MODULE SCOPE, NOT AN INLINE ARROW** — the same rule, and the same
 * reason, as `desktopCovers` in `App.tsx`. `BookCover` lists `coverFor` in its
 * effect's dependencies (it has to, or it captures the first one forever), so
 * a fresh identity per render means a refetch and a revoked object URL for
 * every visible row on every render.
 */
const deviceCovers = (bookId: string) => coverIn(tauriVaultFs, bookId)

/** How many books the Continue strip offers. Three, from the mockup. */
const CONTINUE = 3

/**
 * The books to offer picking up again: most recently read first, and only ones
 * actually started.
 *
 * `finished` books are excluded rather than sorted last. A strip called
 * Continue that offers a book you have finished is offering the wrong verb,
 * and the shelf below is where a finished book is found again.
 */
export function continueReading(
  books: readonly IndexedBook[],
  limit = CONTINUE,
): readonly IndexedBook[] {
  return books
    .filter(
      (book) =>
        book.finished !== true &&
        (book.progress ?? 0) > 0 &&
        book.openedAt !== undefined,
    )
    /* SAFE TO SORT IN PLACE, because `.filter` above already returned a new
       array — `library.books` is the shelf's own snapshot, and reordering it
       would silently re-sort the Library screen below the strip. This had a
       redundant `.slice()` here guarding against that, and a comment claiming
       the slice was what made it safe; mutation testing removed the slice and
       every case still passed, which is how the comment was found to be
       describing the wrong mechanism. */
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    .slice(0, limit)
}

export function MobileApp({
  services,
  shelfUnread,
  composition,
}: MobileAppProps) {
  const [tab, setTab] = useState<Tab>('library')
  const [query, setQuery] = useState('')
  const library = useLibrary(services.library)
  const cards = useCards(services.cards)
  const platform = useMemo(resolvePlatform, [])

  /* THE SETTINGS ARE READ THROUGH THE STORE, NOT COPIED INTO STATE. The store
     is already an external store with a snapshot; a second copy here would be
     a second source of truth for the same values, and the settings screen
     writes to the first one. */
  const settings = services.settings
  useSyncExternalStore(settings.subscribe, settings.getSnapshot)

  const prefersDark = usePrefersDark()
  const theme = settings.get(KERNEL_SETTINGS.themeFollowsOs)
    ? prefersDark
      ? 'night'
      : 'paper'
    : settings.get(KERNEL_SETTINGS.theme)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useAppPalette(
    host,
    theme,
    settings.get(KERNEL_SETTINGS.brightness),
    settings.get(KERNEL_SETTINGS.contrast),
  )

  const recent = useMemo(() => continueReading(library.books), [library.books])

  /* NOTHING OPENS A BOOK YET, and the tab bar is told so rather than being
     given a handler that does nothing. `TabBar` already redirects Reading to
     Library when there is no book to return to — a tab that opens an empty
     reader is a tab that does nothing — so the reader landing is what turns
     that tab on, in the change that mounts it. */
  const reading = null

  return (
    <div className={styles.shell} ref={setHost} data-theme={theme}>
      {tab === 'library' && (
        <div className={styles.stage}>
          {recent.length > 0 && (
            <ContinueStrip
              books={recent}
              onOpen={() => {}}
              coverFor={deviceCovers}
            />
          )}
          {/* THE SHELF GETS A POSITIONED BOX OF ITS OWN, which the Continue
              strip does not sit inside — `Library` is `position: absolute;
              inset: 0`, so without this it covers the strip above it. */}
          <div className={styles.stageList}>
            <Library
              books={library.books}
              coverFor={deviceCovers}
              platform={platform}
              shelfUnread={shelfUnread}
              onOpen={() => {}}
              libraryQuery={query}
              onQueryChange={setQuery}
              /* NOTHING IMPORTS OR ENRICHES ON A PHONE YET — the honest values
                 rather than a spinner that never turns. `onAddBooks` is absent
                 for the same reason: the screen draws no control it cannot
                 act on. */
              importing={null}
              enriching={0}
              importNotice={null}
              bookActions={[]}
              bookStatuses={[]}
            />
          </div>
        </div>
      )}
      {tab === 'cards' && (
        <div className={`${styles.stage} ${styles.screen}`}>
          <h1 className={styles.screenTitle}>Cards</h1>
          <Cards
            cards={{
              all: cards.all,
              persistent: cards.persistent,
              discard: cards.discard,
            }}
            bookId={null}
          />
        </div>
      )}
      {tab === 'you' && (
        <div className={`${styles.stage} ${styles.screen}`}>
          <h1 className={styles.screenTitle}>You</h1>
          <ReadingSettings
            settings={settings}
            sections={composition.settings}
          />
        </div>
      )}
      <TabBar active={tab} onSelect={setTab} hasBook={reading !== null} />
    </div>
  )
}
