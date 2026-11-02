// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Capability } from '../../kernel'
import styles from '../shell/shell.module.css'
import { bookActionsOf, mountWebClient } from './client'
import type { LinkState } from './reconnect'
import type { SessionState, SignOutResult } from './session'

/**
 * WHAT THE BROWSER CLIENT HANDS EVERYTHING IT MOUNTS.
 *
 * `client.test.tsx` mounts it over its real modules and a stubbed network, which
 * proves it comes up. This file stands every neighbour in — the session check,
 * the link, the stores, the shelf screen, the reader, the tabs — because each has
 * a suite of its own, and what is left is exactly this module's job: which screen
 * a state draws, what each screen is handed, and what is let go on the way out.
 *
 * The client mounts under `StrictMode`, as it does in a browser, so an effect
 * runs, is cleaned up and runs again: there are two links in `world.links` after
 * the first paint, and the last is the live one.
 */

interface FakeLink {
  readonly getSnapshot: () => LinkState
  readonly subscribe: (listener: () => void) => () => void
  readonly onOpened: (fn: (channel: unknown) => void) => () => void
  readonly retryNow: ReturnType<typeof vi.fn>
  readonly close: ReturnType<typeof vi.fn>
  readonly listeners: Set<() => void>
  readonly opened: Set<(channel: unknown) => void>
  /** Move the link to `next`, telling whoever subscribed. */
  readonly become: (next: LinkState) => void
}

interface FakeBooks {
  readonly getSnapshot: () => readonly { readonly bookId: string; readonly title: string }[]
  readonly subscribe: (listener: () => void) => () => void
  readonly status: () => string
  readonly reason: () => string | null
  readonly refresh: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly listeners: Set<() => void>
  /** Change what the store holds, telling whoever subscribed. */
  readonly become: (next: { rows?: readonly { readonly bookId: string; readonly title: string }[]; status?: string; reason?: string | null }) => void
}

const OPEN: LinkState = { kind: 'open', generation: 1 }

const world = vi.hoisted(() => ({
  /** What the next session check answers, and every check still unanswered. */
  session: [] as { resolve: (state: unknown) => void; state: unknown }[],
  checks: 0,
  signOut: { kind: 'signed-out' } as unknown,
  signOuts: 0,
  /** What the next link opens as. */
  firstState: { kind: 'connecting', attempt: 1 } as unknown,
  links: [] as unknown[],
  linkOptions: [] as { connect: () => unknown }[],
  connected: [] as unknown[],
  books: null as unknown,
  booksOver: [] as unknown[],
  contentOver: [] as unknown[],
  remote: null as unknown,
  remoteOver: [] as unknown[],
  coversOver: [] as unknown[],
  searchesOver: [] as unknown[],
  storesOver: [] as unknown[],
  stores: { marks: { name: 'marks' }, cards: null, cardRows: [] } as unknown,
  settings: [] as unknown[],
  /** Each start-up step that leaves a trace, and the titlebar height published by then. */
  startup: [] as (readonly [step: string, titlebar: string])[],
  drawn: new Map<string, Record<string, unknown>>(),
  readerMounts: 0,
}))

function drew(name: string): Record<string, unknown> {
  const props = world.drawn.get(name)
  if (props === undefined) throw new Error(`${name} was not drawn`)
  return props
}

/* The real root, with the call to `render` written down. React renders later, off
   a scheduler, so nothing the first render does could say when that call was made. */
