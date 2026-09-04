// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CirclePort } from '../lib/circlePort'
import type { CircleView } from '../lib/circleView'
import type { ListsPort, OwnListView } from '../lib/listsPort'
import type { BookPort, OwnOpinion } from '../lib/opinionPort'
import { CAPABILITY_UI } from '../../../kernel'
import { BookPane } from './BookPane'

/**
 * The book's surface — WI-23.B4.
 *
 * What is proven: the reader's own controls write through the port, the
 * switch turns and its copy says what turning it off does NOT do, and the
 * pane says so plainly when there is no book.
 */

afterEach(cleanup)

const own = (over: Partial<OwnOpinion> = {}): OwnOpinion => ({
  title: 'Moby-Dick',
  status: null,
  stars: null,
  review: '',
  tags: [],
  ...over,
})

const portWith = (opinion: OwnOpinion | null = own(), publishing = false, over: Partial<BookPort> = {}): BookPort => ({
  own: () => Promise.resolve(opinion),
  setStatus: vi.fn(() => Promise.resolve()),
  setStars: vi.fn(() => Promise.resolve()),
  setReview: vi.fn(() => Promise.resolve()),
  publishing: () => Promise.resolve(publishing),
  setPublishing: vi.fn(() => Promise.resolve()),
  subscribe: () => () => {},
  ...over,
})

const draw = (port: BookPort | null, bookId: string | null = 'book:moby', circle: CirclePort | null = null) =>
  render(<BookPane bookId={bookId} port={port} circle={circle} />)

