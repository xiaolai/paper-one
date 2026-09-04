// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Annotation, Highlight } from '../../../kernel'
import type { SharePort, ShareState } from '../lib/sharing'
import { ShareControl } from './ShareControl'

/**
 * The share control — WI-23.A1's surface.
 *
 * What is proven is the control's PROMISES: that it offers Share and, only
 * when there is a note, Share with note; that it withdraws what is out; that
 * an absent Share says why; and that a failed read is shown rather than drawn
 * as "Share".
 */

afterEach(cleanup)

const mark = (over: Partial<Highlight> = {}): Highlight =>
  ({
    id: 'm1',
    bookId: 'book:moby',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)',
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Loomings',
    createdAt: 1,
    ...over,
  }) as Highlight

const portWith = (state: ShareState, over: Partial<SharePort> = {}): SharePort => ({
  state: () => Promise.resolve(state),
  share: vi.fn(() => Promise.resolve()),
  unshare: vi.fn(() => Promise.resolve()),
  subscribe: () => () => {},
  ...over,
})

const button = (name: string) => screen.queryByRole('button', { name })

describe('the share control', () => {
  it('offers Share, and not Share with note, for a bare highlight', async () => {
    render(<ShareControl mark={mark()} port={portWith({ publishability: 'usable', published: false })} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(button('Share with note')).toBeNull()
    expect(button('Withdraw')).toBeNull()
  })

  it('offers the note as a SECOND choice when the mark has one, and shares without it by default', async () => {
    const port = portWith({ publishability: 'usable', published: false })
    const noted = mark({ note: 'the whiteness of the whale' })
    render(<ShareControl mark={noted} port={port} />)
    await waitFor(() => expect(button('Share with note')).not.toBeNull())

    fireEvent.click(button('Share')!)
    await waitFor(() => expect(port.share).toHaveBeenCalledWith(noted, false))

    fireEvent.click(button('Share with note')!)
    await waitFor(() => expect(port.share).toHaveBeenCalledWith(noted, true))
  })

  it('offers Withdraw and no Share for a mark that is out', async () => {
    const port = portWith({ publishability: 'usable', published: true })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    expect(button('Share')).toBeNull()
    expect(screen.getByText('Shared with your circle')).toBeTruthy()

    fireEvent.click(button('Withdraw')!)
    await waitFor(() => expect(port.unshare).toHaveBeenCalledTimes(1))
  })

  it('says why Share is absent rather than greying it out', async () => {
    /* ⚠️ **ABSENT, NOT DISABLED, AND ALWAYS WITH A REASON.** */
    render(<ShareControl mark={mark()} port={portWith({ publishability: 'no-identity', published: false })} />)
    await waitFor(() => expect(screen.getByText('Start a circle to share a passage.')).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('still offers Withdraw for a passage that is out when Share is not offered', async () => {
    /* The passage may still be out there; a reader must never be unable to
       withdraw something that may be. */
    render(<ShareControl mark={mark()} port={portWith({ publishability: 'unreachable', published: true })} />)
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    expect(button('Share')).toBeNull()
  })

  it('shows a failed read instead of offering to publish over it', async () => {
    const port = portWith({ publishability: 'usable', published: false }, {
      state: () => Promise.reject(new Error('shared file for book:moby has no page boundaries')),
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(screen.getByText(/could not read what you have shared/u)).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a share that failed, with its reason', async () => {
    const port = portWith({ publishability: 'usable', published: false }, {
      share: () => Promise.reject(new Error('the disk is full')),
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    await waitFor(() => expect(screen.getByText(/the disk is full/u)).toBeTruthy())
  })

  it('re-asks the port when it is told something changed', async () => {
    let published = false
    let tell: (() => void) | null = null
    const port = portWith({ publishability: 'usable', published }, {
      state: () => Promise.resolve({ publishability: 'usable', published }),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())

    published = true
    tell!()
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    expect(button('Share')).toBeNull()
  })

  it('draws nothing at all without a port', () => {
    const { container } = render(<ShareControl mark={mark()} port={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('clears a failed read once a later read succeeds', async () => {
    let fail = true
    let tell: (() => void) | null = null
    const port = portWith({ publishability: 'usable', published: false }, {
      state: () =>
        fail
          ? Promise.reject(new Error('shared file for book:moby has no page boundaries'))
          : Promise.resolve({ publishability: 'usable', published: false }),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(screen.getByText(/could not read what you have shared/u)).toBeTruthy())

    fail = false
    tell!()
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(screen.queryByText(/could not read/u)).toBeNull()
  })

  /** A read whose answer the test releases by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (cause: Error) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  it('lets a NEWER answer stand when an older read lands after it', async () => {
    /* ⚠️ **AN OLDER ANSWER COULD OVERWRITE A NEWER ONE.** Mount starts a read;
       a change notification starts a second. The second says "out", the first
       — slow — then says "not out". The row must keep showing Withdraw. */
    const first = deferred<ShareState>()
    const second = deferred<ShareState>()
    const answers = [first.promise, second.promise]
    let tell: (() => void) | null = null
    const port = portWith({ publishability: 'usable', published: false }, {
      state: () => answers.shift()!,
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()

    second.resolve({ publishability: 'usable', published: true })
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    first.resolve({ publishability: 'usable', published: false })
    /* Let the stale answer's continuation run, then look again. */
    await new Promise((done) => setTimeout(done, 0))
    expect(button('Withdraw')).not.toBeNull()
    expect(button('Share')).toBeNull()
  })

  it('lets a NEWER answer stand when an older read FAILS after it', async () => {
    /* The same race on the failure path: a stale rejection must not paint a
       failure over a good answer that arrived after it. */
    const first = deferred<ShareState>()
    const second = deferred<ShareState>()
    const answers = [first.promise, second.promise]
    let tell: (() => void) | null = null
    const port = portWith({ publishability: 'usable', published: false }, {
      state: () => answers.shift()!,
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()

    second.resolve({ publishability: 'usable', published: true })
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    first.reject(new Error('too late'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/too late/u)).toBeNull()
    expect(button('Withdraw')).not.toBeNull()
  })

  it('does not paint a stale failure over a good answer, and does not clear a fresh failure with a stale success', async () => {
    /* Mount read fails FIRST while a second, newer read is pending — the
       failure shows. Then the older... no: the NEWER read rejects and the
       OLDER succeeds late; the failure must stay. */
    const first = deferred<ShareState>()
    const second = deferred<ShareState>()
    const answers = [first.promise, second.promise]
    let tell: (() => void) | null = null
    const port = portWith({ publishability: 'usable', published: false }, {
      state: () => answers.shift()!,
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()

    second.reject(new Error('the newer read failed'))
    await waitFor(() => expect(screen.getByText(/the newer read failed/u)).toBeTruthy())
    first.resolve({ publishability: 'usable', published: false })
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.getByText(/the newer read failed/u)).toBeTruthy()
    expect(button('Share')).toBeNull()
  })

  it('does not offer the note when it is only whitespace', async () => {
    render(<ShareControl mark={mark({ note: '   ' })} port={portWith({ publishability: 'usable', published: false })} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(button('Share with note')).toBeNull()
  })

  it('draws no reason at all when Share is offered, or when the mark is out', async () => {
    /* An empty hint under every shareable mark is a gap that reads as a
       missing sentence. The reason appears ONLY when Share is absent. */
    const offered = render(<ShareControl mark={mark()} port={portWith({ publishability: 'usable', published: false })} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(offered.container.querySelector('.paper-cap-hint')).toBeNull()
    cleanup()
    const out = render(<ShareControl mark={mark()} port={portWith({ publishability: 'no-identity', published: true })} />)
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
    expect(out.container.querySelector('.paper-cap-hint')).toBeNull()
  })

  it('re-asks for a different mark, and for a different port', async () => {
    /* Marginalia reuses a row's component across marks when the list
       reorders, so the control must follow the MARK it is handed, and a
       restart hands it a new port. */
    const first = vi.fn((_mark: Annotation) => Promise.resolve({ publishability: 'usable', published: false } as ShareState))
    const port = portWith({ publishability: 'usable', published: false }, { state: first })
    const view = render(<ShareControl mark={mark({ id: 'm1' })} port={port} />)
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(first.mock.calls[0]![0]).toMatchObject({ id: 'm1' })

    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    await waitFor(() => expect(first).toHaveBeenCalledTimes(2))
    expect(first.mock.calls[1]![0]).toMatchObject({ id: 'm2' })

    const second = vi.fn((_mark: Annotation) => Promise.resolve({ publishability: 'usable', published: true } as ShareState))
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={portWith({ publishability: 'usable', published: true }, { state: second })} />)
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
  })

  it('shows a busy control as disabled while a share is in flight, and enabled after', async () => {
    const pending = deferred<void>()
    const port = portWith({ publishability: 'usable', published: false }, { share: () => pending.promise })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    await waitFor(() => expect((button('Share') as HTMLButtonElement).disabled).toBe(true))
    pending.resolve()
    await waitFor(() => expect((button('Share') as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('an act that does not go through', () => {
  it('says so beside the buttons and keeps them, so the button is the way to try again', async () => {
    const port = portWith({ publishability: 'usable', published: false }, { share: vi.fn(() => Promise.reject(new Error('the shelf is asleep'))) })
    render(<ShareControl mark={mark()} port={port} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await screen.findByText(/That did not go through\. the shelf is asleep/u)
    expect(button('Share')).toBeTruthy()
    fireEvent.click(button('Share')!)
    await waitFor(() => expect(port.share).toHaveBeenCalledTimes(2))
  })
})

describe('a row reused for another mark', () => {
  it('draws nothing of the previous mark until the new one has been read', async () => {
    let answer: ((state: ShareState) => void) | null = null
    const slow = new Promise<ShareState>((resolve) => {
      answer = resolve
    })
    let asked = 0
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      state: () => (++asked === 1 ? Promise.resolve({ publishability: 'usable', published: false } as ShareState) : slow),
    })
    const view = render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    /* The first mark's buttons are gone at once, not carried over. */
    await waitFor(() => expect(button('Share')).toBeNull())
    answer!({ publishability: 'usable', published: true } as ShareState)
    await waitFor(() => expect(button('Withdraw')).not.toBeNull())
  })

  it('does not report an act begun on the previous mark', async () => {
    let fail: ((cause: Error) => void) | null = null
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      share: vi.fn(() => new Promise<void>((_, reject) => {
        fail = reject
      })),
    })
    const view = render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fail!(new Error('the first mark would not share'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/the first mark would not share/u)).toBeNull()
    expect((button('Share') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the control, held to the letter', () => {
  const deferredVoid = () => {
    let reject: (cause: Error) => void = () => {}
    let resolve: () => void = () => {}
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('starts with its buttons enabled', async () => {
    render(<ShareControl mark={mark()} port={portWith({ publishability: 'usable', published: false } as ShareState)} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect((button('Share') as HTMLButtonElement).disabled).toBe(false)
  })

  it('drops the previous mark’s failed read and failed act when the mark changes', async () => {
    let calls = 0
    const share = vi.fn(() => Promise.reject(new Error('would not share')))
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      state: () => (++calls === 1 ? Promise.resolve({ publishability: 'usable', published: false } as ShareState) : Promise.resolve({ publishability: 'usable', published: false } as ShareState)),
      share,
    })
    const view = render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    await screen.findByText(/would not share/u)
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(screen.queryByText(/would not share/u)).toBeNull()
  })

  it('drops a failed read once the mark changes', async () => {
    let calls = 0
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      state: () => (++calls === 1 ? Promise.reject(new Error('file gone')) : Promise.resolve({ publishability: 'usable', published: false } as ShareState)),
    })
    const view = render(<ShareControl mark={mark()} port={port} />)
    await screen.findByText(/file gone/u)
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    expect(screen.queryByText(/file gone/u)).toBeNull()
  })

  it('clears the last act’s trouble when the next act starts', async () => {
    let fail = true
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      share: vi.fn(() => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve())),
    })
    render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    await screen.findByText(/disk full/u)
    fail = false
    fireEvent.click(button('Share')!)
    await waitFor(() => expect(screen.queryByText(/disk full/u)).toBeNull())
  })

  it('does not re-enable the new mark’s buttons when the previous mark’s act settles', async () => {
    const first = deferredVoid()
    const second = deferredVoid()
    let acts = 0
    const port = portWith({ publishability: 'usable', published: false } as ShareState, {
      share: vi.fn(() => (++acts === 1 ? first.promise : second.promise)),
    })
    const view = render(<ShareControl mark={mark()} port={port} />)
    await waitFor(() => expect(button('Share')).not.toBeNull())
    fireEvent.click(button('Share')!)
    view.rerender(<ShareControl mark={mark({ id: 'm2' })} port={port} />)
    await waitFor(() => expect((button('Share') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button('Share')!)
    expect((button('Share') as HTMLButtonElement).disabled).toBe(true)
    first.reject(new Error('the first mark failed late'))
    await new Promise((done) => setTimeout(done, 0))
    expect((button('Share') as HTMLButtonElement).disabled).toBe(true)
    second.resolve()
    await waitFor(() => expect((button('Share') as HTMLButtonElement).disabled).toBe(false))
  })
})