vi.mock('react-dom/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-dom/client')>()
  return {
    ...real,
    createRoot: (...args: Parameters<typeof real.createRoot>) => {
      const created = real.createRoot(...args)
      return {
        render: (children: ReactNode) => {
          world.startup.push(['render', document.documentElement.style.getPropertyValue('--titlebar-h')])
          created.render(children)
        },
        unmount: () => created.unmount(),
      }
    },
  }
})
vi.mock('./session', () => ({
  checkSession: () => {
    world.checks += 1
    return new Promise((resolve) => {
      world.session.push({ resolve, state: null })
    })
  },
  signOut: async () => {
    world.signOuts += 1
    return world.signOut
  },
}))
vi.mock('./channel', () => ({
  connect: (options: unknown) => {
    world.connected.push(options)
    return { name: 'a channel' }
  },
  socketUrl: (location: { readonly href: string }) => `socket of ${location.href}`,
}))
vi.mock('./reconnect', () => ({
  openLink: (options: { connect: () => unknown }) => {
    world.linkOptions.push(options)
    let state = world.firstState as LinkState
    const listeners = new Set<() => void>()
    const opened = new Set<(channel: unknown) => void>()
    const link: FakeLink = {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onOpened: (fn) => {
        opened.add(fn)
        return () => opened.delete(fn)
      },
      retryNow: vi.fn(),
      close: vi.fn(),
      listeners,
      opened,
      become: (next) => {
        state = next
        if (next.kind === 'open') for (const fn of opened) fn(link)
        for (const listener of listeners) listener()
      },
    }
    world.links.push(link)
    return link
  },
}))
vi.mock('./books', () => ({
  createRemoteBooks: (link: unknown) => {
    world.booksOver.push(link)
    return world.books
  },
  asIndexedBook: (row: { readonly bookId: string; readonly title: string }) => ({ ...row, indexed: true }),
}))
vi.mock('./content', () => ({
  remoteContent: (link: unknown) => {
    world.contentOver.push(link)
    return { name: 'content' }
  },
}))
vi.mock('./remotePositions', () => ({
  remotePositions: (link: unknown) => {
    world.remoteOver.push(link)
    return world.remote
  },
}))
vi.mock('./covers', () => ({
  remoteCovers: (link: unknown) => {
    world.coversOver.push(link)
    return COVERS
  },
}))
vi.mock('./passages', () => ({
  searchPassages: (link: unknown) => {
    world.searchesOver.push(link)
    return SEARCH
  },
}))
vi.mock('./useRemoteStores', () => ({
  useRemoteStores: (link: unknown) => {
    world.storesOver.push(link)
    return world.stores
  },
}))
vi.mock('./settings', () => ({
  browserSettings: () => {
    const store = { name: `settings ${world.settings.length}` }
    world.settings.push(store)
    return store
  },
}))
vi.mock('./PairScreen', () => ({
  PairScreen: (props: Record<string, unknown>) => {
    world.drawn.set('PairScreen', props)
    return <div data-stub="PairScreen" />
  },
}))
vi.mock('./SettingsScreen', () => ({
  SettingsScreen: (props: Record<string, unknown>) => {
    world.drawn.set('SettingsScreen', props)
    return <div data-stub="SettingsScreen" />
  },
}))
vi.mock('./Reader', async () => {
  const { useEffect } = await import('react')
  return {
    Reader: (props: Record<string, unknown>) => {
      world.drawn.set('Reader', props)
      useEffect(() => {
        world.readerMounts += 1
      }, [])
      return <div data-stub="Reader" />
    },
  }
})
vi.mock('../shell/TabBar', () => ({
  TabBar: (props: Record<string, unknown>) => {
    world.drawn.set('TabBar', props)
    return <div data-stub="TabBar" />
  },
}))
vi.mock('../shell/ContinueStrip', () => ({
  ContinueStrip: (props: Record<string, unknown>) => {
    world.drawn.set('ContinueStrip', props)
    return <div data-stub="ContinueStrip" />
  },
}))
vi.mock('../../kernel/ui/browser', () => ({
  Library: (props: Record<string, unknown>) => {
    world.drawn.set('Library', props)
    return <div data-stub="Library" />
  },
  Cards: (props: Record<string, unknown>) => {
    world.drawn.set('Cards', props)
    return <div data-stub="Cards" />
  },
  installFatalHandlers: () => {
    world.startup.push(['fatal handlers', document.documentElement.style.getPropertyValue('--titlebar-h')])
  },
}))

const COVERS = vi.hoisted(() => ({ name: 'covers' }))
const SEARCH = vi.hoisted(() => ({ name: 'search' }))

const ROWS = [
  { bookId: 'a', title: 'First' },
  { bookId: 'b', title: '' },
]

function fakeBooks(): FakeBooks {
  let rows: readonly { readonly bookId: string; readonly title: string }[] = ROWS
  let status = 'ready'
  let reason: string | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => rows,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    status: () => status,
    reason: () => reason,
    refresh: vi.fn(async () => {}),
    dispose: vi.fn(),
    listeners,
    become: (next) => {
      rows = next.rows ?? rows
      status = next.status ?? status
      reason = next.reason === undefined ? reason : next.reason
      for (const listener of listeners) listener()
    },
  }
}

let root: Root | null = null
let books: FakeBooks
let remote: { dispose: ReturnType<typeof vi.fn> }