describe('the book pane', () => {
  it('says to open a book when none is open', () => {
    draw(portWith(), null)
    expect(screen.getByText(/Open a book to say what you think of it/u)).toBeTruthy()
  })

  it('draws nothing without a port', () => {
    const { container } = draw(null)
    expect(container.innerHTML).toBe('')
  })

  it('writes a status through the port, and shows the one held', async () => {
    const port = portWith(own({ status: 'reading' }))
    draw(port)
    const reading = await screen.findByRole('button', { name: 'Reading' })
    expect(reading.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Finished' }))
    await waitFor(() => expect(port.setStatus).toHaveBeenCalledWith('book:moby', 'finished'))
  })

  it('writes a rating through the port, and lights the stars up to the one held', async () => {
    const port = portWith(own({ stars: 3 }))
    draw(port)
    await screen.findByRole('button', { name: '3 stars' })
    const lit = (n: number) => screen.getByRole('button', { name: n === 1 ? '1 star' : `${n} stars` }).className.includes('primary')
    expect([1, 2, 3, 4, 5].map(lit)).toEqual([true, true, true, false, false])
    fireEvent.click(screen.getByRole('button', { name: '5 stars' }))
    await waitFor(() => expect(port.setStars).toHaveBeenCalledWith('book:moby', 5))
  })

  it('keeps a review only when asked to, and offers to only once it differs', async () => {
    const port = portWith(own({ review: 'first' }))
    draw(port)
    const field = (await screen.findByLabelText('Review')) as HTMLTextAreaElement
    expect(field.value).toBe('first')
    expect(screen.queryByRole('button', { name: 'Keep review' })).toBeNull()
    fireEvent.change(field, { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep review' }))
    await waitFor(() => expect(port.setReview).toHaveBeenCalledWith('book:moby', 'second'))
  })

  it('turns the switch, and its copy says what turning it off keeps', async () => {
    const port = portWith(own(), false)
    draw(port)
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByText(/Turning this off later keeps what was already shared/u)).toBeTruthy()
    fireEvent.click(box)
    await waitFor(() => expect(port.setPublishing).toHaveBeenCalledWith('book:moby', true))

    cleanup()
    draw(portWith(own(), true))
    const on = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(on.checked).toBe(true)
    expect(screen.getByText(/follow your changes/u)).toBeTruthy()
  })

  it('shows a failed read rather than an empty opinion', async () => {
    draw(portWith(own(), false, { own: () => Promise.reject(new Error('shared file for moby will not read')) }))
    await screen.findByText(/could not read this book’s circle/u)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('re-reads when the port says something changed', async () => {
    let publishing = false
    let tell: (() => void) | null = null
    draw(
      portWith(own(), false, {
        publishing: () => Promise.resolve(publishing),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    expect(box.checked).toBe(false)
    publishing = true
    tell!()
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true))
  })

  it('drops a draft when the book changes', async () => {
    const port = portWith(own({ review: 'about moby' }))
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    const field = (await screen.findByLabelText('Review')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'typing about moby' } })
    view.rerender(<BookPane bookId="book:other" port={portWith(own({ title: 'Other', review: '' }))} circle={null} />)
    await waitFor(() => expect((screen.getByLabelText('Review') as HTMLTextAreaElement).value).toBe(''))
  })
})

describe('every clause of the pane — one row each', () => {
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }
  const pressed = (names: readonly string[]) => names.map((name) => screen.getByRole('button', { name }).getAttribute('aria-pressed'))
  const STAR_NAMES = ['1 star', '2 stars', '3 stars', '4 stars', '5 stars']

  it('names the three states in order, presses only the one held, and lights only it', async () => {
    draw(portWith(own({ status: 'reading' })))
    const group = await screen.findByRole('group', { name: 'Reading status' })
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons.map((one) => one.textContent)).toEqual(['Want to read', 'Reading', 'Finished'])
    expect(buttons.map((one) => one.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect(buttons.map((one) => one.className.includes('primary'))).toEqual([false, true, false])
    /* The unlit ones carry the plain button class and nothing else. */
    expect(buttons[0]!.className.trim()).toBe(CAPABILITY_UI.button)
  })

  it('presses only the star held, and with no rating presses and lights none', async () => {
    draw(portWith(own({ stars: 3 })))
    await screen.findByRole('button', { name: '3 stars' })
    expect(pressed(STAR_NAMES)).toEqual(['false', 'false', 'true', 'false', 'false'])
    cleanup()
    draw(portWith(own({ stars: null })))
    await screen.findByRole('button', { name: '3 stars' })
    expect(pressed(STAR_NAMES)).toEqual(['false', 'false', 'false', 'false', 'false'])
    expect(STAR_NAMES.map((name) => screen.getByRole('button', { name }).className.trim())).toEqual(STAR_NAMES.map(() => CAPABILITY_UI.button))
  })

  it('offers to keep a draft only while it differs, and shows what the port holds once kept', async () => {
    const port = portWith(own({ review: 'first' }))
    draw(port)
    const field = (await screen.findByLabelText('Review')) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: 'second' } })
    expect(screen.getByRole('button', { name: 'Keep review' }).className.includes('primary')).toBe(true)
    /* Typed back to what is held: nothing to keep. */
    fireEvent.change(field, { target: { value: 'first' } })
    expect(screen.queryByRole('button', { name: 'Keep review' })).toBeNull()
    fireEvent.change(field, { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep review' }))
    /* This port does not remember: the pane shows what it holds, not the draft. */
    await waitFor(() => expect((screen.getByLabelText('Review') as HTMLTextAreaElement).value).toBe('first'))
    expect(screen.queryByRole('button', { name: 'Keep review' })).toBeNull()
  })

  it('shows a failed write, and disables every control only while one is in flight', async () => {
    const pending = deferred<void>()
    const port = portWith(own(), false, { setStatus: vi.fn(() => pending.promise) })
    draw(port)
    const finished = await screen.findByRole('button', { name: 'Finished' })
    fireEvent.click(finished)
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByLabelText('Review') as HTMLTextAreaElement).disabled).toBe(true)
    pending.reject(new Error('the shared file would not write'))
    await screen.findByText(/the shared file would not write/u)
    cleanup()

    const second = portWith(own(), false, { setStatus: vi.fn(() => Promise.resolve()) })
    draw(second)
    fireEvent.click(await screen.findByRole('button', { name: 'Finished' }))
    await waitFor(() => expect(second.setStatus).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false))
  })

  it('clears a failure once a later read succeeds', async () => {
    let fails = true
    let tell: (() => void) | null = null
    draw(
      portWith(own(), false, {
        own: () => (fails ? Promise.reject(new Error('not yet')) : Promise.resolve(own())),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await screen.findByText(/not yet/u)
    fails = false
    tell!()
    await screen.findByRole('checkbox')
    expect(screen.queryByText(/not yet/u)).toBeNull()
  })

  it('lets a slow first read neither overwrite nor fail a later one', async () => {
    const slow = deferred<OwnOpinion | null>()
    let calls = 0
    let tell: (() => void) | null = null
    draw(
      portWith(own(), false, {
        own: () => (++calls === 1 ? slow.promise : Promise.resolve(own({ status: 'finished' }))),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByRole('button', { name: 'Finished' })
    expect(pressed(['Finished'])).toEqual(['true'])
    /* The slow one lands with a different word, and then with a failure. */
    slow.resolve(own({ status: 'want' }))
    await new Promise((done) => setTimeout(done, 0))
    expect(pressed(['Finished'])).toEqual(['true'])
    expect(screen.queryByText(/could not read/u)).toBeNull()
    cleanup()

    const late = deferred<OwnOpinion | null>()
    calls = 0
    draw(
      portWith(own(), false, {
        own: () => (++calls === 1 ? late.promise : Promise.resolve(own())),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByRole('checkbox')
    late.reject(new Error('too late to matter'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/too late to matter/u)).toBeNull()
  })

  it('reads nothing when there is no book, whatever port it has', async () => {
    const port = portWith(own(), false, { own: vi.fn(() => Promise.resolve(own())) })
    draw(port, null)
    await screen.findByText(/Open a book/u)
    expect(port.own).not.toHaveBeenCalled()
  })
})

describe('the circle’s view of the book — WI-23.D1, D2, D3', () => {
  const circleWith = (view: CircleView, over: Partial<CirclePort> = {}): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    cover: () => Promise.resolve(null),
    book: () => Promise.resolve(view),
    forget: () => Promise.resolve(),
    subscribe: () => () => {},
    ...over,
  })
  const surface = () => document.querySelector('[data-circle-view]')!.textContent ?? ''

  it('says who has it, where they are in it, and how many gave it four stars or more — and never a decimal', async () => {
    const view: CircleView = {
      people: [
        { person: 'a', name: 'Alice', has: true, status: 'finished', stars: 5, reviews: [] },
        { person: 'b', name: 'Bob', has: true, status: 'finished', stars: 4, reviews: [] },
        { person: 'c', name: 'Carol', has: false, status: 'reading', stars: 3, reviews: [] },
      ],
      alsoRead: [],
    }
    draw(portWith(), 'book:moby', circleWith(view))
    await screen.findByText('Alice and Bob have this.')
    expect(surface()).toContain('Carol is reading it.')
    expect(surface()).toContain('Alice and Bob finished it.')
    expect(surface()).toContain('Alice, Bob and Carol rated it: 2 of 3 gave it four stars or more.')
    expect(surface()).toContain('5 of 5 stars')
    /* THE FALSIFIER: a mean would be 4.0 here. */
    expect(surface()).not.toMatch(/\d\.\d/u)
  })

  it('draws a review under the name, and says so when nobody said anything', async () => {
    draw(
      portWith(),
      'book:moby',
      circleWith({
        people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [{ text: 'Long, and worth it.', at: 'x' as never }] }],
        alsoRead: [],
      }),
    )
    await screen.findByText('Alice: “Long, and worth it.”')
    cleanup()
    draw(portWith(), 'book:moby', circleWith({ people: [], alsoRead: [] }))
    await screen.findByText(/Nobody in your circle has said anything about this book/u)
  })

  it('lists what friends who have it also have, by name and never by count, and links the ones on the shelf', async () => {
    const openBook = vi.fn()
    render(
      <BookPane
        bookId="book:moby"
        port={portWith()}
        circle={circleWith({
          people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }],
          alsoRead: [
            { key: 'k:Dune:Frank Herbert', title: 'Dune', author: 'Frank Herbert', names: ['Alice'], own: 'book:dune' },
            { key: 'k:Emma:', title: 'Emma', author: '', names: ['Alice'], own: null },
          ],
        })}
        openBook={openBook}
      />,
    )
    await screen.findByText(/Alice also has Dune — Frank Herbert/u)
    expect(screen.getByText(/Alice also has Emma/u)).toBeTruthy()
    /* One friend: a name each and no number anywhere. */
    expect(surface().replace(/of 5 stars/gu, '')).not.toMatch(/\d/u)
    fireEvent.click(screen.getByRole('button', { name: 'Open your copy of Dune' }))
    expect(openBook).toHaveBeenCalledWith('book:dune')
    expect(screen.getAllByRole('button', { name: /Open your copy/u })).toHaveLength(1)
  })

  it('re-reads when the circle says something changed, and draws the view empty when it cannot be read', async () => {
    let tell: (() => void) | null = null
    let fails = true
    draw(
      portWith(),
      'book:moby',
      circleWith({ people: [], alsoRead: [] }, {
        book: () =>
          fails
            ? Promise.reject(new Error('shelf unreadable'))
            : Promise.resolve({ people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] }),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await screen.findByText(/Nobody in your circle/u)
    expect(screen.queryByText(/shelf unreadable/u)).toBeNull()
    fails = false
    tell!()
    await screen.findByText('Alice has this.')
  })

  it('draws no circle section without a circle, or without a book', async () => {
    draw(portWith(), 'book:moby', null)
    await screen.findByRole('checkbox')
    expect(document.querySelector('[data-circle-view]')).toBeNull()
    cleanup()
    const circle = circleWith({ people: [], alsoRead: [] }, { book: vi.fn(() => Promise.resolve({ people: [], alsoRead: [] })) })
    draw(portWith(), null, circle)
    await screen.findByText(/Open a book/u)
    expect(circle.book).not.toHaveBeenCalled()
  })
})

describe('the reader’s own lists, beside the book — WI-23.E1', () => {
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
  const onIt: OwnListView = { id: 'aa', title: 'Sea books', items: [{ pub: 'i1', title: 'Moby-Dick', author: 'Herman Melville', position: 1, note: '', bookId: 'book:moby' }] }
  const notOnIt: OwnListView = { id: 'bb', title: 'Deserts', items: [{ pub: 'i2', title: 'Dune', author: 'Frank Herbert', position: 1, note: '', bookId: 'book:dune' }] }

  it('offers to put the book on a list it is not on, and to take it off one it is on', async () => {
    const lists = listsWith([onIt, notOnIt])
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Put this book on Deserts' }))
    await waitFor(() => expect(lists.place).toHaveBeenCalledWith('bb', 'book:moby'))
    fireEvent.click(screen.getByRole('button', { name: 'Take this book off Sea books' }))
    await waitFor(() => expect(lists.takeOff).toHaveBeenCalledWith('aa', 'i1'))
  })

  it('starts a new list with the book, only once it has a title', async () => {
    const lists = listsWith([])
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    const start = await screen.findByRole('button', { name: 'Start list' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('New list'), { target: { value: '  Whales ' } })
    expect((screen.getByRole('button', { name: 'Start list' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(lists.create).toHaveBeenCalledWith('Whales'))
    await waitFor(() => expect(lists.place).toHaveBeenCalledWith('new1', 'book:moby'))
    await waitFor(() => expect((screen.getByLabelText('New list') as HTMLInputElement).value).toBe(''))
  })

  it('re-reads when the lists say something changed, shows a refused act, and draws nothing without the port', async () => {
    let tell: (() => void) | null = null
    let own: OwnListView[] = []
    const lists = listsWith([], {
      lists: () => Promise.resolve(own),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
      place: () => Promise.reject(new Error('Start a circle to keep a list.')),
    })
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await screen.findByText('Your lists')
    expect(screen.queryByRole('button', { name: /Put this book on/u })).toBeNull()
    own = [notOnIt]
    tell!()
    fireEvent.click(await screen.findByRole('button', { name: 'Put this book on Deserts' }))
    await screen.findByText(/Start a circle to keep a list/u)
    cleanup()
    draw(portWith(), 'book:moby', null)
    await screen.findByRole('checkbox')
    expect(document.querySelector('[data-own-lists]')).toBeNull()
  })
})

describe('every clause of the circle’s view and the lists on the pane — one row each', () => {
  const circleWith = (view: CircleView, over: Partial<CirclePort> = {}): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    cover: () => Promise.resolve(null),
    book: () => Promise.resolve(view),
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
  const surface = () => document.querySelector('[data-circle-view]')!.textContent ?? ''
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  it('draws a stars row only for a person who rated it, no "also have" heading when nobody has, and the plural for two names', async () => {
    draw(
      portWith(),
      'book:moby',
      circleWith({
        people: [
          { person: 'a', name: 'Alice', has: true, status: 'finished', stars: null, reviews: [] },
          { person: 'b', name: 'Bob', has: false, status: null, stars: 4, reviews: [] },
        ],
        alsoRead: [],
      }),
    )
    await screen.findByText('Alice has this.')
    expect(surface().match(/of 5 stars/gu)).toHaveLength(1)
    expect(surface()).toContain('Bob4 of 5 stars')
    expect(surface()).not.toContain('Friends who have this also have')
    cleanup()
    draw(
      portWith(),
      'book:moby',
      circleWith({
        people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }],
        alsoRead: [{ key: 'k:Emma:', title: 'Emma', author: '', names: ['Alice', 'Bob'], own: 'book:emma' }],
      }),
    )
    await screen.findByText('Alice and Bob also have Emma')
    /* No author: no dash; on the shelf with nothing to open it: the plain words. */
    expect(screen.getByText('Alice and Bob also have Emma').textContent).toBe('Alice and Bob also have Emma')
    expect(screen.getByText('On your shelf').tagName).toBe('SPAN')
    expect(screen.queryByRole('button', { name: /Open your copy/u })).toBeNull()
  })

  it('re-reads the view for a new book and forgets the old one meanwhile', async () => {
    const slow = deferred<CircleView>()
    const circle = circleWith({ people: [], alsoRead: [] }, {
      book: (bookId) =>
        bookId === 'book:moby'
          ? Promise.resolve({ people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] })
          : slow.promise,
    })
    const view = render(<BookPane bookId="book:moby" port={portWith()} circle={circle} />)
    await screen.findByText('Alice has this.')
    view.rerender(<BookPane bookId="book:other" port={portWith(own({ title: 'Other' }))} circle={circle} />)
    await waitFor(() => expect(screen.queryByText('Alice has this.')).toBeNull())
    slow.resolve({ people: [{ person: 'b', name: 'Bob', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] })
    await screen.findByText('Bob has this.')
  })

  it('lets a slow view read neither overwrite nor empty a later one', async () => {
    const slow = deferred<CircleView>()
    let calls = 0
    let tell: (() => void) | null = null
    draw(
      portWith(),
      'book:moby',
      circleWith({ people: [], alsoRead: [] }, {
        book: () => (++calls === 1 ? slow.promise : Promise.resolve({ people: [{ person: 'b', name: 'Bob', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] })),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByText('Bob has this.')
    slow.resolve({ people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] })
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.getByText('Bob has this.')).toBeTruthy()
    expect(screen.queryByText('Alice has this.')).toBeNull()
    cleanup()

    const late = deferred<CircleView>()
    calls = 0
    /* The listener the FIRST pane registered, or the tell below reaches a component that has gone and the late read is never begun. */
    tell = null
    draw(
      portWith(),
      'book:moby',
      circleWith({ people: [], alsoRead: [] }, {
        book: () => (++calls === 1 ? late.promise : Promise.resolve({ people: [{ person: 'b', name: 'Bob', has: true, status: null, stars: null, reviews: [] }], alsoRead: [] })),
        subscribe: (listener) => {
          tell = listener
          return () => {}
        },
      }),
    )
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByText('Bob has this.')
    late.reject(new Error('too late'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.getByText('Bob has this.')).toBeTruthy()
  })

  it('labels each list by whether the book is on it, and draws the lists again for a new port only', async () => {
    const onIt: OwnListView = { id: 'aa', title: 'Sea', items: [{ pub: 'i1', title: 'Moby-Dick', author: '', position: 1, note: '', bookId: 'book:moby' }] }
    const off: OwnListView = { id: 'bb', title: 'Deserts', items: [] }
    const first = listsWith([onIt, off])
    const view = render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={first} />)
    expect((await screen.findByRole('button', { name: 'Take this book off Sea' })).textContent).toBe('On it — take off')
    expect(screen.getByRole('button', { name: 'Put this book on Deserts' }).textContent).toBe('Put on')
    const second = listsWith([off])
    view.rerender(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={second} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Take this book off Sea' })).toBeNull())
    /* The lists are read again once the new port's opinion has landed — the
       gate the whole pane waits behind — so they are awaited, not expected. */
    expect(await screen.findByRole('button', { name: 'Put this book on Deserts' })).toBeTruthy()
  })

  it('says when the lists cannot be read, keeps the last ones read, and lets a slow read not overwrite a later one', async () => {
    const lists = listsWith([], { lists: () => Promise.reject(new Error('no lists dir')) })
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await screen.findByText('Your lists')
    expect(screen.getByText(/Paper could not read your lists\. no lists dir/u)).toBeTruthy()
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
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={racing} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByRole('button', { name: 'Put this book on Deserts' })
    slow.resolve([{ id: 'aa', title: 'Sea', items: [] }])
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByRole('button', { name: 'Put this book on Sea' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Put this book on Deserts' })).toBeTruthy()
  })
})

describe('the last clauses of the pane — one row each', () => {
  const circleWith = (view: CircleView): CirclePort => ({
    showsShelf: () => Promise.resolve(false),
    setShowsShelf: () => Promise.resolve(),
    friend: () => Promise.resolve({ shelf: [], recent: [], lists: [] }),
    cover: () => Promise.resolve(null),
    book: () => Promise.resolve(view),
    forget: () => Promise.resolve(),
    subscribe: () => () => {},
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
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  it('marks only the works on the shelf as such', async () => {
    draw(
      portWith(),
      'book:moby',
      circleWith({
        people: [{ person: 'a', name: 'Alice', has: true, status: null, stars: null, reviews: [] }],
        alsoRead: [
          { key: 'k:Emma:', title: 'Emma', author: '', names: ['Alice'], own: 'book:emma' },
          { key: 'k:Zorba:', title: 'Zorba', author: '', names: ['Alice'], own: null },
        ],
      }),
    )
    await screen.findByText('Alice also has Zorba')
    expect(screen.getAllByText('On your shelf')).toHaveLength(1)
  })

  it('reads the lists of a new port, showing none of the old ones while the new read is out', async () => {
    const first = listsWith([{ id: 'aa', title: 'Sea', items: [] }])
    const view = render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={first} />)
    await screen.findByRole('button', { name: 'Put this book on Sea' })
    const pending = deferred<OwnListView[]>()
    const second = listsWith([], { lists: () => pending.promise })
    view.rerender(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={second} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Put this book on Sea' })).toBeNull())
    pending.resolve([{ id: 'zz', title: 'Zebras', items: [] }])
    await screen.findByRole('button', { name: 'Put this book on Zebras' })
    expect(screen.queryByRole('button', { name: 'Put this book on Sea' })).toBeNull()
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
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByRole('button', { name: 'Put this book on Deserts' })
    slow.reject(new Error('too late'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.getByRole('button', { name: 'Put this book on Deserts' })).toBeTruthy()
  })
})

describe('what the pane says when the read comes back', () => {
  it('says the book is not on the shelf, rather than staying blank for ever', async () => {
    draw(portWith(null))
    await screen.findByText(/not on your shelf/u)
  })

  it('keeps the controls and says so beside them when an act fails', async () => {
    draw(portWith(own(), false, { setStatus: vi.fn(() => Promise.reject(new Error('disk full'))) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    await screen.findByText(/That did not save\. disk full/u)
    /* The way to try again is the button the reader just pressed. */
    expect(screen.getByRole('group', { name: 'Reading status' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Reading' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the pane’s state belongs to one book', () => {
  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {}
    let reject: (cause: Error) => void = () => {}
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('starts with its controls enabled and no trouble line', async () => {
    draw(portWith())
    const reading = (await screen.findByRole('button', { name: 'Reading' })) as HTMLButtonElement
    expect(reading.disabled).toBe(false)
    expect(screen.queryByText(/That did not save/u)).toBeNull()
    expect(screen.queryByText(/could not read your lists/u)).toBeNull()
  })

  it('draws nothing of the previous book until the next one has been read', async () => {
    const slow = deferred<OwnOpinion>()
    let calls = 0
    const port = portWith(own({ status: 'finished' }), false, {
      own: (bookId) => (++calls === 1 ? Promise.resolve(own({ status: 'finished' })) : bookId === 'book:dune' ? slow.promise : Promise.resolve(own())),
    })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    await screen.findByRole('group', { name: 'Reading status' })
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Reading status' })).toBeNull())
    slow.resolve(own({ status: 'want' }))
    await screen.findByRole('group', { name: 'Reading status' })
    expect((screen.getByRole('button', { name: 'Want to read' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
  })

  it('clears the last act’s trouble when the next act starts, and keeps it otherwise', async () => {
    let fail = true
    const port = portWith(own(), false, { setStatus: vi.fn(() => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve())) })
    draw(port)
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    await screen.findByText(/That did not save\. disk full/u)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Finished' }))
    await waitFor(() => expect(screen.queryByText(/That did not save/u)).toBeNull())
  })

  it('does not report, refresh or unbusy for an act begun on the previous book', async () => {
    const pending = deferred<void>()
    let reads = 0
    const port = portWith(own(), false, {
      own: () => {
        reads += 1
        return Promise.resolve(own())
      },
      setStatus: vi.fn(() => pending.promise),
    })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    expect((screen.getByRole('button', { name: 'Reading' }) as HTMLButtonElement).disabled).toBe(true)
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reading' }) as HTMLButtonElement).disabled).toBe(false))
    const before = reads
    pending.reject(new Error('the first book would not save'))
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/the first book would not save/u)).toBeNull()
    expect(reads).toBe(before)
    expect((screen.getByRole('button', { name: 'Reading' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('lets a newer lists answer stand when an older read lands after it, and clears its trouble', async () => {
    const first = deferred<OwnListView[]>()
    let calls = 0
    let tell: (() => void) | null = null
    const lists: ListsPort = {
      lists: () => (++calls === 1 ? first.promise : Promise.resolve([{ id: 'l2', title: 'Newer', items: [] }])),
      create: () => Promise.resolve('x'),
      retitle: () => Promise.resolve(),
      place: () => Promise.resolve(),
      takeOff: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      subscribe: (listener: () => void) => {
        tell = listener
        return () => {}
      },
    } as unknown as ListsPort
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await screen.findByRole('group', { name: 'Reading status' })
    tell!()
    await screen.findByText('Newer')
    first.resolve([{ id: 'l1', title: 'Older', items: [] }])
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText('Older')).toBeNull()
    expect(screen.getByText('Newer')).toBeTruthy()
  })
})

describe('a read that failed for the previous book', () => {
  it('is not shown against the next one', async () => {
    const port = portWith(own(), false, { own: (bookId) => (bookId === 'book:moby' ? Promise.reject(new Error('moby will not read')) : Promise.resolve(own())) })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    await screen.findByText(/moby will not read/u)
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    await screen.findByRole('group', { name: 'Reading status' })
    expect(screen.queryByText(/moby will not read/u)).toBeNull()
  })
})

describe('a list that could not be started', () => {
  it('keeps the typed title beside the failure line', async () => {
    const lists = {
      lists: () => Promise.resolve([]),
      create: () => Promise.reject(new Error('no identity to publish as')),
      retitle: () => Promise.resolve(),
      place: () => Promise.resolve(),
      takeOff: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      subscribe: () => () => {},
    } as unknown as ListsPort
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    const field = (await screen.findByLabelText('New list')) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Whales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await screen.findByText(/no identity to publish as/u)
    expect(field.value).toBe('Whales')
  })
})

describe('the pane, held to the letter', () => {
  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }
  const listsOver = (over: Partial<ListsPort>): ListsPort =>
    ({
      lists: () => Promise.resolve([]),
      create: () => Promise.resolve('new1'),
      retitle: () => Promise.resolve(),
      place: () => Promise.resolve(),
      takeOff: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      subscribe: () => () => {},
      ...over,
    }) as unknown as ListsPort

  it('shows no failure of the previous book while the next one is still being read', async () => {
    const slow = deferred<OwnOpinion>()
    const port = portWith(own(), false, { own: (bookId) => (bookId === 'book:moby' ? Promise.reject(new Error('moby will not read')) : slow.promise) })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    await screen.findByText(/moby will not read/u)
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    await new Promise((done) => setTimeout(done, 0))
    expect(screen.queryByText(/moby will not read/u)).toBeNull()
    slow.resolve(own())
    await screen.findByRole('group', { name: 'Reading status' })
  })

  it('does not refresh the next book for an act of the previous one that succeeds late', async () => {
    const pending = deferred<void>()
    let reads = 0
    const port = portWith(own(), false, {
      own: () => {
        reads += 1
        return Promise.resolve(own())
      },
      setStatus: vi.fn(() => pending.promise),
    })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    await screen.findByRole('group', { name: 'Reading status' })
    const before = reads
    pending.resolve()
    await new Promise((done) => setTimeout(done, 0))
    expect(reads).toBe(before)
  })

  it('keeps the next book’s draft when the previous book’s review save lands late', async () => {
    const pending = deferred<void>()
    const port = portWith(own(), false, { setReview: vi.fn(() => pending.promise) })
    const view = render(<BookPane bookId="book:moby" port={port} circle={null} />)
    const box = (await screen.findByRole('textbox', { name: 'Review' })) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'about moby' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep review' }))
    view.rerender(<BookPane bookId="book:dune" port={port} circle={null} />)
    const next = (await screen.findByRole('textbox', { name: 'Review' })) as HTMLTextAreaElement
    fireEvent.change(next, { target: { value: 'about dune' } })
    pending.resolve()
    await new Promise((done) => setTimeout(done, 0))
    expect((screen.getByRole('textbox', { name: 'Review' }) as HTMLTextAreaElement).value).toBe('about dune')
  })

  it('keeps what was typed after the save was asked for, when the save lands late', async () => {
    const pending = deferred<void>()
    const port = portWith(own(), false, { setReview: vi.fn(() => pending.promise) })
    render(<BookPane bookId="book:moby" port={port} circle={null} />)
    const box = (await screen.findByRole('textbox', { name: 'Review' })) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'about moby' } })
    fireEvent.click(screen.getByRole('button', { name: 'Keep review' }))
    fireEvent.change(box, { target: { value: 'about moby, and more' } })
    pending.resolve()
    await new Promise((done) => setTimeout(done, 0))
    expect((screen.getByRole('textbox', { name: 'Review' }) as HTMLTextAreaElement).value).toBe('about moby, and more')
  })

  it('re-enables the controls once an act on the same book has landed', async () => {
    const pending = deferred<void>()
    const port = portWith(own(), false, { setPublishing: vi.fn(() => pending.promise), publishing: vi.fn(() => Promise.resolve(false)) })
    render(<BookPane bookId="book:moby" port={port} circle={null} />)
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement
    fireEvent.click(box)
    expect(box.disabled).toBe(true)
    pending.resolve()
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false))
    /* And the pane read its opinion again once the act landed: the switch it shows is the store's, not the click's. */
    await waitFor(() => expect(port.publishing).toHaveBeenCalledTimes(2))
  })

  it('does not let an older lists read land over a newer one', async () => {
    const late = deferred<readonly OwnListView[]>()
    let asked = 0
    let tell: (() => void) | null = null
    const lists = listsOver({
      lists: vi.fn(() => (++asked === 1 ? late.promise : Promise.resolve([{ id: 'bb22', title: 'Dune reading', items: [] } as unknown as OwnListView]))),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await waitFor(() => expect(tell).not.toBeNull())
    /* The lists say something changed while the first read is still out: the second read lands first. */
    tell!()
    await screen.findByRole('button', { name: 'Put this book on Dune reading' })
    await act(async () => {
      late.resolve([{ id: 'aa11', title: 'Sea books', items: [] } as unknown as OwnListView])
      await late.promise
    })
    expect(screen.queryByRole('button', { name: 'Put this book on Sea books' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Put this book on Dune reading' })).not.toBeNull()
  })

  it('does not let an older lists read that FAILS late put its trouble over a newer one that landed', async () => {
    let fail: (cause: unknown) => void = () => {}
    const late = new Promise<readonly OwnListView[]>((_, no) => {
      fail = no
    })
    let asked = 0
    let tell: (() => void) | null = null
    const lists = listsOver({
      lists: vi.fn(() => (++asked === 1 ? late : Promise.resolve([{ id: 'bb22', title: 'Dune reading', items: [] } as unknown as OwnListView]))),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    await waitFor(() => expect(tell).not.toBeNull())
    tell!()
    await screen.findByRole('button', { name: 'Put this book on Dune reading' })
    await act(async () => {
      fail(new Error('the old read fell over'))
      await late.catch(() => {})
    })
    expect(screen.queryByText(/could not read your lists/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Put this book on Dune reading' })).not.toBeNull()
  })

  it('draws no lists trouble line when the lists read fine', async () => {
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={listsOver({})} />)
    await screen.findByLabelText('New list')
    expect(screen.queryByText(/could not read your lists/u)).toBeNull()
  })

  it('does not place the next book on a list created for the previous one, and starts a fresh list each time', async () => {
    const created = deferred<string>()
    const create = vi.fn(() => created.promise)
    const place = vi.fn(() => Promise.resolve())
    const lists = listsOver({ create, place })
    const view = render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    const field = (await screen.findByLabelText('New list')) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Whales' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    view.rerender(<BookPane bookId="book:dune" port={portWith()} circle={null} lists={lists} />)
    await screen.findByLabelText('New list')
    created.resolve('l-late')
    await new Promise((done) => setTimeout(done, 0))
    expect(place).not.toHaveBeenCalled()
    cleanup()
    const quickCreate = vi.fn(() => Promise.resolve('l1'))
    const quickPlace = vi.fn(() => Promise.resolve())
    render(<BookPane bookId="book:x" port={portWith()} circle={null} lists={listsOver({ create: quickCreate, place: quickPlace })} />)
    const box = (await screen.findByLabelText('New list')) as HTMLInputElement
    fireEvent.change(box, { target: { value: 'One' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(quickPlace).toHaveBeenCalledTimes(1))
    fireEvent.change(box, { target: { value: 'Two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start list' }))
    await waitFor(() => expect(quickCreate).toHaveBeenCalledTimes(2))
  })
})

describe('an act begun through a port the pane no longer holds', () => {
  it('does not refresh through the old port after the new one’s read', async () => {
    /* ⚠️ The capability restarted while the act was out: its refresh, bound
       to the old port, landed after the new port's read and handed the new
       run the old one's state. */
    let finish: (() => void) | null = null
    const first = portWith(own({ status: 'reading' }), false, {
      setStatus: vi.fn(() => new Promise<void>((done) => { finish = done })),
    })
    const firstOwn = vi.spyOn(first, 'own')
    const view = draw(first)
    fireEvent.click(await screen.findByRole('button', { name: 'Finished' }))
    await waitFor(() => expect(first.setStatus).toHaveBeenCalled())
    expect(firstOwn).toHaveBeenCalledTimes(1)
    const second = portWith(own({ status: 'finished' }))
    view.rerender(<BookPane bookId="book:moby" port={second} circle={null} />)
    await screen.findByRole('button', { name: 'Finished' })
    finish!()
    await new Promise((done) => setTimeout(done, 0))
    /* The old port was read once, at mount, and never again. */
    expect(firstOwn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Finished' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the three sections act on their own — WI-23.B4, held apart', () => {
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
  const deserts: OwnListView = { id: 'bb', title: 'Deserts', items: [] }
  const deferred = <T,>() => {
    let resolve: (value: T) => void = () => {}
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  it('says a list that would not take the book beside the lists, and leaves the stars and the switch usable', async () => {
    /* ⚠️ One trouble line and one `busy` for the whole pane: a list that
       would not write was reported over the stars, and disabled them. */
    const lists = listsWith([deserts], { place: () => Promise.reject(new Error('the list would not write')) })
    render(<BookPane bookId="book:moby" port={portWith()} circle={null} lists={lists} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Put this book on Deserts' }))
    await screen.findByText(/That did not save\. the list would not write/u)
    expect(document.querySelector('[data-own-lists]')!.textContent).toContain('the list would not write')
    expect(screen.getByRole('group', { name: 'Reading status' }).parentElement!.textContent).not.toContain('did not save')
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Reading' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('holds only the opinion while a status is being written: the lists stay usable', async () => {
    const pending = deferred<void>()
    const port = portWith(own(), false, { setStatus: vi.fn(() => pending.promise) })
    render(<BookPane bookId="book:moby" port={port} circle={null} lists={listsWith([deserts])} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reading' }))
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true))
    expect((screen.getByRole('button', { name: 'Put this book on Deserts' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('New list') as HTMLInputElement).disabled).toBe(false)
    pending.resolve()
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false))
  })

  it('says an opinion that would not save beside the opinion, and leaves the lists usable', async () => {
    render(<BookPane bookId="book:moby" port={portWith(own(), false, { setStars: () => Promise.reject(new Error('disk full')) })} circle={null} lists={listsWith([deserts])} />)
    fireEvent.click(await screen.findByRole('button', { name: '4 stars' }))
    await screen.findByText(/That did not save\. disk full/u)
    expect(document.querySelector('[data-own-lists]')!.textContent).not.toContain('disk full')
    expect((screen.getByRole('button', { name: 'Put this book on Deserts' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
