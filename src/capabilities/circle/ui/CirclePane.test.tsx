// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnownPerson, PersonPort, PersonStatus } from '../../peer'
import { CirclePane } from './CirclePane'

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
        devices={1}
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
        devices={1}
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
    render(<CirclePane port={portWith({ people: () => Promise.reject(new Error('keychain locked')) })} devices={1} />)

    await screen.findByText(/could not read your circle/u)
    expect(screen.queryByText(/Nothing is shared until you add somebody/u)).toBeNull()
  })

  it('shows the standing marker when the circle lives on one device', async () => {
    /* `identity.md`: *"'one device, no copy' is a state Paper surfaces
       continuously — not a moment it hopes to catch."* */
    render(<CirclePane port={portWith({ status: () => Promise.resolve(status({ atRisk: true, devices: 1 })) })} devices={1} />)

    await screen.findByText(/lives on this device alone/u)
  })

  it('does not show it when a second device holds the identity too', async () => {
    // A marker that fires for everyone is wallpaper.
    render(<CirclePane port={portWith()} devices={2} />)

    await screen.findByText(/holds your keys/u)
    expect(screen.queryByText(/lives on this device alone/u)).toBeNull()
  })

  it('keeps the twelve words hidden until they are asked for', async () => {
    /* The one command that returns a secret, called only when a reader pressed
       the button that says so. */
    const phrase = vi.fn(() => Promise.resolve('abandon abandon about'))
    render(<CirclePane port={portWith({ phrase })} devices={2} />)
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
    render(<CirclePane port={portWith()} devices={2} />)
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
      { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 2 }, revoked: [] },
    ]
    render(<CirclePane port={portWith({ people: () => Promise.resolve(people) })} devices={2} />)

    await screen.findByText('Mo')
    await screen.findByText(/What they already shared stays until you clear it/u)
  })

  it('removes somebody when asked', async () => {
    const forgetPerson = vi.fn(() => Promise.resolve())
    const people: readonly KnownPerson[] = [
      { person: 'ff'.repeat(32), displayName: 'Mo', roster: { epoch: 1, hlc: 2 }, revoked: [] },
    ]
    render(<CirclePane port={portWith({ people: () => Promise.resolve(people), forgetPerson })} devices={2} />)
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
    const { rerender } = render(<CirclePane port={portWith({ people })} devices={2} />)
    await screen.findByText(/holds your keys/u)

    /* A re-render from the parent, exactly as the side pane does. */
    rerender(<CirclePane port={portWith({ people })} devices={2} />)
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
    render(<CirclePane port={portWith({ offer })} devices={2} />)
    await screen.findByText(/holds your keys/u)

    const add = screen.getByRole('button', { name: /Add somebody/u })
    await act(async () => { fireEvent.click(add) })

    expect(offer).toHaveBeenCalledTimes(1)
    await screen.findByText('paper://pair?s=abc')
  })

  it('joins a friend’s link and shows the digits to compare', async () => {
    const join = vi.fn(() => Promise.resolve({ sas: '481902' }))
    render(<CirclePane port={portWith({ join })} devices={2} />)
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
    render(<CirclePane port={portWith({ onPending, confirm })} devices={2} />)
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
    }
    const port = portWith({
      people: () => new Promise<readonly KnownPerson[]>((r) => settle.push(r)),
    })
    const { rerender } = render(<CirclePane port={port} devices={2} />)
    await waitFor(() => expect(settle).toHaveLength(1))

    /* A second read starts and finishes FIRST. */
    rerender(<CirclePane port={port} devices={3} />)
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
    const port = portWith({
      phrase: () => new Promise<string | null>((r) => settle.push(r)),
      status: () => Promise.resolve(status({ personId: who })),
    })
    const { rerender } = render(<CirclePane port={port} devices={2} />)
    await screen.findByText(/holds your keys/u)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Show my twelve words/u }))
    })
    await waitFor(() => expect(settle).toHaveLength(1))

    /* The identity changes while that read is still out. */
    who = 'bb'.repeat(32)
    rerender(<CirclePane port={port} devices={3} />)
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
        devices={2}
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
    render(<CirclePane port={port} devices={2} />)
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
        devices={2}
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
    render(<CirclePane port={null} devices={0} />)

    await screen.findByText(/needs Paper's own app/u)
  })

  it('never puts the whole person id on screen', async () => {
    // Nobody reads a 64-hex public key, so nobody is shown one.
    const full = status().personId ?? ''
    render(<CirclePane port={portWith()} devices={2} />)
    await screen.findByText(/holds your keys/u)

    expect(screen.queryByText(full)).toBeNull()
    await screen.findByText(new RegExp(full.slice(0, 8), 'u'))
  })
})