const liveLink = (): FakeLink => world.links.at(-1) as FakeLink

function page(): HTMLElement {
  const host = document.getElementById('root')
  if (host === null) throw new Error('no #root')
  return host
}

const shown = (name: string): boolean => page().querySelector(`[data-stub="${name}"]`) !== null

const words = (): string => String(page().textContent)

const buttonNamed = (name: string): HTMLButtonElement => {
  const found = [...page().querySelectorAll('button')].find((button) => button.textContent === name)
  if (found === undefined) throw new Error(`no button named ${name} in: ${words()}`)
  return found
}

async function mount(capabilities: readonly Capability[] = []): Promise<void> {
  await act(async () => {
    root = mountWebClient(capabilities)
  })
}

/** Answer the session check that has waited longest. */
async function answer(state: SessionState): Promise<void> {
  const next = world.session.shift()
  if (next === undefined) throw new Error('no session check is waiting')
  await act(async () => {
    next.resolve(state)
  })
}

/** Mount, and answer every check StrictMode asked with `state`. */
async function mountAs(state: SessionState): Promise<void> {
  await mount()
  while (world.session.length > 0) await answer(state)
}

/** Connected, and the link's first channel open: the shelf on screen. */
async function atTheShelf(): Promise<void> {
  world.firstState = OPEN
  await mountAs({ kind: 'connected' })
}

const during = (work: () => unknown): Promise<void> =>
  act(async () => {
    await work()
  })

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.body.innerHTML = '<div id="root"></div>'
  document.documentElement.removeAttribute('style')
  books = fakeBooks()
  remote = { dispose: vi.fn() }
  Object.assign(world, {
    session: [],
    checks: 0,
    signOut: { kind: 'signed-out' },
    signOuts: 0,
    firstState: { kind: 'connecting', attempt: 1 },
    links: [],
    linkOptions: [],
    connected: [],
    books,
    booksOver: [],
    contentOver: [],
    remote,
    remoteOver: [],
    coversOver: [],
    searchesOver: [],
    storesOver: [],
    stores: { marks: { name: 'marks' }, cards: null, cardRows: [] },
    settings: [],
    startup: [],
    drawn: new Map(),
    readerMounts: 0,
  })
})

