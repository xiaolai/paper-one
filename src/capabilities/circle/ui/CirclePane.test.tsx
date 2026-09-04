// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownPerson, PersonPort, PersonStatus } from '../../peer'
import { CAPABILITY_UI } from '../../../kernel'
import { CirclePane } from './CirclePane'
import type { CirclePort, FriendView } from '../lib/circlePort'
import type { ListsPort, OwnListView } from '../lib/listsPort'

/**
 * The circle panel — WI-22.D3's surface.
 *
 * What is proven here is the panel's PROMISES, not its layout: that opening it
 * mints nothing, that a read failure is not shown as "you have no circle", that
 * the twelve words appear only when asked for, and that the standing custody
 * marker says what `identity.md` requires it to say.
 */

afterEach(cleanup)

const noPeople: readonly KnownPerson[] = []

const status = (over: Partial<PersonStatus> = {}): PersonStatus => ({
  personId: 'aabbccdd0011223344556677889900112233445566778899aabbccddeeff0011',
  hasIdentity: true,
  canShowPhrase: true,
  role: 'home',
  devices: 2,
  circle: 0,
  atRisk: false,
  ...over,
})

const portWith = (over: Partial<PersonPort> = {}): PersonPort => ({
  status: () => Promise.resolve(status()),
  ensure: () => Promise.resolve('person'),
  phrase: () => Promise.resolve('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  forget: () => Promise.resolve(),
  restore: () => Promise.resolve('person'),
  people: () => Promise.resolve(noPeople),
  devices: () => Promise.resolve(2),
  remember: () => Promise.resolve(),
  forgetPerson: () => Promise.resolve(),
  /* Refused by default. A stub that admitted would make every surface test
     pass against the happy path and none against the ordinary one. */
  introduce: () => Promise.resolve(false),
  revokeDevice: () => Promise.resolve(),
  offer: () => Promise.resolve({ url: 'paper://pair?x', svg: '<svg/>', expiresAt: Date.now() + 300_000 }),
  join: () => Promise.resolve({ sas: '123456' }),
  confirm: () => Promise.resolve(null),
  cancel: () => Promise.resolve(),
  onPending: () => () => {},
  onResult: () => () => {},
  ...over,
})

describe('the circle panel', () => {
  it('mints nothing by being opened', async () => {
    /* ⚠️ **THE PROPERTY THE WHOLE CUSTODY DESIGN RESTS ON.** A reader who never
       shares never needs a person identity — *"a phrase shown before there is
       any context is a phrase that gets clicked through."* A panel that minted
       on open would delete that laziness without anybody removing it. */
    const ensure = vi.fn(() => Promise.resolve('person'))
    render(
      <CirclePane
        port={portWith({ ensure, status: () => Promise.resolve(status({ hasIdentity: false, personId: null, canShowPhrase: false, role: null })) })}
       
      />,
    )

    await screen.findByText(/Nothing is shared until you add somebody/u)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('offers to start one, and only then mints', async () => {
    const ensure = vi.fn(() => Promise.resolve('person'))
    render(
      <CirclePane
        port={portWith({ ensure, status: () => Promise.resolve(status({ hasIdentity: false, personId: null })) })}
       
      />,
    )
    const start = await screen.findByRole('button', { name: /Start a circle/u })
    await act(async () => {
      fireEvent.click(start)
    })

    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('says it could not look, rather than that there is nothing to see', async () => {
    /* ⚠️ A failed read rendered as the empty state tells the reader they have
       no circle — a different and much worse claim than "I could not look". */
    render(<CirclePane port={portWith({ people: () => Promise.reject(new Error('keychain locked')) })} />)

    await screen.findByText(/could not read your circle/u)
    expect(screen.queryByText(/Nothing is shared until you add somebody/u)).toBeNull()
  })

  it('shows the standing marker when the circle lives on one device', async () => {
    /* `identity.md`: *"'one device, no copy' is a state Paper surfaces
       continuously — not a moment it hopes to catch."* */
    render(<CirclePane port={portWith({ status: () => Promise.resolve(status({ atRisk: true, devices: 1 })) })} />)

    await screen.findByText(/lives on this device alone/u)
  })

  it('does not show it when a second device holds the identity too', async () => {
    // A marker that fires for everyone is wallpaper.
    render(<CirclePane port={portWith()} />)

    await screen.findByText(/holds your keys/u)
    expect(screen.queryByText(/lives on this device alone/u)).toBeNull()
  })

  it('reads the device count from the port, so a second device takes the marker down — WI-23.A3', async () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: pair a second device; `atRisk` must be
       false. Unpair it; true. The status here derives `atRisk` from the count
       it is HANDED, the way Rust's `custody` does — so a panel that still fed
       it a hardcoded 1 would show the marker on every device a reader owns. */
    const custody = (devices: number) => Promise.resolve(status({ devices, atRisk: devices <= 1 }))
    const alone = render(<CirclePane port={portWith({ status: custody, devices: () => Promise.resolve(1) })} />)
    await alone.findByText(/lives on this device alone/u)
    cleanup()

    const paired = render(<CirclePane port={portWith({ status: custody, devices: () => Promise.resolve(2) })} />)
    await paired.findByText(/holds your keys/u)
    expect(paired.queryByText(/lives on this device alone/u)).toBeNull()
  })

  it('keeps the twelve words hidden until they are asked for', async () => {
    /* The one command that returns a secret, called only when a reader pressed
       the button that says so. */
    const phrase = vi.fn(() => Promise.resolve('abandon abandon about'))
    render(<CirclePane port={portWith({ phrase })} />)
    await screen.findByText(/holds your keys/u)

    expect(phrase).not.toHaveBeenCalled()
    expect(screen.queryByText(/abandon/u)).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show my twelve words/u }))
    })

    await screen.findByText(/abandon abandon about/u)
    expect(phrase).toHaveBeenCalledTimes(1)
  })

  it('takes them off screen again', async () => {
    render(<CirclePane port={portWith()} />)
    await screen.findByText(/holds your keys/u)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show my twelve words/u }))
    })
    await screen.findByText(/abandon abandon abandon/u)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Hide/u }))
    })

    await waitFor(() => expect(screen.queryByText(/abandon abandon abandon/u)).toBeNull())
  })

  it('lists the people, and says what removing one does NOT do', async () => {
    /* ⚠️ Removing somebody stops their new passages; what they already sent is
       on this disk until a purge asks for it by name. A reader who assumed
       otherwise would think they had deleted something they had not. */
    const people: readonly KnownPerson[] = [
      { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 2 }, revoked: [], devices: [] },
    ]
    render(<CirclePane port={portWith({ people: () => Promise.resolve(people) })} />)

    await screen.findByText('Mo')
    await screen.findByText(/What they already shared stays until you clear it/u)
  })

  it('removes somebody when asked', async () => {
    const forgetPerson = vi.fn(() => Promise.resolve())
    const people: readonly KnownPerson[] = [
      { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 2 }, revoked: [], devices: [] },
    ]
    render(<CirclePane port={portWith({ people: () => Promise.resolve(people), forgetPerson })} />)
    await screen.findByText('Mo')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Remove/u }))
    })

    expect(forgetPerson).toHaveBeenCalledWith('ff'.repeat(32))
  })

  it('settles instead of re-reading for ever when its port is rebuilt each render', async () => {
    /* ⚠️ **THE HOST BUILDS THE PORT INSIDE `render()`, so a fresh object
       arrives on every render.** With `port` in the effect's dependencies that
       is a loop: fetch, set state, re-render, new identity, fetch again — and
       the panel never settles, which is what "the Circle button does nothing"
       looks like from the outside. The earlier tests all passed ONE port object
       that never changed identity, so the fixture hid it. */
    let reads = 0
    const people = () => {
      reads += 1
      return Promise.resolve(noPeople)
    }
    const { rerender } = render(<CirclePane port={portWith({ people })} />)
    await screen.findByText(/holds your keys/u)

    /* A re-render from the parent, exactly as the side pane does. */
    rerender(<CirclePane port={portWith({ people })} />)
    await screen.findByText(/holds your keys/u)
    const settled = reads
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(reads).toBe(settled)
    expect(reads).toBeLessThan(6)
  })

  it('offers a way to add somebody, which is what the empty state promises', async () => {
    /* ⚠️ **THE PANEL SAID "nothing is shared until you add somebody" AND HAD NO
       WAY TO ADD ANYBODY.** Text naming an action the UI cannot perform is
       worse than no text: it tells the reader they have missed a control that
       does not exist. */
    const offer = vi.fn(() => Promise.resolve({ url: 'paper://pair?s=abc', svg: '<svg/>', expiresAt: Date.now() + 300_000 }))
    render(<CirclePane port={portWith({ offer })} />)
    await screen.findByText(/holds your keys/u)

    const add = screen.getByRole('button', { name: /Add somebody/u })
    await act(async () => { fireEvent.click(add) })

    expect(offer).toHaveBeenCalledTimes(1)
    await screen.findByText('paper://pair?s=abc')
  })

  it('joins a friend’s link and shows the digits to compare', async () => {
    const join = vi.fn(() => Promise.resolve({ sas: '481902' }))
    render(<CirclePane port={portWith({ join })} />)
    await screen.findByText(/holds your keys/u)

    const field = screen.getByPlaceholderText(/paste a friend/u)
    fireEvent.change(field, { target: { value: '  paper://pair?s=zzz  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Join$/u })) })

    /* Trimmed: a link out of a chat app arrives with whitespace around it. */
    expect(join).toHaveBeenCalledWith('paper://pair?s=zzz')
    await screen.findByText('481902')
  })

  it('lets the other side answer, because pairing takes two', async () => {
    /* ⚠️ A flow that only OFFERED would work in exactly half of every pairing. */
    let fire: ((p: unknown) => void) | null = null
    const confirm = vi.fn(() => Promise.resolve(null))
    const onPending = (fn: (p: never) => void) => {
      fire = fn as (p: unknown) => void
      return () => {}
    }
    render(<CirclePane port={portWith({ onPending, confirm })} />)
    await screen.findByText(/holds your keys/u)

    await act(async () => {
      fire?.({ id: 'dev', name: 'Mo', platform: 'macos', sas: '778811', attemptId: 'a1' })
    })
    await screen.findByText('778811')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /digits match/u })) })

    expect(confirm).toHaveBeenCalledWith(true, 'a1')
  })

  it('does not let an older read overwrite a newer one', async () => {
    /* ⚠️ **A SLOW FIRST READ LANDED AFTER A FAST SECOND ONE.** A refresh
       started by a pairing result published the new person; the initial refresh
       then resolved and put the empty roster back — along with a status
       computed for a circle of zero. The same revision `useOverlays` keeps. */
    const settle: ((v: readonly KnownPerson[]) => void)[] = []
    const mo: KnownPerson = {
      person: 'ff'.repeat(32),
      displayName: 'Mo',
      roster: { epoch: 1, hlc: 1 },
      revoked: [],
      devices: [],
    }
    let paired: ((event: unknown) => void) | null = null
    const port = portWith({
      people: () => new Promise<readonly KnownPerson[]>((r) => settle.push(r)),
      onResult: (fn) => {
        paired = fn as (event: unknown) => void
        return () => {}
      },
    })
    render(<CirclePane port={port} />)
    await waitFor(() => expect(settle).toHaveLength(1))

    /* A second read starts — a pairing result is what starts one — and
       finishes FIRST. */
    await act(async () => paired!({ ok: true, kind: 'circle' }))
    await waitFor(() => expect(settle).toHaveLength(2))
    await act(async () => settle[1]?.([mo]))
    await screen.findByText('Mo')

    /* The older one lands last and must not be believed. */
    await act(async () => settle[0]?.([]))

    expect(screen.queryByText('Mo')).not.toBeNull()
  })

  it('does not show a superseded identity’s words', async () => {
    /* ⚠️ Clearing `phrase` when the identity changes did nothing to a read
       ALREADY IN FLIGHT: press Show, restore or forget, and the old promise
       resolved afterwards and put the previous person's twelve words on screen
       under the new person's id.

       ONE port throughout, whose identity changes between reads — swapping the
       port instead would replace the whole component and prove nothing about
       the in-flight read. */
    const settle: ((v: string | null) => void)[] = []
    let who = 'aa'.repeat(32)
    let paired: ((event: unknown) => void) | null = null
    const port = portWith({
      phrase: () => new Promise<string | null>((r) => settle.push(r)),
      status: () => Promise.resolve(status({ personId: who })),
      onResult: (fn) => {
        paired = fn as (event: unknown) => void
        return () => {}
      },
    })
    render(<CirclePane port={port} />)
    await screen.findByText(/holds your keys/u)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show my twelve words/u }))
    })
    await waitFor(() => expect(settle).toHaveLength(1))

    /* The identity changes while that read is still out, and a pairing
       result makes the panel look again. */
    who = 'bb'.repeat(32)
    await act(async () => paired!({ ok: true, kind: 'circle' }))
    await waitFor(() => expect(screen.queryByText(new RegExp(who.slice(0, 8), 'u'))).not.toBeNull())

    await act(async () => settle[0]?.('the old secret words'))

    expect(screen.queryByText('the old secret words')).toBeNull()
  })

  it('says a pairing failed rather than showing it as finished', async () => {
    /* ⚠️ The result callback ignored `ok`. A refusal, a bad MAC or a timeout
       cleared the six digits and returned "Nobody yet" — the reader was told a
       pairing had completed when it had not. */
    const listeners: ((r: unknown) => void)[] = []
    render(
      <CirclePane
        port={portWith({
          onResult: (fn: (r: never) => void) => {
            listeners.push(fn as (r: unknown) => void)
            return () => {}
          },
        })}
       
      />,
    )
    await screen.findByText(/holds your keys/u)

    await act(async () => listeners[0]?.({ ok: false, id: 'x', reason: 'bad-mac', kind: 'circle' }))

    await screen.findByText(/did not complete \(bad-mac\)/u)
  })

  it('stops presenting a link that has already lapsed', async () => {
    /* ⚠️ `expiresAt` was discarded. Sending a dead link produces an `expired`
       refusal, and the reader could not make another without first stopping
       the one that had already lapsed. */
    const port = portWith({
      offer: () => Promise.resolve({ url: 'paper://dead', svg: '', expiresAt: Date.now() - 1 }),
    })
    render(<CirclePane port={port} />)
    await screen.findByText(/holds your keys/u)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add somebody/u }))
    })

    expect(screen.queryByText('paper://dead')).toBeNull()
    /* And the way to make a live one is still there. */
    expect(screen.getByRole('button', { name: /Add somebody/u })).toBeTruthy()
  })

  it('says a phrase read failed rather than leaving it looking hidden', async () => {
    /* Rendering a failed keychain read as "still hidden" tells the reader the
       button does nothing, which is the one thing that is not true. */
    render(
      <CirclePane
        port={portWith({ phrase: () => Promise.reject(new Error('keychain locked')) })}
       
      />,
    )
    await screen.findByText(/holds your keys/u)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show my twelve words/u }))
    })

    await screen.findByText(/keychain locked/u)
  })

  it('says so plainly on a composition with no peer plugin', async () => {
    /* ⚠️ No plugin is no circle, which is a state and not an error — the
       browser client legitimately cannot have this feature, and a panel that
       threw would take the whole side pane down with it. */
    render(<CirclePane port={null} />)

    await screen.findByText(/needs Paper's own app/u)
  })

  it('never puts the whole person id on screen', async () => {
    // Nobody reads a 64-hex public key, so nobody is shown one.
    const full = status().personId ?? ''
    render(<CirclePane port={portWith()} />)
    await screen.findByText(/holds your keys/u)

    expect(screen.queryByText(full)).toBeNull()
    await screen.findByText(new RegExp(full.slice(0, 8), 'u'))
  })
})

describe('the shelf switch and the Friends view — WI-23.C2 and C4', () => {
  const mo: KnownPerson = { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }
  const circleWith = (over: Partial<import('../lib/circlePort').CirclePort> = {}): import('../lib/circlePort').CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    cover: () => Promise.resolve(null),
    setShowsShelf: vi.fn(() => Promise.resolve()),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    book: () => Promise.resolve({ people: [], alsoRead: [] }),
    forget: vi.fn(() => Promise.resolve()),
    subscribe: () => () => {},
    ...over,
  })

  it('offers the switch per person, off, with copy that says what it ends', async () => {
    const circle = circleWith()
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} circle={circle} />)
    const box = (await screen.findByRole('checkbox', { name: 'Show my shelf to Mo' })) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByText(/Mo will be able to see every book in your library, including ones you have shared nothing from/u)).toBeTruthy()
    fireEvent.click(box)
    await waitFor(() => expect(circle.setShowsShelf).toHaveBeenCalledWith(mo.person, true))
  })

  it('says what is visible once the switch is on', async () => {
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} circle={circleWith({ showsShelf: () => Promise.resolve(true) })} />)
    const box = (await screen.findByRole('checkbox', { name: 'Show my shelf to Mo' })) as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(screen.getByText(/Mo can see every book in your library/u)).toBeTruthy()
  })

  it('draws a friend’s jacket beside their row once the port answers, and none for a row that names none — WI-23.C5', async () => {
  const cover = vi.fn((_person: string, book: { readonly pub: string }) => Promise.resolve(book.pub === 's1' ? 'data:image/jpeg;base64,AAAA' : null))
  const circle = circleWith({
    friend: () =>
      Promise.resolve({
        shelf: [
          { pub: 's1', title: 'Moby-Dick', author: 'Herman Melville', language: 'en', own: null, device: 'd1', cover: 'ab'.repeat(32) },
          { pub: 's2', title: 'Dune', author: 'Frank Herbert', language: 'en', own: null, device: 'd1', cover: null },
        ],
        recent: [],
        lists: [],
      }),
    cover,
  })
  const { container } = render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} circle={circle} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
  await screen.findByText(/Dune/u)
  await waitFor(() => expect(container.querySelector('img[data-jacket="s1"]')).not.toBeNull())
  expect(container.querySelector('img[data-jacket="s1"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA')
  expect(container.querySelector('img[data-jacket="s2"]')).toBeNull()
  /* Asked only for the row that names a digest. */
  expect(cover).toHaveBeenCalledTimes(1)
  expect(cover.mock.calls[0]![1]).toMatchObject({ pub: 's1' })
  })

  it('links exactly the books this reader also has — the falsifier — and opens them', async () => {
    const openBook = vi.fn()
    const circle = circleWith({
      friend: () =>
        Promise.resolve({
          shelf: [
            { pub: 's1', title: 'Moby-Dick', author: 'Herman Melville', language: 'en', own: 'book:moby', device: null, cover: null },
            { pub: 's2', title: 'Ulysses', author: 'James Joyce', language: 'en', own: null, device: null, cover: null },
            { pub: 's3', title: 'Dune', author: 'Frank Herbert', language: 'en', own: 'book:dune', device: null, cover: null },
          ],
          recent: [{ kind: 'rate', bookId: 'book:moby', title: 'Moby-Dick', value: '4 of 5', at: 'stamp' as never }],
          lists: [],
        }),
    })
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} circle={circle} openBook={openBook} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText(/Ulysses/u)
    const links = screen.getAllByRole('button', { name: /^Open your copy of/u })
    expect(links).toHaveLength(2)
    expect(links.map((one) => one.getAttribute('aria-label'))).toEqual(['Open your copy of Moby-Dick', 'Open your copy of Dune'])
    fireEvent.click(links[1]!)
    expect(openBook).toHaveBeenCalledWith('book:dune')
    /* And what they did lately, as a named sentence — never a number alone. */
    expect(screen.getByText(/Mo rated Moby-Dick 4 of 5/u)).toBeTruthy()
  })

  it('removes through the circle when it has one, which clears their files, and says so', async () => {
    const circle = circleWith()
    const forgetPerson = vi.fn(() => Promise.resolve())
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]), forgetPerson })} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(circle.forget).toHaveBeenCalledWith(mo.person))
    expect(forgetPerson).not.toHaveBeenCalled()
    expect(screen.getByText(/clears what they shared from this device. It cannot take back what you shared with them/u)).toBeTruthy()
  })

  it('draws no switch and no shelf without the circle’s port', async () => {
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} />)
    await screen.findByText('Mo')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Their shelf' })).toBeNull()
  })
})