afterEach(async () => {
  if (root !== null) {
    const mounted = root
    root = null
    await act(async () => mounted.unmount())
  }
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('what a mount does first', () => {
  it('derives a composition’s row-menu entries from each capability that has any', () => {
    const one = { id: 'one' }
    const two = { id: 'two' }
    const three = { id: 'three' }
    expect(
      bookActionsOf([{ bookActions: [one] }, {}, { bookActions: [two, three] }] as unknown as readonly Pick<Capability, 'bookActions'>[]),
    ).toEqual([one, two, three])
  })

  /* THE GUARD: a capability added to `composition.web.ts` throws here rather than
     being silently ignored, which is the failure that takes an afternoon to find. */
  it.each([
    { named: 1, list: [{ id: 'one' }] },
    { named: 2, list: [{ id: 'one' }, { id: 'two' }] },
  ])('refuses a composition of $named, which it does not know how to compose', ({ named, list }) => {
    expect(() => mountWebClient(list as unknown as readonly Capability[])).toThrow(
      new Error(
        `Paper: composition.web.ts names ${named} capability/capabilities and this entry does not compose any. Wire composeCapabilities here before adding one.`,
      ),
    )
    expect(world.startup, 'it went on past a composition it refused').toEqual([])
    expect(page().childElementCount).toBe(0)
  })

  /* A browser tab has no titlebar, and the table says so with zeros: a desktop's
     geometry would reserve a band for one. Published before the fatal handlers,
     and both before the first render. */
  it('publishes a browser’s geometry, then installs the fatal handlers, then renders', async () => {
    await mount()
    expect(world.startup).toEqual([
      ['fatal handlers', '0px'],
      ['render', '0px'],
    ])
    expect(document.documentElement.style.getPropertyValue('--titlebar-h')).toBe('0px')
  })

  it('names what is missing when there is nowhere to mount', () => {
    document.body.innerHTML = ''
    expect(() => mountWebClient([])).toThrow(new Error('Paper: no #root to mount into'))
  })
})

describe('which screen the session draws', () => {
  it('draws nothing while it asks, and asks once per mount of the check', async () => {
    await mount()
    expect(page().childElementCount).toBe(0)
    expect(world.checks).toBeGreaterThan(0)
  })

  it('draws the pairing screen for a browser that holds no credential, and asks again when it pairs', async () => {
    await mountAs({ kind: 'needs-code' })
    expect(shown('PairScreen')).toBe(true)
    expect(words()).toBe('')

    await during(() => (drew('PairScreen').onConnected as () => void)())
    expect(page().childElementCount, 'the old answer stayed up while a new one was asked').toBe(0)
    await answer({ kind: 'connected' })
    expect(shown('PairScreen')).toBe(false)
  })

  it('says the library is not answering, and Try again asks afresh', async () => {
    await mountAs({ kind: 'unreachable' })
    expect(page().querySelector('main.gate h1')?.textContent).toBe('Your library is not answering')
    const asked = world.checks

    await during(() => buttonNamed('Try again').click())
    expect(world.checks).toBe(asked + 1)
    expect(page().childElementCount).toBe(0)
    await answer({ kind: 'needs-code' })
    expect(shown('PairScreen')).toBe(true)
  })

  /* A NETWORK ROUND TRIP SEQUENCED BY NOTHING: the check that started first can
     finish last, and the screen then reverts to what an earlier check found. */
  it('ignores an older check that answers before the newest', async () => {
    await mount()
    const [older, newest] = world.session
    expect(newest, 'StrictMode runs the effect twice, so two checks are out').toBeDefined()
    await during(() => older?.resolve({ kind: 'needs-code' }))
    expect(page().childElementCount, 'the older answer was drawn').toBe(0)
    await during(() => newest?.resolve({ kind: 'unreachable' }))
    expect(words()).toContain('Your library is not answering')
  })

  it('ignores an older check that answers after the newest', async () => {
    await mount()
    const [older, newest] = world.session
    await during(() => newest?.resolve({ kind: 'unreachable' }))
    await during(() => older?.resolve({ kind: 'needs-code' }))
    expect(words()).toContain('Your library is not answering')
    expect(shown('PairScreen')).toBe(false)
  })
})

describe('what a sign-out says', () => {
  const STILL_PAIRED: SignOutResult = { kind: 'still-paired', why: 'the shelf said no' }

  async function signOutFrom(): Promise<void> {
    await during(() => (drew('SettingsScreen').onSignOut as () => void)())
    await vi.waitFor(() => expect(world.signOuts).toBeGreaterThan(0))
    await during(() => undefined)
  }

  const toSettings = async (): Promise<void> => {
    await during(() => (drew('TabBar').onSelect as (tab: string) => void)('settings'))
  }

  it('asks again after it signs out, and says nothing when it worked', async () => {
    await atTheShelf()
    await toSettings()
    const asked = world.checks
    await signOutFrom()
    await vi.waitFor(() => expect(world.checks).toBe(asked + 1))
    expect(page().childElementCount, 'the shelf stayed up while a new answer was asked').toBe(0)
    await answer({ kind: 'needs-code' })
    expect(page().querySelector('[role="alert"]')).toBeNull()
    expect(shown('PairScreen')).toBe(true)
  })

  /* THE BORROWED LAPTOP: the credential is `HttpOnly`, so a sign-out that did not
     reach the shelf leaves it good for ninety days, and the warning has to be
     wherever the reader lands. */
  it.each([
    { lands: 'connected', drawn: 'Library', says: 'Sign-out did not finish (the shelf said no). This browser is still paired — revoke it from Settings → Browsers on the shelf itself.' },
    { lands: 'needs-code', drawn: 'PairScreen', says: 'Signed out here, but the shelf did not confirm it (the shelf said no). This browser may still be paired — revoke it from Settings → Browsers on the shelf itself.' },
  ] as const)('warns on the $lands screen when the shelf did not confirm it', async ({ lands, drawn, says }) => {
    world.signOut = STILL_PAIRED
    await atTheShelf()
    await toSettings()
    await signOutFrom()
    await vi.waitFor(() => expect(world.session.length).toBeGreaterThan(0))
    await answer({ kind: lands })
    expect(page().querySelector('[role="alert"].gate-notice')?.textContent).toBe(says)
    expect(shown(drawn)).toBe(true)
  })

  it('clears the warning once a later sign-out works', async () => {
    world.signOut = STILL_PAIRED
    await atTheShelf()
    await toSettings()
    await signOutFrom()
    await vi.waitFor(() => expect(world.session.length).toBeGreaterThan(0))
    await answer({ kind: 'connected' })
    expect(page().querySelector('[role="alert"]')).not.toBeNull()

    world.signOut = { kind: 'signed-out' }
    world.signOuts = 0
    await during(() => (drew('TabBar').onSelect as (tab: string) => void)('settings'))
    await signOutFrom()
    await vi.waitFor(() => expect(world.session.length).toBeGreaterThan(0))
    await answer({ kind: 'connected' })
    expect(page().querySelector('[role="alert"]')).toBeNull()
  })
})

describe('the link under the shelf', () => {
  it('opens a link over the page’s own socket, and closes it with the screen', async () => {
    await mountAs({ kind: 'connected' })
    const link = liveLink()
    world.linkOptions.at(-1)?.connect()
    expect(world.connected).toEqual([{ url: `socket of ${window.location.href}` }])
    expect(link.close).not.toHaveBeenCalled()

    await during(() => root?.unmount())
    root = null
    expect(link.close).toHaveBeenCalledTimes(1)
    expect(link.listeners.size, 'something still listens to a link that closed').toBe(0)
    expect(link.opened.size, 'something still waits on a link that closed').toBe(0)
  })

  it('draws nothing while the first connection is being made', async () => {
    await mountAs({ kind: 'connected' })
    expect(page().childElementCount).toBe(0)
  })

  it.each([
    { reason: 'refused', attempt: 1, says: 'Your library is not answeringThe shelf refused the connection. Paper keeps trying.Try nowDisconnect this browser' },
    { reason: 'refused', attempt: 2, says: 'Your library is not answeringThe shelf refused the connection. Paper keeps trying — attempt 2.Try nowDisconnect this browser' },
    { reason: 'failed', attempt: 3, says: 'Your library is not answeringThe computer holding your books may be asleep, or off the network. Paper keeps trying — attempt 3.Try nowDisconnect this browser' },
  ] as const)('says why it is waiting: $reason, attempt $attempt', async ({ reason, attempt, says }) => {
    world.firstState = { kind: 'waiting', attempt, retryAt: 0, reason }
    await mountAs({ kind: 'connected' })
    expect(words()).toBe(says)

    await during(() => buttonNamed('Try now').click())
    expect(liveLink().retryNow).toHaveBeenCalledTimes(1)

    await during(() => buttonNamed('Disconnect this browser').click())
    await vi.waitFor(() => expect(world.signOuts).toBe(1))
  })

  it('moves to the waiting screen when the first attempt fails', async () => {
    await mountAs({ kind: 'connected' })
    expect(page().childElementCount).toBe(0)
    await during(() => liveLink().become({ kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }))
    expect(buttonNamed('Try now')).toBeDefined()
  })

  it('builds no store until there is a link to build it over', async () => {
    await mountAs({ kind: 'connected' })
    for (const over of [world.booksOver, world.contentOver, world.remoteOver]) {
      expect(over.length).toBeGreaterThan(0)
      expect(over).not.toContain(null)
    }
  })

  it('draws the shelf when a channel first opens, and keeps it through a drop', async () => {
    await mountAs({ kind: 'connected' })
    expect(shown('Library')).toBe(false)

    await during(() => liveLink().become(OPEN))
    expect(shown('Library')).toBe(true)

    await during(() => liveLink().become({ kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }))
    expect(shown('Library'), 'a drop took the books off the screen').toBe(true)
  })

  it('reads the shelf when the link is already open, and again each time it reopens', async () => {
    await atTheShelf()
    const read = books.refresh.mock.calls.length
    expect(read).toBeGreaterThan(0)

    await during(() => liveLink().become({ kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }))
    expect(books.refresh).toHaveBeenCalledTimes(read)
    await during(() => liveLink().become({ kind: 'open', generation: 2 }))
    expect(books.refresh).toHaveBeenCalledTimes(read + 1)
  })

  it('does not read a shelf it has no channel to', async () => {
    await mountAs({ kind: 'connected' })
    expect(books.refresh).not.toHaveBeenCalled()
    await during(() => liveLink().become(OPEN))
    expect(books.refresh).toHaveBeenCalledTimes(1)
  })

  it('builds its stores over the live link and lets each go with the screen', async () => {
    await atTheShelf()
    const link = liveLink()
    expect(world.booksOver.at(-1)).toBe(link)
    expect(world.contentOver.at(-1)).toBe(link)
    expect(world.remoteOver.at(-1)).toBe(link)
    expect(world.coversOver.at(-1)).toBe(link)
    expect(world.storesOver.at(-1)).toBe(link)
    const books0 = books.dispose.mock.calls.length
    const remote0 = remote.dispose.mock.calls.length

    await during(() => root?.unmount())
    root = null
    expect(books.dispose).toHaveBeenCalledTimes(books0 + 1)
    expect(remote.dispose).toHaveBeenCalledTimes(remote0 + 1)
    expect(books.listeners.size, 'something still listens to a store let go').toBe(0)
  })
})

describe('what the shelf hands the screen', () => {
  it('hands the shelf screen the books, the covers and no way to write', async () => {
    await atTheShelf()
    const library = drew('Library')
    const shelf = ROWS.map((row) => ({ ...row, indexed: true }))
    expect(library).toEqual({
      books: shelf,
      platform: 'web',
      defaultLayout: 'list',
      coverFor: COVERS,
      onOpen: expect.any(Function),
      importing: null,
      enriching: 0,
      importNotice: null,
      shelfUnread: false,
      libraryQuery: '',
      onQueryChange: expect.any(Function),
      bookActions: [],
      bookStatuses: [],
    })
    expect(drew('ContinueStrip')).toEqual({ books: shelf, onOpen: library.onOpen, coverFor: COVERS })
    expect(drew('TabBar')).toEqual({ active: 'library', onSelect: expect.any(Function), hasBook: false })
    expect(page().querySelector(`.${styles.shell} .${styles.stage} .${styles.stageList} [data-stub="Library"]`)).not.toBeNull()
    expect(shown('SettingsScreen'), 'the settings screen was drawn over the shelf').toBe(false)
    expect(page().querySelector('h1'), 'the deck’s title was drawn over the shelf').toBeNull()
  })

  it('remaps the books only when the rows change', async () => {
    await atTheShelf()
    const before = drew('Library').books
    await during(() => (drew('Library').onQueryChange as (query: string) => void)('moby'))
    expect(drew('Library').libraryQuery).toBe('moby')
    expect(drew('Library').books, 'the shelf was remapped for a keystroke').toBe(before)

    await during(() => books.become({ rows: [{ bookId: 'c', title: 'Third' }] }))
    expect(drew('Library').books).toEqual([{ bookId: 'c', title: 'Third', indexed: true }])
  })

  it.each([
    { status: 'ready', unread: false },
    { status: 'stale', unread: false },
    { status: 'loading', unread: true },
    { status: 'failed', unread: true },
  ])('calls a shelf that is $status unread: $unread', async ({ status, unread }) => {
    await atTheShelf()
    await during(() => books.become({ status }))
    expect(drew('Library').shelfUnread).toBe(unread)
  })

  /* The one line that says what actually refused, and that a stale list is stale:
     a reader deciding whether to trust a progress figure needs to know which. */
  it.each([
    { name: 'open and current', link: OPEN, status: 'ready', reason: null, notes: [] },
    { name: 'dropped, first wait', link: { kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }, status: 'ready', reason: null, notes: ['Your library stopped answering. These are the books as they were — Paper is trying again. Try now'] },
    { name: 'dropped, later wait', link: { kind: 'waiting', attempt: 3, retryAt: 0, reason: 'failed' }, status: 'ready', reason: null, notes: ['Your library stopped answering. These are the books as they were — Paper is trying again (attempt 3). Try now'] },
    { name: 'connecting again', link: { kind: 'connecting', attempt: 3 }, status: 'ready', reason: null, notes: ['Your library stopped answering. These are the books as they were — Paper is trying again. Try now'] },
    { name: 'stale with no reason', link: OPEN, status: 'stale', reason: null, notes: ['Your library stopped answering. These are the books as they were — nothing here is current until it is back.'] },
    { name: 'stale with a reason', link: OPEN, status: 'stale', reason: 'denied', notes: ['Your library stopped answering (denied). These are the books as they were — nothing here is current until it is back.'] },
    { name: 'dropped and stale says only the drop', link: { kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }, status: 'stale', reason: 'denied', notes: ['Your library stopped answering. These are the books as they were — Paper is trying again. Try now'] },
    { name: 'dropped and failed says both', link: { kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }, status: 'failed', reason: 'denied', notes: ['Your library stopped answering. These are the books as they were — Paper is trying again. Try now', 'Nothing could be loaded. denied'] },
    { name: 'failed with no reason', link: OPEN, status: 'failed', reason: null, notes: ['Nothing could be loaded. Your library is not answering.'] },
    { name: 'failed with a reason', link: OPEN, status: 'failed', reason: 'denied', notes: ['Nothing could be loaded. denied'] },
  ] as { name: string; link: LinkState; status: string; reason: string | null; notes: readonly string[] }[])('says what state the list is in: $name', async ({ link, status, reason, notes }) => {
    await atTheShelf()
    await during(() => liveLink().become(link))
    await during(() => books.become({ status, reason }))
    expect([...page().querySelectorAll('.shelf-note')].map((one) => one.textContent)).toEqual(notes)
  })

  it('offers Try now on a dropped link, and it hurries the link', async () => {
    await atTheShelf()
    await during(() => liveLink().become({ kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }))
    const button = page().querySelector<HTMLButtonElement>('.shelf-note button.shelf-note-action')
    expect(button?.textContent).toBe('Try now')
    await during(() => button?.click())
    expect(liveLink().retryNow).toHaveBeenCalledTimes(1)
  })
})

describe('reading a book', () => {
  const open = (entry: unknown): Promise<void> => during(() => (drew('Library').onOpen as (one: unknown) => void)(entry))
  const FIRST = { bookId: 'a', title: 'First', indexed: true }
  const select = (tab: string): Promise<void> => during(() => (drew('TabBar').onSelect as (one: string) => void)(tab))

  it('opens the reader over the shelf’s content, on the same link', async () => {
    await atTheShelf()
    await open(FIRST)
    expect(shown('Reader')).toBe(true)
    expect(shown('TabBar'), 'the tab bar stayed up over the reader').toBe(false)
    expect(drew('Reader')).toEqual({
      content: { name: 'content' },
      bookId: 'a',
      name: 'First',
      onClose: expect.any(Function),
      remote,
      marks: { name: 'marks' },
      titleOf: expect.any(Function),
      searchLibrary: SEARCH,
      onOpenPassage: expect.any(Function),
    })
    expect(world.searchesOver.at(-1)).toBe(liveLink())
  })

  it('names a book with no title “book”, so the reader has something to route on', async () => {
    await atTheShelf()
    await open({ bookId: 'b', title: '', indexed: true })
    expect(drew('Reader').name).toBe('book')
  })

  it('looks a title up by id, for marks that belong to another book', async () => {
    await atTheShelf()
    await open(FIRST)
    const titleOf = drew('Reader').titleOf as (id: string) => string | undefined
    expect(titleOf('a')).toBe('First')
    expect(titleOf('nobody')).toBeUndefined()

    await during(() => books.become({ rows: [{ bookId: 'a', title: 'Renamed' }] }))
    expect((drew('Reader').titleOf as (id: string) => string | undefined)('a')).toBe('Renamed')
  })

  /* A SWITCH THAT ANSWERS "could not be searched" ON THE FIRST KEYSTROKE teaches
     a reader the feature is broken rather than that the shelf is not connected. */
  it('offers library search only while the link is open', async () => {
    await atTheShelf()
    await open(FIRST)
    await during(() => liveLink().become({ kind: 'waiting', attempt: 1, retryAt: 0, reason: 'failed' }))
    expect(drew('Reader')).not.toHaveProperty('searchLibrary')
    expect(drew('Reader')).not.toHaveProperty('onOpenPassage')
    await during(() => liveLink().become({ kind: 'open', generation: 2 }))
    expect(drew('Reader').searchLibrary).toBe(SEARCH)
  })

  it('opens the book a library hit names, and refuses one that left the shelf', async () => {
    await atTheShelf()
    await open(FIRST)
    const jump = drew('Reader').onOpenPassage as (hit: unknown) => void
    await during(() => jump({ bookId: 'gone' }))
    expect(drew('Reader').bookId).toBe('a')

    await during(() => jump({ bookId: 'b' }))
    expect(drew('Reader')).toMatchObject({ bookId: 'b', name: 'book' })
  })

  it('finds a library hit among the rows as they are now, not as they were', async () => {
    await atTheShelf()
    await open(FIRST)
    await during(() => books.become({ rows: [...ROWS, { bookId: 'c', title: 'Later' }] }))
    await during(() => (drew('Reader').onOpenPassage as (hit: unknown) => void)({ bookId: 'c' }))
    expect(drew('Reader')).toMatchObject({ bookId: 'c', name: 'Later' })
  })

  /* `reading` OUTLIVES THE READER: this used to forget the book as well, which made
     the Reading tab a second Library button in every case it exists for. */
  it('goes back to the shelf on close and keeps the book for the Reading tab', async () => {
    await atTheShelf()
    await open(FIRST)
    await during(() => (drew('Reader').onClose as () => void)())
    expect(shown('Library')).toBe(true)
    expect(shown('Reader')).toBe(false)
    expect(drew('TabBar')).toMatchObject({ active: 'library', hasBook: true })

    await select('reading')
    expect(shown('Reader')).toBe(true)
    expect(drew('Reader').bookId).toBe('a')
  })

  it('remounts the reader for another book, which reads its place only at mount', async () => {
    await atTheShelf()
    await open(FIRST)
    const mounts = world.readerMounts
    await during(() => (drew('Reader').onOpenPassage as (hit: unknown) => void)({ bookId: 'b' }))
    expect(world.readerMounts).toBeGreaterThan(mounts)
  })

  it('shows the shelf for the Reading tab when no book is open', async () => {
    await atTheShelf()
    await select('reading')
    expect(shown('Reader')).toBe(false)
    expect(shown('Library'), 'the Reading tab drew the shelf with nothing to read').toBe(false)
    expect(drew('TabBar')).toMatchObject({ active: 'reading', hasBook: false })
  })

  /* A shelf that loads is empty and proves nothing: only a current list may say a
     book has gone, and a current list that is empty does say so. */
  it.each([
    { status: 'loading', rows: [], forgets: false },
    { status: 'stale', rows: [], forgets: false },
    { status: 'failed', rows: [], forgets: false },
    { status: 'ready', rows: ROWS, forgets: false },
    { status: 'ready', rows: [{ bookId: 'b', title: '' }], forgets: true },
    { status: 'ready', rows: [], forgets: true },
  ])('forgets the open book: $forgets, when the list is $status with $rows.length rows', async ({ status, rows, forgets }) => {
    await atTheShelf()
    await open(FIRST)
    await during(() => (drew('Reader').onClose as () => void)())
    await during(() => books.become({ status, rows }))
    expect(drew('TabBar').hasBook).toBe(!forgets)
  })
})

describe('the other tabs', () => {
  const select = (tab: string): Promise<void> => during(() => (drew('TabBar').onSelect as (one: string) => void)(tab))

  it('hands the settings screen one store for this browser, however often it draws, and the way out', async () => {
    await atTheShelf()
    await select('settings')
    const first = drew('SettingsScreen').settings
    expect(first).toEqual(expect.objectContaining({ name: expect.stringContaining('settings') }))
    expect(shown('SettingsScreen')).toBe(true)
    expect(shown('Library')).toBe(false)

    await select('library')
    await select('settings')
    expect(drew('SettingsScreen').settings, 'a new store for the same browser').toBe(first)
    await during(() => (drew('SettingsScreen').onSignOut as () => void)())
    await vi.waitFor(() => expect(world.signOuts).toBe(1))
  })

  it('draws no deck until the store exists', async () => {
    await atTheShelf()
    await select('cards')
    expect(shown('Cards')).toBe(false)
    expect(page().querySelector(`h1.${styles.screenTitle}`)?.textContent).toBe('Cards')
  })

  it('hands the deck what the store read, with nothing that writes, and the book being read', async () => {
    world.stores = { marks: { name: 'marks' }, cards: { persistent: true }, cardRows: ['a card'] }
    await atTheShelf()
    await select('cards')
    expect(page().querySelector('[data-stub="Cards"]')?.parentElement?.className).toBe(`${styles.stage} ${styles.screen}`)
    expect(drew('Cards')).toEqual({
      cards: { all: ['a card'], persistent: true },
      bookId: null,
      onShelf: expect.any(Function),
    })
    expect((drew('Cards').onShelf as () => boolean)()).toBe(false)

    await select('library')
    await during(() => (drew('Library').onOpen as (one: unknown) => void)({ bookId: 'a', title: 'First' }))
    await during(() => (drew('Reader').onClose as () => void)())
    await select('cards')
    expect(drew('Cards').bookId).toBe('a')
  })
})