describe('the reader’s own lists, on the Circle screen — WI-23.E1', () => {
  const mo: KnownPerson = { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }
  const circleWith = (over: Partial<CirclePort> = {}): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    cover: () => Promise.resolve(null),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    book: () => Promise.resolve({ people: [], alsoRead: [] }),
    forget: () => Promise.resolve(),
    subscribe: () => () => {},
    ...over,
  })
  const listsWith = (own: OwnListView[], over: Partial<ListsPort> = {}): ListsPort => ({
    lists: () => Promise.resolve(own),
    create: vi.fn(() => Promise.resolve('new1')),
    retitle: vi.fn(() => Promise.resolve()),
    place: vi.fn(() => Promise.resolve()),
    takeOff: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    subscribe: () => () => {},
    ...over,
  })
  const sea: OwnListView = {
    id: 'aa',
    title: 'Sea books',
    items: [
      { pub: 'i1', title: 'Moby-Dick', author: 'Herman Melville', position: 1, note: 'start here', bookId: 'book:moby' },
      { pub: 'i2', title: 'Emma', author: 'Jane Austen', position: 2, note: '', bookId: null },
    ],
  }
  const port = () => portWith({ people: () => Promise.resolve([]) })

  it('renames only once the title differs, deletes, keeps a note, takes an item off, and opens the reader’s copy', async () => {
    const lists = listsWith([sea])
    const openBook = vi.fn()
    render(<CirclePane port={port()} circle={circleWith()} lists={lists} openBook={openBook} />)
    const title = (await screen.findByLabelText('Title of Sea books')) as HTMLInputElement
    expect(title.value).toBe('Sea books')
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    fireEvent.change(title, { target: { value: 'Sea books' } })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    fireEvent.change(title, { target: { value: ' Whales ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(lists.retitle).toHaveBeenCalledWith('aa', 'Whales'))

    const note = screen.getByLabelText('Note on Moby-Dick') as HTMLInputElement
    expect(note.value).toBe('start here')
    expect(screen.queryByRole('button', { name: 'Keep note on Moby-Dick' })).toBeNull()
    fireEvent.change(note, { target: { value: 'read it twice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep note on Moby-Dick' }))
    await waitFor(() => expect(lists.place).toHaveBeenCalledWith('aa', 'book:moby', 'read it twice'))
    /* A book no longer on the shelf cannot be re-placed, so its note is read-only. */
    expect((screen.getByLabelText('Note on Emma') as HTMLInputElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Open your copy of Moby-Dick' }))
    expect(openBook).toHaveBeenCalledWith('book:moby')
    expect(screen.queryByRole('button', { name: 'Open your copy of Emma' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Take Emma off Sea books' }))
    await waitFor(() => expect(lists.takeOff).toHaveBeenCalledWith('aa', 'i2'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sea books' }))
    await waitFor(() => expect(lists.delete).toHaveBeenCalledWith('aa'))
  })

  it('starts a list here too, says when there are none, and re-reads when told', async () => {
    let tell: (() => void) | null = null
    let own: OwnListView[] = []
    const lists = listsWith([], {
      lists: () => Promise.resolve(own),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={port()} circle={circleWith()} lists={lists} />)
    await screen.findByText(/No lists yet/u)
    expect(screen.getByText(/Deleting one is for good/u)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('New list'), { target: { value: 'Whales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(lists.create).toHaveBeenCalledWith('Whales'))
    own = [sea]
    tell!()
    await screen.findByLabelText('Title of Sea books')
    expect(screen.queryByText(/No lists yet/u)).toBeNull()
  })

  it('draws no lists section without the port', async () => {
    render(<CirclePane port={port()} circle={circleWith()} />)
    await screen.findByText(/Nobody yet/u)
    expect(document.querySelector('[data-own-lists]')).toBeNull()
  })

  it('shows a friend’s lists with their notes, and links what the reader has', async () => {
    const openBook = vi.fn()
    const circle = circleWith({
      friend: () =>
        Promise.resolve({
          shelf: [{ pub: 's1', title: 'Moby-Dick', author: 'Herman Melville', language: 'en', own: 'book:moby', device: null, cover: null }],
          recent: [],
          lists: [
            {
              id: 'aa',
              title: 'Sea books',
              items: [
                { pub: 'i1', title: 'Moby-Dick', author: 'Herman Melville', note: 'start here', own: 'book:moby' },
                { pub: 'i2', title: 'Emma', author: 'Jane Austen', note: '', own: null },
              ],
            },
            { id: 'bb', title: 'Nothing yet', items: [] },
          ],
        }),
    })
    render(<CirclePane port={portWith({ people: () => Promise.resolve([mo]) })} circle={circle} openBook={openBook} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText('Sea books')
    expect(screen.getByText(/Moby-Dick — Herman Melville · “start here”/u)).toBeTruthy()
    expect(screen.getByText(/Emma — Jane Austen/u)).toBeTruthy()
    expect(screen.getByText('Nothing yet')).toBeTruthy()
    expect(screen.getAllByText('Nothing on it yet.')).toHaveLength(1)
    /* Two links: the shelf's Moby-Dick and the list's. */
    expect(screen.getAllByRole('button', { name: 'Open your copy of Moby-Dick' })).toHaveLength(2)
  })
})

describe('every clause of the person row, the Friends view and the reader’s lists — one row each', () => {
  const mo: KnownPerson = { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }
  const circleWith = (over: Partial<CirclePort> = {}): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    cover: () => Promise.resolve(null),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    book: () => Promise.resolve({ people: [], alsoRead: [] }),
    forget: () => Promise.resolve(),
    subscribe: () => () => {},
    ...over,
  })
  const listsWith = (own: OwnListView[], over: Partial<ListsPort> = {}): ListsPort => ({
    lists: () => Promise.resolve(own),
    create: vi.fn(() => Promise.resolve('new1')),
    retitle: vi.fn(() => Promise.resolve()),
    place: vi.fn(() => Promise.resolve()),
    takeOff: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    subscribe: () => () => {},
    ...over,
  })
  const withMo = () => portWith({ people: () => Promise.resolve([mo]) })
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }
  const friendView = (over: Partial<FriendView> = {}): FriendView => ({ shelf: [], recent: [], lists: [], ...over })

  it('says when a friend has shown nothing, hides Lately with nothing lately, and toggles the button’s label', async () => {
    render(<CirclePane port={withMo()} circle={circleWith()} />)
    const button = await screen.findByRole('button', { name: 'Their shelf' })
    fireEvent.click(button)
    await screen.findByText('Mo has shown you no books.')
    expect(screen.queryByText('Lately')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hide their shelf' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide their shelf' }))
    expect(screen.queryByText('Mo has shown you no books.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('danger')
  })

  it('draws each kind of recent thing in its own words, the author dash only with an author, and the own-book marker', async () => {
    const circle = circleWith({
      friend: () =>
        Promise.resolve(
          friendView({
            shelf: [
              { pub: 's1', title: 'Moby-Dick', author: 'Herman Melville', language: 'en', own: 'book:moby', device: null, cover: null },
              { pub: 's2', title: 'Untitled', author: '', language: 'en', own: null, device: null, cover: null },
            ],
            recent: [
              { kind: 'status', bookId: 'book:moby', title: 'Moby-Dick', value: 'finished', at: 'c' as never },
              { kind: 'rate', bookId: 'book:moby', title: 'Moby-Dick', value: '4 of 5', at: 'b' as never },
              { kind: 'review', bookId: 'book:moby', title: 'Moby-Dick', value: 'Long, and worth it.', at: 'a' as never },
            ],
          }),
        ),
    })
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText('Lately')
    expect(screen.getByText('Mo finished Moby-Dick')).toBeTruthy()
    expect(screen.getByText('Mo rated Moby-Dick 4 of 5')).toBeTruthy()
    expect(screen.getByText('Mo on Moby-Dick: “Long, and worth it.”')).toBeTruthy()
    expect(screen.getByText('Moby-Dick — Herman Melville')).toBeTruthy()
    expect(screen.getByText('Untitled').textContent).toBe('Untitled')
    /* Without a way to open it, the own copy is marked in words, not a button. */
    expect(screen.getByText('On your shelf').tagName).toBe('SPAN')
    expect(document.querySelectorAll('[data-own-book="book:moby"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-own-book]')).toHaveLength(1)
  })

  it('shows trouble when what a friend shared cannot be read, clears it on a later read, and re-reads when the circle says so', async () => {
    let fails = true
    let tell: (() => void) | null = null
    const circle = circleWith({
      friend: () => (fails ? Promise.reject(new Error('their shelf will not read')) : Promise.resolve(friendView())),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText(/Paper could not read what Mo shared\. their shelf will not read/u)
    fails = false
    tell!()
    await waitFor(() => expect(screen.queryByText(/could not read what Mo shared/u)).toBeNull())
  })

  it('shows trouble when the switch cannot be turned', async () => {
    const circle = circleWith({ setShowsShelf: () => Promise.reject(new Error('the record would not write')) })
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show my shelf to Mo' }))
    await screen.findByText(/the record would not write/u)
    /* In the row, with the roster still on screen — not the pane replaced
       by its failure line. */
    expect(screen.getByRole('checkbox', { name: 'Show my shelf to Mo' })).toBeTruthy()
  })

  it('lets a slow friend read neither overwrite nor trouble a later one', async () => {
    const slow = deferred<FriendView>()
    let calls = 0
    let tell: (() => void) | null = null
    const circle = circleWith({
      friend: () => (++calls === 1 ? slow.promise : Promise.resolve(friendView({ shelf: [{ pub: 's1', title: 'Dune', author: '', language: 'en', own: null, device: null, cover: null }] }))),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByText('Dune')
    slow.reject(new Error('too late'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/too late/u)).toBeNull()
    expect(screen.getByText('Dune')).toBeTruthy()
  })

  it('offers no Remove hint with nobody to remove', async () => {
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} />)
    await screen.findByText('Nobody yet.')
    expect(screen.queryByText(/Removing somebody/u)).toBeNull()
  })

  it('starts a list only from a real title, and clears the field after', async () => {
    const lists = listsWith([])
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} lists={lists} />)
    const field = (await screen.findByLabelText('New list')) as HTMLInputElement
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Start list' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: ' Whales ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(lists.create).toHaveBeenCalledWith('Whales'))
    await waitFor(() => expect((screen.getByLabelText('New list') as HTMLInputElement).value).toBe(''))
  })

  it('offers Rename only for a real, different title, and keeps a note only once it differs', async () => {
    const sea: OwnListView = { id: 'aa', title: 'Sea', items: [{ pub: 'i1', title: 'Moby-Dick', author: '', position: 1, note: 'n', bookId: 'book:moby' }] }
    const lists = listsWith([sea])
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} lists={lists} />)
    const title = (await screen.findByLabelText('Title of Sea')) as HTMLInputElement
    fireEvent.change(title, { target: { value: '   ' } })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    fireEvent.change(title, { target: { value: ' Sea ' } })
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    fireEvent.change(title, { target: { value: 'Whales' } })
    expect(screen.getByRole('button', { name: 'Rename' }).className).toContain('primary')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(lists.retitle).toHaveBeenCalledWith('aa', 'Whales'))
    /* Kept: the field shows what the port holds again, and the button goes. */
    await waitFor(() => expect((screen.getByLabelText('Title of Sea') as HTMLInputElement).value).toBe('Sea'))
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()

    expect(screen.queryByText('Nothing on it yet.')).toBeNull()
    expect(screen.getByText('Moby-Dick').textContent).toBe('Moby-Dick')
    const note = screen.getByLabelText('Note on Moby-Dick') as HTMLInputElement
    expect(note.disabled).toBe(false)
    fireEvent.change(note, { target: { value: 'n' } })
    expect(screen.queryByRole('button', { name: 'Keep note on Moby-Dick' })).toBeNull()
    fireEvent.change(note, { target: { value: 'new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep note on Moby-Dick' }))
    await waitFor(() => expect(lists.place).toHaveBeenCalledWith('aa', 'book:moby', 'new'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep note on Moby-Dick' })).toBeNull())
  })

  it('draws the lists again only for a new port, empties them when they cannot be read, and lets a slow read not overwrite a later one', async () => {
    const one: OwnListView = { id: 'aa', title: 'Sea', items: [] }
    const first = listsWith([one])
    const view = render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} lists={first} />)
    await screen.findByLabelText('Title of Sea')
    view.rerender(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} lists={listsWith([], { lists: () => Promise.reject(new Error('gone')) })} />)
    /* A new port whose read fails: the failure is said, and nothing is called "no lists". */
    await screen.findByText(/Paper could not read your lists\. gone/u)
    expect(screen.queryByText(/No lists yet/u)).toBeNull()
    cleanup()

    const slow = deferred<OwnListView[]>()
    let calls = 0
    let tell: (() => void) | null = null
    const racing = listsWith([], {
      lists: () => (++calls === 1 ? slow.promise : Promise.resolve([{ id: 'bb', title: 'Deserts', items: [] }])),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={circleWith()} lists={racing} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByLabelText('Title of Deserts')
    slow.resolve([one])
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByLabelText('Title of Sea')).toBeNull()
    expect(screen.getByLabelText('Title of Deserts')).toBeTruthy()
  })
})

describe('the last clauses of the Circle screen — one row each', () => {
  const mo: KnownPerson = { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }
  const circleWith = (over: Partial<CirclePort> = {}): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    cover: () => Promise.resolve(null),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    book: () => Promise.resolve({ people: [], alsoRead: [] }),
    forget: () => Promise.resolve(),
    subscribe: () => () => {},
    ...over,
  })
  const listsWith = (own: OwnListView[], over: Partial<ListsPort> = {}): ListsPort => ({
    lists: () => Promise.resolve(own),
    create: vi.fn(() => Promise.resolve('new1')),
    retitle: vi.fn(() => Promise.resolve()),
    place: vi.fn(() => Promise.resolve()),
    takeOff: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    subscribe: () => () => {},
    ...over,
  })
  const withMo = () => portWith({ people: () => Promise.resolve([mo]) })
  const nobody = () => portWith({ people: () => Promise.resolve([]) })
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }
  const friendView = (over: Partial<FriendView> = {}): FriendView => ({ shelf: [], recent: [], lists: [], ...over })

  it('says an own list is empty, names an item with its author, and offers to keep a note only while it differs', async () => {
    const lists = listsWith([
      { id: 'aa', title: 'Empty', items: [] },
      { id: 'bb', title: 'Sea', items: [{ pub: 'i1', title: 'Moby-Dick', author: 'Herman Melville', position: 1, note: 'n', bookId: 'book:moby' }] },
    ])
    render(<CirclePane port={nobody()} circle={circleWith()} lists={lists} />)
    await screen.findByLabelText('Title of Empty')
    expect(document.querySelector('[data-own-list="aa"]')!.textContent).toContain('Nothing on it yet.')
    expect(document.querySelector('[data-own-list="bb"]')!.textContent).not.toContain('Nothing on it yet.')
    expect(screen.getByText('Moby-Dick — Herman Melville')).toBeTruthy()
    const note = screen.getByLabelText('Note on Moby-Dick') as HTMLInputElement
    fireEvent.change(note, { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Keep note on Moby-Dick' })).toBeTruthy()
    fireEvent.change(note, { target: { value: 'n' } })
    expect(screen.queryByRole('button', { name: 'Keep note on Moby-Dick' })).toBeNull()
  })

  it('lets a slow failing lists read not empty a later one', async () => {
    const slow = deferred<OwnListView[]>()
    let calls = 0
    let tell: (() => void) | null = null
    const lists = listsWith([], {
      lists: () => (++calls === 1 ? slow.promise : Promise.resolve([{ id: 'bb', title: 'Deserts', items: [] }])),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={nobody()} circle={circleWith()} lists={lists} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByLabelText('Title of Deserts')
    slow.reject(new Error('too late'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.getByLabelText('Title of Deserts')).toBeTruthy()
  })

  it('lets a slow friend read that finally lands not overwrite a later one', async () => {
    const slow = deferred<FriendView>()
    let calls = 0
    let tell: (() => void) | null = null
    const circle = circleWith({
      friend: () => (++calls === 1 ? slow.promise : Promise.resolve(friendView({ shelf: [{ pub: 's1', title: 'Dune', author: '', language: 'en', own: null, device: null, cover: null }] }))),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByText('Dune')
    slow.resolve(friendView({ shelf: [{ pub: 's9', title: 'Stale', author: '', language: 'en', own: null, device: null, cover: null }] }))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText('Stale')).toBeNull()
    expect(screen.getByText('Dune')).toBeTruthy()
  })

  it('draws the shelf marker on the reader’s own book only, no Lists heading without lists, and each list item by its own words', async () => {
    const openBook = vi.fn()
    const circle = circleWith({
      friend: () =>
        Promise.resolve(
          friendView({
            shelf: [
              { pub: 's1', title: 'Moby-Dick', author: '', language: 'en', own: 'book:moby', device: null, cover: null },
              { pub: 's2', title: 'Ulysses', author: '', language: 'en', own: null, device: null, cover: null },
            ],
            lists: [
              {
                id: 'aa',
                title: 'Sea',
                items: [
                  { pub: 'i1', title: 'Moby-Dick', author: '', note: '', own: 'book:moby' },
                  { pub: 'i2', title: 'Emma', author: 'Jane Austen', note: 'later', own: null },
                ],
              },
              { id: 'bb', title: 'Bare', items: [] },
            ],
          }),
        ),
    })
    render(<CirclePane port={withMo()} circle={circle} openBook={openBook} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText('Lists')
    expect(document.querySelector('[data-own-book="book:moby"]')!.textContent).toContain('Moby-Dick')
    expect(screen.getByText('Ulysses').closest(`.${CAPABILITY_UI.row}`)!.textContent).toBe('Ulysses')
    expect(document.querySelector('[data-friend-list="bb"]')!.textContent).toContain('Nothing on it yet.')
    expect(document.querySelector('[data-friend-list="aa"]')!.textContent).not.toContain('Nothing on it yet.')
    expect(screen.getByText('Emma — Jane Austen · “later”')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open your copy of Emma' })).toBeNull()
    const opens = screen.getAllByRole('button', { name: 'Open your copy of Moby-Dick' })
    expect(opens).toHaveLength(2)
    fireEvent.click(opens[1]!)
    expect(openBook).toHaveBeenCalledWith('book:moby')
    cleanup()

    /* Without a way to open books: the own copy is marked in words, in the right row only. */
    render(<CirclePane port={withMo()} circle={circle} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText('Lists')
    expect(screen.queryByRole('button', { name: /Open your copy/u })).toBeNull()
    expect(document.querySelector('[data-friend-list="aa"]')!.textContent).toContain('Moby-DickOn your shelf')
    expect(document.querySelector('[data-friend-list="aa"]')!.textContent).not.toContain('”On your shelf')
    expect(document.querySelectorAll('[data-friend-list="aa"] span').length).toBeGreaterThan(0)
    expect([...document.querySelectorAll('[data-friend-list="aa"] span')].filter((one) => one.textContent === 'On your shelf')).toHaveLength(1)
    cleanup()

    const bare = circleWith({ friend: () => Promise.resolve(friendView()) })
    render(<CirclePane port={withMo()} circle={bare} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Their shelf' }))
    await screen.findByText('Mo has shown you no books.')
    expect(screen.queryByText('Lists')).toBeNull()
  })
})

describe('a new person port', () => {
  it('is read afresh, with its own people', async () => {
    const first = portWith({ people: () => Promise.resolve([{ person: 'aa'.repeat(32), displayName: 'Ann', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }]) })
    const view = render(<CirclePane port={first} />)
    await screen.findByText('Ann')
    const second = portWith({ people: () => Promise.resolve([{ person: 'bb'.repeat(32), displayName: 'Bea', roster: { epoch: 1, hlc: 1 }, revoked: [], devices: [] }]) })
    view.rerender(<CirclePane port={second} />)
    await screen.findByText('Bea')
    expect(screen.queryByText('Ann')).toBeNull()
  })
})

describe('the offer’s own clock', () => {
  it('shows the link until the moment it expires, then takes it down with no other change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      vi.setSystemTime(1_700_000_000_000)
      const offer = vi.fn(() => Promise.resolve({ url: 'paper://pair?s=soon', svg: '<svg/>', expiresAt: Date.now() + 1_000 }))
      render(<CirclePane port={portWith({ offer })} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Add somebody/u }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText('paper://pair?s=soon')).toBeTruthy()
      /* One millisecond short: still good. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999)
      })
      expect(screen.queryByText('paper://pair?s=soon')).not.toBeNull()
      /* At expiry, the timer the pane armed takes it down. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2)
      })
      expect(screen.queryByText('paper://pair?s=soon')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes down at once a link that arrives already expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      vi.setSystemTime(1_700_000_000_000)
      const offer = vi.fn(() => Promise.resolve({ url: 'paper://pair?s=old', svg: '<svg/>', expiresAt: Date.now() }))
      render(<CirclePane port={portWith({ offer })} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Add somebody/u }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByText('paper://pair?s=old')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('an act with nowhere of its own to put a failure', () => {
  it('replaces the pane with the failure line', async () => {
    const people: readonly KnownPerson[] = [{ person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 2 }, revoked: [], devices: [] }]
    const forgetPerson = vi.fn(() => Promise.reject(new Error('the peer would not forget')))
    render(<CirclePane port={portWith({ people: () => Promise.resolve(people), forgetPerson })} />)
    await screen.findByText('Mo')
    fireEvent.click(screen.getByRole('button', { name: /Remove/u }))
    await screen.findByText(/Paper could not read your circle\. the peer would not forget/u)
  })
})

describe('the reader’s own lists, read', () => {
  const minimalCircle = (): CirclePort =>
    ({
      showsShelf: () => Promise.resolve(false),
    cover: () => Promise.resolve(null),
      setShowsShelf: () => Promise.resolve(),
      friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
      book: () => Promise.resolve({ people: [], alsoRead: [] }),
      forget: () => Promise.resolve(),
      subscribe: () => () => {},
      dispose: () => {},
    }) as unknown as CirclePort
  const listsOver = (over: Partial<ListsPort>): ListsPort =>
    ({
      lists: () => Promise.resolve([]),
      create: () => Promise.resolve('x'),
      retitle: () => Promise.resolve(),
      place: () => Promise.resolve(),
      takeOff: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      subscribe: () => () => {},
      ...over,
    }) as unknown as ListsPort

  it('says a read that failed, keeps the section, and says nothing about having no lists', async () => {
    let fail = true
    let tell: (() => void) | null = null
    const lists = listsOver({
      lists: () => (fail ? Promise.reject(new Error('the folder would not read')) : Promise.resolve([{ id: 'l1', title: 'Sea', items: [] }])),
      subscribe: (listener: () => void) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={minimalCircle()} lists={lists} />)
    await screen.findByText(/Paper could not read your lists\. the folder would not read/u)
    expect(screen.getByText('Your lists')).toBeTruthy()
    expect(screen.queryByText(/No lists yet/u)).toBeNull()
    /* A later read that succeeds clears the trouble. */
    fail = false
    tell!()
    await screen.findByLabelText('Title of Sea')
    expect(screen.queryByText(/could not read your lists/u)).toBeNull()
  })

  it('lets a newer answer stand when an older read lands after it', async () => {
    let resolveFirst: ((value: OwnListView[]) => void) | null = null
    const first = new Promise<OwnListView[]>((resolve) => {
      resolveFirst = resolve
    })
    let calls = 0
    let tell: (() => void) | null = null
    const lists = listsOver({
      lists: () => (++calls === 1 ? first : Promise.resolve([{ id: 'l2', title: 'Newer', items: [] }])),
      subscribe: (listener: () => void) => {
        tell = listener
        return () => {}
      },
    })
    render(<CirclePane port={portWith({ people: () => Promise.resolve([]) })} circle={minimalCircle()} lists={lists} />)
    await screen.findByText(/holds your keys/u)
    tell!()
    await screen.findByLabelText('Title of Newer')
    resolveFirst!([{ id: 'l1', title: 'Older', items: [] }])
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByLabelText('Title of Older')).toBeNull()
    expect(screen.getByLabelText('Title of Newer')).toBeTruthy()
  })
})
